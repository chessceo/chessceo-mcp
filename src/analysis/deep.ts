// deep_analyse: async background job for a SINGLE long Stockfish think
// on ONE position (up to 5 min movetime). Same start / status / cancel
// shape as auto_evaluate, but different intent — the point is to free
// the tool response path from a 5-minute wait AND to keep the Lc0 slot
// free on the combo so the LLM can keep calling
// `cloud_analyse({engines: ["lc0"]})` for other positions while the
// deep SF think runs.
//
// Concretely: the job fires an unawaited authedRequest to the backend
// with engines=["stockfish"] + long movetime; the backend's per-engine
// semaphore lets that hold only the SF slot for the duration. The
// MCP-side promise resolves when the long HTTP call returns (nginx
// proxy_read_timeout is bumped to 420s on /api/agent/ to cover 5-min
// movetime + engine bestmove grace).
//
// Extracted from index.ts in v0.44 as part of the file split.

import { authedRequest } from "../http.js";
import { analysisToStoredEval, convertCloudSnapshotResponse } from "./response.js";
import {
  resolveFromNodeOrFen,
  storeEvalOnNode,
  type FileHandle,
} from "./file_handle.js";

type Args = Record<string, unknown>;

type DeepJobStatus = "running" | "done" | "cancelled" | "error";

type DeepJob = {
  id: string;
  status: DeepJobStatus;
  fileHandle?: FileHandle; // set when file_id+node_id was supplied
  fen: string;
  movetimeMs: number;
  multipv: number;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
  cancelController: AbortController;
};

const deepJobs = new Map<string, DeepJob>();
const DEEP_JOB_TTL_MS = 15 * 60 * 1000;

function newDeepJobId(): string {
  const rand = Math.random().toString(16).slice(2, 8);
  return `deep_${Date.now().toString(16)}${rand}`;
}

function reapExpiredDeepJobs(): void {
  const now = Date.now();
  for (const [k, j] of deepJobs) {
    if (j.finishedAt && now - j.finishedAt > DEEP_JOB_TTL_MS) {
      deepJobs.delete(k);
    }
  }
}

export async function deepAnalyseStart(args: Args): Promise<unknown> {
  reapExpiredDeepJobs();
  const resolved = await resolveFromNodeOrFen(args);
  const fen = resolved.fen;
  const movetimeMs = typeof args.movetime_ms === "number" ? args.movetime_ms : 60_000;
  // Default 2 — SF loses meaningful strength at higher multipv, so a
  // deep think is best spent on a tight candidate list. Matches the
  // cloud_analyse stockfish_multipv default.
  const multipv = typeof args.multipv === "number" ? args.multipv : 2;

  const jobId = newDeepJobId();
  const job: DeepJob = {
    id: jobId,
    status: "running",
    fileHandle: resolved.file,
    fen,
    movetimeMs,
    multipv,
    startedAt: Date.now(),
    cancelController: new AbortController(),
  };
  deepJobs.set(jobId, job);

  // Kick off the long HTTP call unawaited — resolves when the backend
  // returns the SF snapshot. authedRequest is a plain fetch under the
  // hood; abort signal flows via cancelController.
  void runDeepJob(job).catch(err => {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });

  return {
    job_id: jobId,
    status: "running",
    movetime_ms: movetimeMs,
    fen,
  };
}

async function runDeepJob(job: DeepJob): Promise<void> {
  const body = {
    fen: job.fen,
    movetime_ms: job.movetimeMs,
    stockfish_multipv: job.multipv,
    engines: ["stockfish"],
  };
  let raw: unknown;
  try {
    // TODO(future): plumb an AbortSignal through authedRequest for
    // real mid-flight cancellation. For now, cancel just marks the
    // job so the caller stops polling; the backend still runs the
    // engine to completion and the result is stored on the job
    // record but flagged cancelled.
    raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse", body);
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    return;
  }

  const converted = convertCloudSnapshotResponse(raw, job.fen) as {
    stockfish?: unknown;
  };
  const sf = converted.stockfish;

  if (job.cancelController.signal.aborted) {
    job.status = "cancelled";
  } else {
    job.status = "done";
  }
  job.result = sf ?? null;
  job.finishedAt = Date.now();

  // Same node-persistence as cloud_analyse: if the caller anchored on
  // file_id+node_id, store the SF-only eval as the node's ceoEval so
  // quote_engine_eval can cite it later. We build a StoredEval that has
  // only the sf leg — no Lc0 was run.
  if (job.fileHandle && sf) {
    const ev = analysisToStoredEval({ stockfish: sf });
    if (ev) {
      try {
        await storeEvalOnNode(job.fileHandle, ev);
      } catch {
        // best-effort — the analysis result is what the LLM asked for
      }
    }
  }
}

export function deepAnalyseStatus(args: Args): unknown {
  reapExpiredDeepJobs();
  const jobId = String(args.job_id || "").trim();
  if (!jobId) throw new Error("`job_id` is required");
  const job = deepJobs.get(jobId);
  if (!job) {
    return {
      status: "not_found",
      note: "Job unknown — expired (kept ~15 min after completion), never existed, or the MCP process restarted.",
    };
  }
  return {
    job_id: job.id,
    status: job.status,
    movetime_ms: job.movetimeMs,
    elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    fen: job.fen,
    result: job.result,
    error: job.error,
    started_at_ms: job.startedAt,
    finished_at_ms: job.finishedAt,
  };
}

export function deepAnalyseCancel(args: Args): unknown {
  const jobId = String(args.job_id || "").trim();
  if (!jobId) throw new Error("`job_id` is required");
  const job = deepJobs.get(jobId);
  if (!job) return { status: "not_found" };
  if (job.status !== "running") {
    return { status: job.status, note: "Job already finished; nothing to cancel." };
  }
  job.cancelController.abort();
  // Status flips to "cancelled" when runDeepJob observes the abort on
  // completion. Backend keeps churning until movetime elapses (mid-
  // flight abort of the HTTP call is a follow-up).
  return { status: "cancelling", elapsed_ms: Date.now() - job.startedAt };
}
