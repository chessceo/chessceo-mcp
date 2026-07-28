// auto_evaluate: async background job that walks a prep-file subtree and
// stores an engine eval on every node via cloud_analyse. Kept as its own
// module in v0.44 (was 300 LOC in the middle of src/index.ts) — the job
// lifecycle (start, run, status, cancel) is one self-contained unit.
//
// The naive walk-and-await approach held one HTTP request open for the
// full duration of the walk (200 nodes × ~1.5s serialized on the
// per-combo engine semaphore = ~5 min). MCP hosts vary in their
// tolerance for that. Switched to a background-job model:
//
//   1. `auto_evaluate` collects targets, spawns an unawaited worker,
//      returns `{ job_id, target_count }` immediately.
//   2. `auto_evaluate_status(job_id)` returns live progress; the LLM
//      can poll while doing other work on the tree.
//   3. `auto_evaluate_cancel(job_id)` aborts a running job cleanly;
//      partial progress up to the last checkpoint is preserved.
//
// The MCP server is long-lived (chessceo-mcp.service under systemd), so
// in-memory job state survives across HTTP requests. On process restart
// jobs disappear — polling returns `not_found` and the LLM re-runs (the
// `only_missing` default naturally skips already-evaluated nodes).
//
// Progress is checkpointed to the prep file every SAVE_EVERY_N nodes so
// a mid-run crash / cancellation doesn't lose the whole walk.

import { authedRequest, fetchGame } from "../http.js";
import { analysisToStoredEval } from "./response.js";
import { parsePGN } from "../pgn/parser.js";
import { buildIdIndex, positionKey, resolveNodeId, ROOT_ID } from "../pgn/paths.js";
import type { PrepNode, StoredEval } from "../pgn/types.js";

type Args = Record<string, unknown>;

type EvalJobStatus = "running" | "done" | "error" | "cancelled";

type EvalJob = {
  id: string;
  fileId: string;
  status: EvalJobStatus;
  targetCount: number;
  evaluated: number;
  errored: number;              // nodes where cloud_analyse threw — kept going
  failedNodeIds: string[];      // exact node_ids that failed; ready for targeted retry
  error?: string;               // fatal error that terminated the job
  abortedReason?: string;       // e.g. "engine died — 3 consecutive failures"
  finalVersion?: number;
  startedAt: number;
  finishedAt?: number;
  cancelled: boolean;
};

const evalJobs = new Map<string, EvalJob>();

// GC finished jobs after this long so status polling remains useful
// for a while but the map doesn't grow unbounded across long uptimes.
const EVAL_JOB_TTL_MS = 15 * 60 * 1000;
// Checkpoint interval — save progress every N successfully-evaluated
// nodes so a mid-run kill leaves the tree partially populated. Small
// enough that <15s of work is at risk per checkpoint on a slow combo,
// large enough that the save overhead stays a small fraction of the
// per-node cost.
const SAVE_EVERY_N = 8;

// Callback into the batch-mutation applier — passed in from index.ts to
// avoid a circular dependency with the mutation module. runEvalJob only
// needs the "load, apply N ops, save, return {version}" contract.
type BatchApplier = (args: Args) => Promise<unknown>;

function newEvalJobId(): string {
  // 12 hex chars, low collision (same 32-bit width as node ids ×1.5).
  const rand = Math.random().toString(16).slice(2, 8);
  return `evj_${Date.now().toString(16)}${rand}`;
}

// Sweep expired jobs on every start/status call — cheap, doesn't need
// a background timer, keeps the map bounded to active + recent jobs.
function reapExpiredEvalJobs(): void {
  const now = Date.now();
  for (const [k, j] of evalJobs) {
    if (j.finishedAt && now - j.finishedAt > EVAL_JOB_TTL_MS) {
      evalJobs.delete(k);
    }
  }
}

// Path->node helper duplicated here so auto.ts doesn't depend on index.ts.
// Same body as index.ts:getNodeByPath.
function getNodeByPath(root: PrepNode, path: number[]): PrepNode {
  let cur = root;
  for (const idx of path) {
    if (idx < 0 || idx >= cur.children.length) throw new Error(`invalid node path segment ${idx}`);
    cur = cur.children[idx];
  }
  return cur;
}

export async function autoEvaluate(args: Args, applyBatchMutations: BatchApplier): Promise<unknown> {
  reapExpiredEvalJobs();
  const id = String(args.id);
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0
    ? String(args.node_id)
    : ROOT_ID;
  const onlyMissing = args.only_missing !== false; // default true
  const movetimeMs = typeof args.movetime_ms === "number" ? args.movetime_ms : 1500;

  const g = await fetchGame(id);
  const file = parsePGN(g.pgnContent);
  const idIndex = buildIdIndex(file.root);
  const startPath = resolveNodeId(idIndex, startNodeId);

  // Collect eligible nodes (skip root — no move to evaluate). `onlyMissing`
  // gates on stored `ceoEval` (the raw persisted numbers), not on visible
  // NAGs — this tool never sets NAGs, so gating on NAGs would incorrectly
  // re-evaluate hand-annotated moves whose eval hasn't been stored yet.
  type Target = { nodeId: string; fen: string };
  const targets: Target[] = [];
  const walk = (node: PrepNode, isStartAndRoot: boolean) => {
    if (!isStartAndRoot) {
      if (!onlyMissing || !node.ceoEval) {
        targets.push({ nodeId: node.id, fen: node.fen });
      }
    }
    for (const child of node.children) walk(child, false);
  };
  const startNode = getNodeByPath(file.root, startPath);
  // If the caller anchored at the root, skip evaluating the root itself
  // (no move); otherwise the anchor node IS a real move and gets evaluated.
  walk(startNode, startNode.id === ROOT_ID);

  // Dedup transpositions: if two candidate targets share the same
  // 3-field FEN key, they're the same position reached by different
  // move orders. Analyse ONE of them — cloud_analyse auto-propagates
  // the resulting ceoEval to every other node with a matching key
  // (see storeEvalOnNode), so the twin ends up with the same eval
  // without a second engine call. Keep DFS-first (mainline-preferred)
  // occurrence.
  let skippedTranspositions = 0;
  {
    const seen = new Set<string>();
    const deduped: Target[] = [];
    for (const t of targets) {
      const key = positionKey(t.fen);
      if (seen.has(key)) { skippedTranspositions++; continue; }
      seen.add(key);
      deduped.push(t);
    }
    targets.length = 0;
    targets.push(...deduped);
  }

  // Nothing to do → return a done job synthetically so the caller doesn't
  // need to special-case the empty response.
  if (targets.length === 0) {
    const jobId = newEvalJobId();
    evalJobs.set(jobId, {
      id: jobId,
      fileId: id,
      status: "done",
      targetCount: 0,
      evaluated: 0,
      errored: 0,
      failedNodeIds: [],
      finalVersion: g.version,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      cancelled: false,
    });
    return { job_id: jobId, target_count: 0, status: "done", version: g.version };
  }

  const jobId = newEvalJobId();
  const job: EvalJob = {
    id: jobId,
    fileId: id,
    status: "running",
    targetCount: targets.length,
    evaluated: 0,
    errored: 0,
    failedNodeIds: [],
    startedAt: Date.now(),
    cancelled: false,
  };
  evalJobs.set(jobId, job);

  // Unawaited — runs concurrently with the tool response. Any thrown
  // error gets recorded on the job so the LLM's status poll surfaces
  // it instead of the process seeing an unhandled rejection.
  void runEvalJob(job, id, targets, movetimeMs, applyBatchMutations).catch(err => {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });

  return {
    job_id: jobId,
    target_count: targets.length,
    // Transpositions inside the walk that we skipped because they'll
    // pick up the eval via auto-propagation. Zero when there are none.
    skipped_transpositions: skippedTranspositions,
    status: "running",
    // Rough time estimate at the current default movetime. Serialization
    // on the per-combo semaphore means walltime ≈ target_count × movetime.
    estimated_seconds: Math.round((targets.length * movetimeMs) / 1000),
  };
}

// Worker body — walks targets sequentially (concurrency > 1 is a lie
// against the per-combo semaphore in the backend anyway), checkpoints
// every SAVE_EVERY_N successfully-evaluated nodes so partial progress
// is durable, and re-anchors the version after each save.
async function runEvalJob(
  job: EvalJob,
  fileId: string,
  targets: Array<{ nodeId: string; fen: string }>,
  movetimeMs: number,
  applyBatchMutations: BatchApplier,
): Promise<void> {
  const pending: Array<{ op: string; node_id: string; ceoEval?: StoredEval }> = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    // No expected_version — auto_evaluate treats concurrent edits by
    // the LLM as last-write-wins on the ceoEval field specifically.
    // Safe because set_ceo_eval is idempotent per node and other
    // mutations (add_move / set_comment / etc.) don't touch ceoEval.
    const saved = await applyBatchMutations({
      id: fileId,
      mutations: pending,
    } as Args);
    const sr = saved as { version?: number };
    if (typeof sr.version === "number") job.finalVersion = sr.version;
    pending.length = 0;
  };

  // Consecutive-failure abort. If N cloud_analyse calls in a row error,
  // the engine is almost certainly dead (vanished contract, network to
  // VastAI down) and burning through the rest of the tree just wastes
  // time. Bail with an explicit reason so a targeted retry is possible.
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  let aborted = false;

  for (const t of targets) {
    if (job.cancelled || aborted) break;
    try {
      const analysis = await authedRequest(
        "POST",
        "/api/agent/cloud-engines/analyse",
        { fen: t.fen, movetime_ms: movetimeMs, multipv: 1 },
      );
      const ev = analysisToStoredEval(analysis);
      if (ev) {
        pending.push({ op: "set_ceo_eval", node_id: t.nodeId, ceoEval: ev });
        job.evaluated++;
        consecutiveFailures = 0;
      } else {
        job.errored++;
        job.failedNodeIds.push(t.nodeId);
        consecutiveFailures++;
      }
    } catch {
      // Per-node failure — record the node_id so the caller can retry
      // just those, and count consecutive failures for the abort check.
      job.errored++;
      job.failedNodeIds.push(t.nodeId);
      consecutiveFailures++;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      aborted = true;
      job.abortedReason = `aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive cloud_analyse failures — check that the cloud combo is still running (list_cloud_engines)`;
      break;
    }
    if (pending.length >= SAVE_EVERY_N) {
      try {
        await flush();
      } catch {
        // Save failure is bad but not fatal — try again on the next
        // checkpoint or at the end. Progress remains in `pending`
        // so nothing is lost as long as the process stays alive.
      }
    }
  }

  // Final flush regardless of cancellation — durably persist whatever
  // work was completed before the user asked to stop.
  try {
    await flush();
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    job.status = "error";
    job.finishedAt = Date.now();
    return;
  }

  job.status = job.cancelled ? "cancelled" : "done";
  job.finishedAt = Date.now();
}

export function autoEvaluateStatus(args: Args): unknown {
  reapExpiredEvalJobs();
  const jobId = String(args.job_id || "").trim();
  if (!jobId) throw new Error("`job_id` is required");
  const job = evalJobs.get(jobId);
  if (!job) {
    return {
      status: "not_found",
      note: "Job unknown — either expired (kept ~15 min after completion), never existed, or the MCP process restarted since it was created. Re-run auto_evaluate to start over; the `only_missing` default will skip nodes already evaluated in the prep file.",
    };
  }
  return {
    job_id: job.id,
    status: job.status,
    target_count: job.targetCount,
    evaluated: job.evaluated,
    errored: job.errored,
    failed_node_ids: job.failedNodeIds,        // exact ids for targeted retry — pass as node_id list or check with list_nodes
    aborted_reason: job.abortedReason,          // present when the job stopped early due to consecutive engine failures
    remaining: Math.max(0, job.targetCount - job.evaluated - job.errored),
    done: job.status !== "running",
    error: job.error,
    version: job.finalVersion,
    started_at_ms: job.startedAt,
    finished_at_ms: job.finishedAt,
  };
}

export function autoEvaluateCancel(args: Args): unknown {
  const jobId = String(args.job_id || "").trim();
  if (!jobId) throw new Error("`job_id` is required");
  const job = evalJobs.get(jobId);
  if (!job) return { status: "not_found" };
  if (job.status !== "running") {
    return { status: job.status, note: "Job already finished; nothing to cancel." };
  }
  job.cancelled = true;
  // status transitions to "cancelled" on the next per-node iteration
  // inside runEvalJob, after the final flush persists progress.
  return { status: "cancelling", evaluated_so_far: job.evaluated };
}
