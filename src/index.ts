#!/usr/bin/env node
// chess.ceo MCP server. Exposes the public GET API as MCP tools so LLM
// hosts (Claude Desktop, Cursor, etc.) can look up players, positions,
// preparation stats, and live broadcast state directly.
//
// Everything here is a thin wrapper around https://chess.ceo/api/chess/*
// endpoints — see the public contract at https://chess.ceo/llms.txt.
// No API key, no auth, no state; the API's own rate limits apply.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Chess } from "chess.js";
import { parsePGN } from "./pgn/parser.js";
import { exportPGN } from "./pgn/exporter.js";
import { describePosition } from "./pgn/describe.js";
import {
  addLine,
  addMove,
  deleteSubtree,
  MutationError,
  promoteVariation,
  setAnnotations,
  setCeoEval,
  setCeoEvalMany,
  setComment,
  setNags,
  setTag,
} from "./pgn/mutations.js";
import { buildFenIndex, buildIdIndex, NodeIdError, PathError, positionKey, resolveNodeId, ROOT_ID } from "./pgn/paths.js";
import type {
  Path,
  PrepAnnotations,
  PrepArrow,
  PrepFile,
  PrepHighlight,
  PrepNode,
  StoredEngineEval,
  StoredEval,
} from "./pgn/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { PROMPTS } from "./prompts.js";
import {
  commentAntiPatterns,
  longLineWarning,
  noDescribeWarning,
  noStatsCheckWarning,
  positionsDescribed,
  positionsStatsChecked,
} from "./warnings.js";
import {
  authContext,
  authedRequest,
  createGame,
  deleteGame,
  fetchGame,
  get,
  makeFileId,
  PGN_BASE,
  restoreGame,
  saveGame,
  splitFileId,
  unwrap,
  type PgnGame,
} from "./http.js";

// Tools that require an MCP token — cloud engine + prep-file tools
// operate on the caller's own account so we can't service them
// anonymously. The streamable-http transport uses this list to decide
// whether to trigger the OAuth discovery flow via 401 + WWW-Authenticate
// before the SDK gets a chance to handle the call.
const AUTHED_TOOLS = new Set([
  "start_cloud_engine",
  "list_cloud_engines",
  "stop_cloud_engine",
  "cloud_analyse",
  "list_collections",
  "list_prep_files",
  "search_prep_files",
  "find_position_in_files",
  "read_prep_file",
  "list_nodes",
  "list_transpositions",
  "create_prep_file",
  "delete_prep_file",
  "restore_prep_file",
  "add_move",
  "add_line",
  "set_comment",
  "set_nags",
  "set_annotations",
  "delete_subtree",
  "promote_variation",
  "set_tag",
  "apply_mutations",
  "auto_evaluate",
  "auto_evaluate_status",
  "auto_evaluate_cancel",
  "deep_analyse",
  "deep_analyse_status",
  "deep_analyse_cancel",
  "find_position_in_courses",
  "read_course_at_position",
  "quote_engine_eval",
  "predict_human_move",
  "prepare_opponent",
  "get_prep_position",
  "list_prep_sessions",
  "delete_prep_session",
]);

function isAuthedToolCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { method?: unknown; params?: { name?: unknown } };
  if (b.method !== "tools/call") return false;
  const name = b.params?.name;
  return typeof name === "string" && AUTHED_TOOLS.has(name);
}


// The engine-usage guide ships in the package (see package.json "files").
// Loaded once at startup and returned verbatim by the engine_usage_primer
// prompt — LLM hosts surface it in their slash menu so a user can push the
// full doc into the conversation on demand.
function loadBundledDoc(filename: string, fallbackLabel: string): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../docs/*.md when packaged; src/index.ts →
    // ../docs/*.md during dev. Same resolution either way.
    return readFileSync(join(here, "..", "docs", filename), "utf8");
  } catch {
    return `${fallbackLabel} not bundled with this install of @chessceo/mcp.`;
  }
}

const ENGINE_USAGE_DOC = loadBundledDoc("engine-usage.md", "Engine usage guide");
const PREP_STRATEGY_DOC = loadBundledDoc("prep-strategy.md", "Prep strategy guide");
const PREP_FILES_DOC = loadBundledDoc("prep-files-guide.md", "Prep files guide");
const PGN_AUTHORING_DOC = loadBundledDoc("pgn-authoring.md", "PGN authoring guide");

// Reference PGNs authored by a strong human coach. LLM pulls these when
// it wants to see the commentary style, NAG discipline, and annotation
// density we want it to hit. Kept as raw PGN so the LLM can parse them
// against its own understanding of the game (comments, arrows, NAGs
// all intact) — not summarised into English.
const EXAMPLE_OVERVIEW_PGN = loadBundledDoc("examples/italian-fried-liver.pgn", "Italian Fried Liver overview example");
const EXAMPLE_REPERTOIRE_PGN = loadBundledDoc("examples/najdorf-6-f4-white.pgn", "Najdorf 6.f4 White repertoire example");



// ── Handlers ───────────────────────────────────────────────────────

type Args = Record<string, unknown>;

// Log every tool call in and out. Keeps args + response payloads together
// with a per-call duration so we can trace what the LLM asked for and what
// it got back on the same journalctl line. Response is JSON-stringified and
// capped so the two doc-reading tools (~5-10 KB of static markdown each)
// don't drown the log stream.
const LOG_MAX_CHARS = 4096;

// Convert a UCI move sequence into SAN by walking it move-by-move on
// chess.js from the given starting FEN. LLMs reason far better in SAN
// ("Nf3", "Bxc4") than UCI ("g1f3", "b5c4"), and matches how prep
// discussion is written in the real world. If a move fails to parse
// (illegal from the current position — bug or truncated PV), we
// truncate cleanly rather than throwing so the response still carries
// what we could convert.
function uciLineToSAN(startFen: string, uciMoves: string[]): string[] {
  const board = new Chess(startFen);
  const out: string[] = [];
  for (const uci of uciMoves) {
    if (uci.length < 4) break;
    try {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length >= 5 ? uci[4] : undefined,
      });
      if (!move) break;
      out.push(move.san);
    } catch {
      break;
    }
  }
  return out;
}

function uciMoveToSAN(startFen: string, uci: string): string {
  if (!uci || uci.length < 4) return uci;
  const board = new Chess(startFen);
  try {
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length >= 5 ? uci[4] : undefined,
    });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

// Fetch a compact cloud eval for `fen`. Returns null on any error — no
// running combo instance, engine failure, network timeout. Callers
// attach the result to their response as `.eval` so the LLM has the
// stockfish + lc0 read without a separate tool call.
type CompactEval = {
  nag: string | null;
  stockfish?: { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
  lc0?:       { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
};

async function fetchCompactEval(fen: string): Promise<CompactEval | null> {
  try {
    const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse",
      { fen, movetime_ms: 1500, multipv: 1 });
    const converted = convertCloudSnapshotResponse(raw, fen);
    const stored = analysisToStoredEval(converted);
    return storedEvalToCompact(stored, converted);
  } catch {
    return null;
  }
}


// Trim every PV in a converted cloud-analyse response to `maxPlies`
// and mark each trimmed line with `pv_truncated: true` so the LLM
// sees what happened. Applied ONLY to cloud_analyse (short synchronous
// snapshot); deep_analyse is the explicit "give me the deep line"
// tool and keeps its full PV.
function capPvsInResponse(converted: unknown, maxPlies: number): void {
  if (!converted || typeof converted !== "object") return;
  const r = converted as { stockfish?: EngineBlock; lc0?: EngineBlock };
  for (const eng of [r.stockfish, r.lc0]) {
    if (!eng || !Array.isArray(eng.lines)) continue;
    for (const line of eng.lines) {
      if (Array.isArray(line.pv) && line.pv.length > maxPlies) {
        line.pv = line.pv.slice(0, maxPlies);
        (line as { pv_truncated?: boolean }).pv_truncated = true;
      }
    }
  }
  (converted as { pv_max_plies?: number }).pv_max_plies = maxPlies;
}

function convertCloudSnapshotResponse(raw: unknown, startFen: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { stockfish?: EngineBlock; lc0?: EngineBlock };
  for (const eng of [r.stockfish, r.lc0]) {
    if (!eng) continue;
    if (Array.isArray(eng.lines)) {
      for (const line of eng.lines) {
        if (Array.isArray(line.pv)) line.pv = uciLineToSAN(startFen, line.pv);
      }
    }
    if (typeof eng.bestMove === "string") eng.bestMove = uciMoveToSAN(startFen, eng.bestMove);
  }
  return raw;
}

type EngineBlock = {
  lines?: Array<{ pv?: string[] }>;
  bestMove?: string;
};

// Extract a node id from the args. Accepts either `node_id` or a
// `parent_id` alias for the add-style tools. Throws with a helpful
// message if malformed.
function argNodeId(args: Args, key: "node_id" | "parent_id" = "node_id"): string {
  const raw = args[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`\`${key}\` is required (call read_prep_file to get valid node ids)`);
  }
  return raw.trim();
}

// Dispatch table for the batch tool: name → mutator that returns
// { file, id } where id is the node the mutation touched. The batch
// caller rebuilds the id → path index between ops so newly-created
// nodes are addressable within the same batch.
function dispatchMutation(
  file: PrepFile,
  idIndex: Map<string, Path>,
  op: Record<string, unknown>,
): { file: PrepFile; id: string; results?: Array<{ id: string; san: string }> } {
  const kind = String(op.op);
  // Small local helper — resolves a node_id (or parent_id) op field to
  // a path against the CURRENT tree state.
  const nodeIdField = (key: "node_id" | "parent_id"): string => {
    const raw = op[key];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`\`${key}\` required on op ${kind}`);
    }
    return raw.trim();
  };
  const resolve = (id: string): Path => resolveNodeId(idIndex, id);
  switch (kind) {
    case "add_move": {
      const parentPath = resolve(nodeIdField("parent_id"));
      const parent = getNodeByPath(file.root, parentPath);
      const noStatsWarn = noStatsCheckWarning(parent);
      const step = addMove(file, parentPath, String(op.san));
      return { ...step, ...(noStatsWarn ? { warning: noStatsWarn } : {}) };
    }
    case "add_line": {
      const sans = Array.isArray(op.sans) ? (op.sans as unknown[]).map(String) : [];
      const parentPath = resolve(nodeIdField("parent_id"));
      const parent = getNodeByPath(file.root, parentPath);
      const step = addLine(file, parentPath, sans);
      const lastId = step.line.length > 0 ? step.line[step.line.length - 1].id : nodeIdField("parent_id");
      // Same anti-pattern warnings as the standalone add_line case —
      // long unbranched line + no-stats-check parent are both bugs
      // whether they land solo or inside a batch.
      const longLineWarn = longLineWarning(sans.length);
      const noStatsWarn = noStatsCheckWarning(parent);
      const warnings = [longLineWarn, noStatsWarn].filter((s): s is string => !!s);
      return { file: step.file, id: lastId, results: step.line, ...(warnings.length > 0 ? { warnings } : {}) };
    }
    case "set_comment": {
      const commentStr = typeof op.comment === "string" ? op.comment : "";
      const commentWarns = commentAntiPatterns(commentStr);
      const targetPath = resolve(nodeIdField("node_id"));
      const targetNode = getNodeByPath(file.root, targetPath);
      const describeWarn = noDescribeWarning(targetNode, commentStr);
      const step = setComment(file, targetPath, commentStr);
      const all = [...commentWarns, ...(describeWarn ? [describeWarn] : [])];
      return { ...step, ...(all.length > 0 ? { warnings: all } : {}) };
    }
    case "set_nags":
      return setNags(file, resolve(nodeIdField("node_id")), Array.isArray(op.nags) ? (op.nags as unknown[]).map(String) : []);
    case "set_annotations": {
      const arrows = Array.isArray(op.arrows) ? (op.arrows as PrepArrow[]) : [];
      const highlights = Array.isArray(op.highlights) ? (op.highlights as PrepHighlight[]) : [];
      const ann: PrepAnnotations | null =
        arrows.length === 0 && highlights.length === 0 ? null : { arrows, highlights };
      return setAnnotations(file, resolve(nodeIdField("node_id")), ann);
    }
    case "set_ceo_eval": {
      const ev = op.ceoEval as StoredEval | null | undefined;
      return setCeoEval(file, resolve(nodeIdField("node_id")), ev ?? null);
    }
    case "delete_subtree":
      return deleteSubtree(file, resolve(nodeIdField("node_id")));
    case "promote_variation":
      return promoteVariation(file, resolve(nodeIdField("node_id")));
    case "set_tag":
      return { file: setTag(file, String(op.key), String(op.value ?? "")), id: ROOT_ID };
    default:
      throw new Error(`unknown mutation op: ${kind}`);
  }
}

// Batch: load, parse, apply N mutations in order, export, save.
// All-or-nothing — any error aborts and nothing is saved. The id index
// is rebuilt after each op so nodes created earlier in the batch can be
// addressed by later ops via their newly-derived node_id.
async function applyBatchMutations(args: Args): Promise<unknown> {
  const id = String(args.id);
  const mutations = Array.isArray(args.mutations) ? args.mutations : [];
  if (mutations.length === 0) throw new Error("mutations array required");

  const g = await fetchGame(id);

  let file = parsePGN(g.pgnContent);
  let idIndex = buildIdIndex(file.root);
  const results: Array<{ node_id: string; line?: unknown; warning?: string; warnings?: string[] }> = [];
  for (let i = 0; i < mutations.length; i++) {
    const op = mutations[i] as Record<string, unknown>;
    try {
      const step = dispatchMutation(file, idIndex, op) as { file: PrepFile; id: string; results?: unknown; warning?: string; warnings?: string[] };
      file = step.file;
      idIndex = buildIdIndex(file.root);
      results.push({
        node_id: step.id,
        ...(step.results !== undefined ? { line: step.results } : {}),
        ...(step.warning ? { warning: step.warning } : {}),
        ...(step.warnings && step.warnings.length > 0 ? { warnings: step.warnings } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`mutation #${i} (${String(op.op)}) failed: ${msg}`);
    }
  }
  const newPgn = exportPGN(file);
  const expected = typeof args.expected_version === "number" ? args.expected_version : g.version;
  const saved = await saveGame(id, newPgn, expected);
  return { ok: true, results, version: saved.version };
}

// Auto-evaluate: walk the tree from `path`, run cloud_analyse on each node,
// stash the compact per-engine eval in the node's `ceoEval` field (which
// survives across sessions and appears on every read_prep_file), and
// derive the NAG from the SF score. Both writes go via a single batch
// mutation at the end so a 200-node evaluate is one save.
// ── auto_evaluate: async background job ────────────────────────────
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
// a mid-run crash / cancellation doesn't lose the whole walk. Small
// tension with the version-lock — see runEvalJob comments for how we
// re-anchor the version between saves.

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

async function autoEvaluate(args: Args): Promise<unknown> {
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
  void runEvalJob(job, id, targets, movetimeMs).catch(err => {
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

function autoEvaluateStatus(args: Args): unknown {
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

function autoEvaluateCancel(args: Args): unknown {
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

// ── deep_analyse: async background job ─────────────────────────────
//
// Same shape as auto_evaluate — start returns a job_id immediately,
// poll via _status, cancel via _cancel — but for a SINGLE long
// Stockfish think on ONE position (up to 5 min movetime). The point
// is to free the tool response path from a 5-minute wait AND to keep
// the Lc0 slot free on the combo, so the LLM can keep calling
// `cloud_analyse({engines: ["lc0"]})` for other positions while the
// deep SF think runs.
//
// Concretely: the job fires an unawaited authedRequest to the backend
// with engines=["stockfish"] + long movetime; the backend's per-engine
// semaphore lets that hold only the SF slot for the duration. The
// MCP-side promise resolves when the long HTTP call returns (nginx
// proxy_read_timeout is bumped to 420s on /api/agent/ to cover 5-min
// movetime + engine bestmove grace).

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

async function deepAnalyseStart(args: Args): Promise<unknown> {
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

function deepAnalyseStatus(args: Args): unknown {
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

function deepAnalyseCancel(args: Args): unknown {
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

// ── find_position_in_courses: fenfind subprocess wrapper ───────────
//
// fenfind is a small python tool that indexes chess PGN files by
// polyglot Zobrist hash. Given a position it returns which of the
// user's Chessable / PGN files cover it, ranked by how much annotated
// material sits below that position in each course. Runs as a
// subprocess of the MCP so we can reuse python-chess's polyglot
// hashing (matching the pre-built positions.db) instead of porting
// the hash function to TS.
//
// Path resolution order (`FENFIND_PATH` env var overrides):
//   1. $FENFIND_PATH/fenfind
//   2. <package-root>/tools/fenfind/fenfind (ships with the npm package)
// The bash wrapper picks a python interpreter with python-chess
// available (venv at $here/.venv/bin/python preferred, then falls back
// to system python3). DB path is resolved inside fenfind.py itself
// (FENFIND_DB env, then ~/positions.db).
// Path resolution shared by both fenfind + readpgn. FENFIND_PATH env
// overrides the bundled tools/fenfind/ directory.
// Path to sf_eval helper (spawns local stockfish, parses its `eval`
// verbose output). Uses the same resolution pattern as FENFIND_DIR.
const SF_EVAL_SCRIPT: string | null = (() => {
  const envPath = process.env.SF_EVAL_PATH?.trim();
  if (envPath && existsSync(join(envPath, "sf_eval"))) return join(envPath, "sf_eval");
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "tools", "sf_eval", "sf_eval");
  return existsSync(bundled) ? bundled : null;
})();

const SF_EVAL_TIMEOUT_MS = 12_000;

async function runSfEval(fen: string): Promise<unknown> {
  if (!SF_EVAL_SCRIPT) {
    return {
      found: false,
      error: "sf_eval script not bundled; set SF_EVAL_PATH or install tools/sf_eval/",
    };
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    const p = spawn(SF_EVAL_SCRIPT!, ["--fen", fen], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => { out += d.toString("utf8"); });
    p.stderr.on("data", d => { err += d.toString("utf8"); });
    const to = setTimeout(() => {
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error(`sf_eval timed out after ${SF_EVAL_TIMEOUT_MS}ms`));
    }, SF_EVAL_TIMEOUT_MS);
    p.on("error", e => { clearTimeout(to); reject(e); });
    p.on("close", code => {
      clearTimeout(to);
      if (code !== 0) reject(new Error(`sf_eval exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
  });
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`sf_eval returned non-JSON output (${e instanceof Error ? e.message : String(e)}): ${stdout.slice(0, 300)}`);
  }
}

const FENFIND_DIR: string | null = (() => {
  const envPath = process.env.FENFIND_PATH?.trim();
  if (envPath && existsSync(join(envPath, "fenfind"))) return envPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "tools", "fenfind");
  return existsSync(join(bundled, "fenfind")) ? bundled : null;
})();

// Cap on how long we let the subprocess run. SQLite hash lookup returns
// sub-second; PGN read from a course file is O(chapter size) and rarely
// exceeds a second. 15s is a stuck-process backstop, not a real limit.
const FENFIND_TIMEOUT_MS = 15_000;

async function runFenfindScript(scriptName: "fenfind" | "readpgn", args: string[]): Promise<string> {
  if (!FENFIND_DIR) {
    throw new Error("fenfind index not installed — set FENFIND_PATH or install the tools/fenfind bundle");
  }
  const script = join(FENFIND_DIR, scriptName);
  return new Promise<string>((resolve, reject) => {
    const p = spawn(script, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => { out += d.toString("utf8"); });
    p.stderr.on("data", d => { err += d.toString("utf8"); });
    const to = setTimeout(() => {
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error(`${scriptName} timed out after ${FENFIND_TIMEOUT_MS}ms`));
    }, FENFIND_TIMEOUT_MS);
    p.on("error", e => { clearTimeout(to); reject(e); });
    p.on("close", code => {
      clearTimeout(to);
      if (code !== 0) reject(new Error(`${scriptName} exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
  });
}

function parseFenfindJson(scriptName: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`${scriptName} returned non-JSON output (${e instanceof Error ? e.message : String(e)}): ${stdout.slice(0, 300)}`);
  }
}

async function findPositionInCourses(args: Args): Promise<unknown> {
  if (!FENFIND_DIR) {
    return {
      status: "not_available",
      note: "fenfind index not installed on this server. Set FENFIND_PATH env var to the directory containing the `fenfind` script and positions.db, or install the tools/fenfind bundle shipped in the npm package.",
    };
  }

  const resolved = await resolveFromNodeOrFen(args);
  const cliArgs: string[] = [resolved.fen, "--json"];
  if (typeof args.sort === "string" && (args.sort === "recency" || args.sort === "notes")) {
    cliArgs.push("--sort", args.sort);
  }
  if (args.include_games) cliArgs.push("--games");
  if (args.chapters_mode) cliArgs.push("--chapters");
  if (typeof args.min_notes_chars === "number") cliArgs.push("--min", String(args.min_notes_chars));
  if (typeof args.limit === "number") cliArgs.push("-n", String(args.limit));

  const stdout = await runFenfindScript("fenfind", cliArgs);
  return parseFenfindJson("fenfind", stdout);
}

async function readCourseAtPosition(args: Args): Promise<unknown> {
  if (!FENFIND_DIR) {
    return {
      status: "not_available",
      note: "fenfind index not installed on this server. Set FENFIND_PATH env var to the directory containing the `fenfind`/`readpgn` scripts and positions.db.",
    };
  }
  const fileId = typeof args.course_file_id === "number" ? args.course_file_id : Number(args.course_file_id);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    throw new Error("`course_file_id` is required — pass the value from a find_position_in_courses hit");
  }
  const cliArgs: string[] = ["--file-id", String(fileId)];
  if (typeof args.fen === "string" && args.fen.trim() !== "") cliArgs.push("--fen", args.fen.trim());
  if (typeof args.moves === "string" && args.moves.trim() !== "") cliArgs.push("--moves", args.moves.trim());
  if (typeof args.chapter === "string" && args.chapter.trim() !== "") cliArgs.push("--chapter", args.chapter.trim());
  if (typeof args.max_plies_below === "number") cliArgs.push("--max-plies-below", String(args.max_plies_below));

  const stdout = await runFenfindScript("readpgn", cliArgs);
  return parseFenfindJson("readpgn", stdout);
}

// Walk chess.js-free: resolve a path against a tree, throw if invalid.
function pathIntoTree(root: PrepNode, path: Path): PrepNode {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    if (path[i] < 0 || path[i] >= cur.children.length) {
      throw new Error(`path segment ${i}=${path[i]} out of bounds`);
    }
    cur = cur.children[path[i]];
  }
  return cur;
}

// Read the cloud analyse response and build a StoredEval (compact form —
// no PVs, White-POV cp / mate, depth, and derived NAG). Returns null if
// there's no usable Stockfish signal (SF is the source of truth for
// the NAG per docs).
function analysisToStoredEval(analysis: unknown): StoredEval | null {
  if (!analysis || typeof analysis !== "object") return null;
  const r = analysis as {
    stockfish?: { depth?: number; lines?: Array<{ depth?: number; scoreCp?: number; mate?: number }> };
    lc0?:       { depth?: number; lines?: Array<{ depth?: number; scoreCp?: number; mate?: number }> };
  };
  // Backend returns White-POV cp/mate (engine-ws flips in ParseInfo
  // based on side-to-move, cloud_snapshot passes through). Pure
  // pass-through here — a previous sign-flip on black-to-move was
  // wrong and silently inverted every Black-to-move stored eval.

  const engineEval = (block: typeof r.stockfish): StoredEngineEval | undefined => {
    const line = block?.lines?.[0];
    if (!line) return undefined;
    const depth = line.depth ?? block?.depth;
    if (typeof line.mate === "number") return { mate: line.mate, depth };
    if (typeof line.scoreCp === "number") return { cp: line.scoreCp, depth };
    return undefined;
  };

  const sf = engineEval(r.stockfish);
  const lc0 = engineEval(r.lc0);
  if (!sf && !lc0) return null;

  const ev: StoredEval = {};
  if (sf) ev.sf = sf;
  if (lc0) ev.lc0 = lc0;
  ev.nag = nagFromCp(sf?.cp, sf?.mate) ?? nagFromCp(lc0?.cp, lc0?.mate) ?? undefined;
  return ev;
}

function nagFromCp(cp?: number, mate?: number): string | null {
  let effective: number;
  if (typeof mate === "number") effective = mate > 0 ? 10000 : -10000;
  else if (typeof cp === "number") effective = cp;
  else return null;
  const abs = Math.abs(effective);
  if (abs < 25) return "$10";
  if (abs < 60)  return effective > 0 ? "$14" : "$15";
  if (abs < 130) return effective > 0 ? "$16" : "$17";
  return effective > 0 ? "$18" : "$19";
}

// Adapter for the compact eval attached to live query responses. Same
// derivation logic; different output shape (needs the .nag + summary
// used by get_position_stats / prep_snapshot).
function storedEvalToCompact(ev: StoredEval | null, analysis: unknown): CompactEval | null {
  if (!ev) return null;
  const a = analysis as {
    stockfish?: { bestMove?: string; lines?: Array<{ pv?: string[] }> };
    lc0?:       { bestMove?: string; lines?: Array<{ pv?: string[] }> };
  };
  const compact: CompactEval = { nag: ev.nag ?? null };
  if (ev.sf) {
    compact.stockfish = {
      cp: ev.sf.cp,
      mate: ev.sf.mate,
      bestMove: a.stockfish?.bestMove,
      pv: a.stockfish?.lines?.[0]?.pv,
    };
  }
  if (ev.lc0) {
    compact.lc0 = {
      cp: ev.lc0.cp,
      mate: ev.lc0.mate,
      bestMove: a.lc0?.bestMove,
      pv: a.lc0?.lines?.[0]?.pv,
    };
  }
  return compact;
}

// Load-mutate-save: fetch current PGN, parse, apply mutation, re-export,
// save with optimistic lock. Auto-saves so every tool call is atomic;
// the LLM never sees intermediate state. The mutator is called with
// both the parsed file and its id → path index, so the mutation can
// resolve node_ids without rebuilding the index itself.
async function applyMutation(
  args: Args,
  mutator: (file: PrepFile, idIndex: Map<string, Path>) => { file: PrepFile; id: string; results?: unknown; warning?: string; warnings?: string[] },
): Promise<unknown> {
  const id = String(args.id);
  const g = await fetchGame(id);

  const file = parsePGN(g.pgnContent);
  const idIndex = buildIdIndex(file.root);
  let result: { file: PrepFile; id: string; results?: unknown; warning?: string; warnings?: string[] };
  try {
    result = mutator(file, idIndex);
  } catch (err) {
    if (err instanceof MutationError || err instanceof PathError || err instanceof NodeIdError) {
      throw new Error(`mutation rejected: ${err.message}`);
    }
    throw err;
  }
  const newPgn = exportPGN(result.file);

  const expected = typeof args.expected_version === "number" ? args.expected_version : g.version;
  const saved = await saveGame(id, newPgn, expected);
  return {
    ok: true,
    node_id: result.id,
    ...(result.results !== undefined ? { line: result.results } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    version: saved.version,
  };
}


// ── read_prep_file / list_nodes ────────────────────────────────────
//
// Split out of the case handler because both need the same load-parse
// pipeline and to keep the compact / spine / pgn views centralised.
// The whole point of these two tools: don't force the LLM to dump the
// entire tree when it wants a slice — a 500-node file can already
// exceed the context window in `full` view.

type ViewMode = "compact" | "full" | "spine" | "pgn";

async function loadPrepFile(id: string): Promise<{ file: PrepFile; version: number | undefined; fileIdEcho: string | undefined; pgn: string }> {
  const g = await fetchGame(id);
  // Echo the composite id back so read_prep_file responses match the
  // exact id the LLM passed in. The backend returns the raw game_id;
  // recompose so the LLM never sees the split form.
  return { file: parsePGN(g.pgnContent), version: g.version, fileIdEcho: id, pgn: g.pgnContent };
}

// Recursively project a PrepNode into the requested view. `depthLeft`
// null → unlimited; 0 → just the node without children.
//
// `fenIndex` (optional) enables the `transposes_to` field — for each
// node whose position also appears elsewhere in the SAME file, we
// annotate it with the OTHER occurrences' ids. Pass null (the default)
// to skip the annotation entirely; passing the map costs one lookup
// per node projected.
function projectNode(node: PrepNode, view: ViewMode, depthLeft: number | null, fenIndex: Map<string, PrepNode[]> | null = null): unknown {
  const base: Record<string, unknown> = {
    id: node.id,
    san: node.san,
    ply: node.ply,
  };
  if (node.nags && node.nags.length > 0) base.nags = node.nags;
  if (node.comment) base.comment = node.comment;
  if (node.ceoEval) base.ceoEval = node.ceoEval;
  if (view === "full") {
    base.fen = node.fen;
    if (node.annotations) base.annotations = node.annotations;
  }
  if (fenIndex && node.id !== ROOT_ID) {
    const group = fenIndex.get(positionKey(node.fen));
    if (group && group.length > 1) {
      const others = group.filter(n => n.id !== node.id).map(n => n.id);
      if (others.length > 0) base.transposes_to = others;
    }
  }
  // Children handling depends on view + depth budget.
  const showChildren = depthLeft === null || depthLeft > 0;
  const childDepth = depthLeft === null ? null : depthLeft - 1;
  if (showChildren && node.children.length > 0) {
    if (view === "spine") {
      // Only follow children[0] — collapses the tree to the mainline.
      base.children = [projectNode(node.children[0], view, childDepth, fenIndex)];
    } else {
      base.children = node.children.map(c => projectNode(c, view, childDepth, fenIndex));
    }
  } else {
    base.children = [];
  }
  return base;
}

// ── Collection + file listing handlers ─────────────────────────────
//
// v0.43: the LLM sees the user's full PGN library, not just a hidden
// `/mcp` folder. list_collections lets it discover collections;
// list_prep_files + search_prep_files + find_position_in_files return
// composite `<collection_id>:<game_id>` ids the mutation tools consume.

type PgnCollection = {
  id: string;
  title: string;
  icon?: string;
  folderPath?: string;
  gameCount?: number;
  positionSearchEnabled?: boolean;
  updatedAt?: string;
};
type PgnGameListRow = {
  id: string;
  collectionId?: string;
  collectionTitle?: string;
  event?: string;
  white_player?: string;
  black_player?: string;
  eco?: string;
  opening?: string;
  updated_at?: string;
  ply?: number;
};

async function listCollections(_args: Args): Promise<unknown> {
  const raw = await authedRequest("GET", PGN_BASE);
  const collections = unwrap<PgnCollection[]>(raw) ?? [];
  return {
    collections: collections.map(c => ({
      id: c.id,
      title: c.title,
      icon: c.icon,
      folder_path: c.folderPath,
      game_count: c.gameCount,
      position_search_enabled: c.positionSearchEnabled,
      updated_at: c.updatedAt,
    })),
  };
}

// Convert a browser-returned game list row into the LLM shape (composite
// id, cleaned field names).
function projectGameRow(row: PgnGameListRow): Record<string, unknown> {
  const collId = row.collectionId ?? "";
  return {
    id: collId ? makeFileId(collId, row.id) : row.id,
    collection_id: collId,
    collection_title: row.collectionTitle,
    event: row.event,
    white: row.white_player,
    black: row.black_player,
    eco: row.eco,
    opening: row.opening,
    updated_at: row.updated_at,
    ply: row.ply,
  };
}

async function listPrepFiles(args: Args): Promise<unknown> {
  const collectionId = typeof args.collection_id === "string" ? args.collection_id.trim() : "";
  if (!collectionId) {
    throw new Error(
      "collection_id required — call list_collections to see your options, or search across collections with search_prep_files / find_position_in_files",
    );
  }
  // Browser handler at GET /me/pgns/{id}/games returns a paginated list.
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games?page=1&limit=200`,
  );
  const data = unwrap<{ games?: PgnGameListRow[]; pagination?: unknown }>(raw);
  const games = data?.games ?? (Array.isArray(data) ? (data as PgnGameListRow[]) : []);
  return { collection_id: collectionId, prep_files: games.map(projectGameRow) };
}

async function searchPrepFiles(args: Args): Promise<unknown> {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (!q) throw new Error("query required");
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/games/search?q=${encodeURIComponent(q)}&limit=100`,
  );
  const data = unwrap<{ games?: PgnGameListRow[] }>(raw);
  const games = data?.games ?? [];
  return { query: q, prep_files: games.map(projectGameRow) };
}

async function findPositionInFiles(args: Args): Promise<unknown> {
  // FEN can come from a node handle OR a direct fen/moves/line. Reuse
  // the same resolver everything else uses.
  const resolved = await resolveFromNodeOrFen(args);
  const fen = resolved.fen;
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/games/search?position=${encodeURIComponent(fen)}&limit=100`,
  );
  const data = unwrap<{ games?: PgnGameListRow[] }>(raw);
  const games = data?.games ?? [];
  return {
    fen,
    match_count: games.length,
    prep_files: games.map(projectGameRow),
  };
}

async function createPrepFile(args: Args): Promise<unknown> {
  const collectionId = typeof args.collection_id === "string" ? args.collection_id.trim() : "";
  if (!collectionId) {
    throw new Error(
      "collection_id required — call list_collections to pick where the new file lives. There is no default landing folder any more (v0.43: the old hidden /mcp collection was removed).",
    );
  }
  const name = String(args.name || "").trim();
  if (!name) throw new Error("name is required");
  // Seed with a PGN carrying the LLM-chosen name as the Event tag so
  // subsequent list_prep_files calls display something useful.
  const seedPgn = `[Event "${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]\n\n*\n`;
  const game = await createGame(collectionId, seedPgn);
  return {
    ok: true,
    id: makeFileId(game.collectionId ?? collectionId, game.id),
    collection_id: game.collectionId ?? collectionId,
    version: game.version,
  };
}

async function readPrepFile(args: Args): Promise<unknown> {
  const id = String(args.id);
  const view: ViewMode = (typeof args.view === "string" && ["compact", "full", "spine", "pgn"].includes(args.view))
    ? args.view as ViewMode
    : "compact";
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0 ? args.node_id : ROOT_ID;
  const maxDepth: number | null = typeof args.max_depth === "number" && args.max_depth >= 0 ? args.max_depth : null;

  const { file, version, fileIdEcho, pgn } = await loadPrepFile(id);
  const idIndex = buildIdIndex(file.root);
  const path = resolveNodeId(idIndex, startNodeId);
  const anchor = getNodeByPath(file.root, path);
  const fenIndex = buildFenIndex(file.root);

  // How many DISTINCT positions in the file appear more than once,
  // and how many nodes are involved. Shown in the header so the LLM
  // sees at a glance whether transpositions matter here before diving
  // into the tree.
  let transGroups = 0;
  let transNodes = 0;
  for (const arr of fenIndex.values()) {
    if (arr.length > 1) { transGroups++; transNodes += arr.length; }
  }

  const header: Record<string, unknown> = {
    id: fileIdEcho ?? id,
    version,
    tags: file.tags,
    view,
    node_id: startNodeId,
    max_depth: maxDepth,
    transposition_groups: transGroups,
    transposition_nodes: transNodes,
  };

  if (view === "pgn") {
    // For the root, just return the file's actual PGN as-is. For a
    // subtree, build a mini-Game from the anchor and export it. Keeps
    // formatting identical to what the app renders.
    if (startNodeId === ROOT_ID && (maxDepth === null || maxDepth >= 999)) {
      return { ...header, pgn };
    }
    // Truncate to a subtree with max_depth. Simple: walk the anchor's
    // subtree, produce a synthetic PGN starting from the anchor's FEN.
    const subtreePgn = exportSubtreePgn(file, anchor, maxDepth);
    return { ...header, pgn: subtreePgn };
  }

  return { ...header, tree: projectNode(anchor, view, maxDepth, fenIndex) };
}

// Produce a PGN string for a subtree rooted at `anchor`, truncated
// at `maxDepth` plies below (null = unlimited). Reuses the exporter
// by building a synthetic PrepFile whose root is a shallow clone of
// the anchor with its children trimmed to depth.
function exportSubtreePgn(file: PrepFile, anchor: PrepNode, maxDepth: number | null): string {
  const trim = (n: PrepNode, depthLeft: number | null): PrepNode => {
    if (depthLeft !== null && depthLeft <= 0) return { ...n, children: [] };
    const next = depthLeft === null ? null : depthLeft - 1;
    return { ...n, children: n.children.map(c => trim(c, next)) };
  };
  const trimmedAnchor = trim(anchor, maxDepth);
  // If the anchor IS the root, exporter handles it. If it's an inner
  // node, we set the root's FEN to the anchor's position and hang the
  // trimmed subtree off it. Tags carried over.
  if (anchor.id === ROOT_ID) {
    return exportPGN({ tags: file.tags, root: trimmedAnchor });
  }
  const syntheticRoot: PrepNode = {
    id: ROOT_ID,
    san: null,
    fen: anchor.fen,
    ply: 0,
    children: trimmedAnchor.children,
  };
  const tags = { ...file.tags, FEN: anchor.fen, SetUp: "1" };
  return exportPGN({ tags, root: syntheticRoot });
}

async function listNodes(args: Args): Promise<unknown> {
  const id = String(args.id);
  const filter = String(args.filter || "");
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0 ? args.node_id : ROOT_ID;
  const maxDepth: number | null = typeof args.max_depth === "number" && args.max_depth >= 0 ? args.max_depth : null;

  const { file } = await loadPrepFile(id);
  const idIndex = buildIdIndex(file.root);
  const path = resolveNodeId(idIndex, startNodeId);
  const anchor = getNodeByPath(file.root, path);
  const fenIndex = filter === "transpositions" ? buildFenIndex(file.root) : null;

  type Hit = Record<string, unknown>;
  const hits: Hit[] = [];

  const walk = (node: PrepNode, depthLeft: number | null, spineOnly: boolean) => {
    // Root has no san — never emit it as a match. Everything else is fair game.
    if (node.id !== ROOT_ID) {
      let include = false;
      let extra: Record<string, unknown> = {};
      switch (filter) {
        case "missing_eval":
          include = !node.ceoEval; break;
        case "has_comment":
          include = !!(node.comment && node.comment.length > 0);
          if (include) extra.comment_preview = (node.comment || "").slice(0, 80);
          break;
        case "has_annotations":
          include = !!(node.annotations && (node.annotations.arrows.length > 0 || node.annotations.highlights.length > 0));
          break;
        case "novelties":
          include = !!(node.nags && node.nags.includes("$146"));
          break;
        case "leaves":
          include = node.children.length === 0; break;
        case "mainline":
          include = spineOnly; break;
        case "transpositions": {
          const group = fenIndex!.get(positionKey(node.fen));
          if (group && group.length > 1) {
            include = true;
            extra.transposes_to = group.filter(n => n.id !== node.id).map(n => n.id);
          }
          break;
        }
        case "all":
          include = true; break;
        default:
          throw new Error(`unknown filter: ${filter}`);
      }
      if (include) {
        const hit: Hit = { node_id: node.id, san: node.san, ply: node.ply };
        Object.assign(hit, extra);
        hits.push(hit);
      }
    }
    if (depthLeft !== null && depthLeft <= 0) return;
    const nextDepth = depthLeft === null ? null : depthLeft - 1;
    if (filter === "mainline" && spineOnly) {
      if (node.children.length > 0) walk(node.children[0], nextDepth, true);
    } else {
      for (const c of node.children) walk(c, nextDepth, filter === "mainline");
    }
  };

  const rootIsSpineForFilter = filter === "mainline";
  walk(anchor, maxDepth, rootIsSpineForFilter);

  return { file_id: id, filter, node_id: startNodeId, max_depth: maxDepth, count: hits.length, nodes: hits };
}

// list_transpositions — every position that occurs 2+ times in the
// file, so the LLM knows where its analysis / prose will double up.
async function listTranspositions(args: Args): Promise<unknown> {
  const id = String(args.id);
  const { file } = await loadPrepFile(id);
  const fenIndex = buildFenIndex(file.root);

  type Group = { position_key: string; size: number; node_ids: string[]; sans: (string | null)[] };
  const groups: Group[] = [];
  for (const [key, arr] of fenIndex.entries()) {
    if (arr.length < 2) continue;
    groups.push({
      position_key: key,
      size: arr.length,
      node_ids: arr.map(n => n.id),
      sans: arr.map(n => n.san),
    });
  }
  groups.sort((a, b) => b.size - a.size || a.position_key.localeCompare(b.position_key));

  const nodeCount = groups.reduce((s, g) => s + g.size, 0);
  return { file_id: id, group_count: groups.length, node_count: nodeCount, groups };
}

// Strip cruft the LLM doesn't need from the DB-position response.
// Called AFTER trimGamesMovetext so plyNumber survives long enough to
// slice each game's movetext. Also renames the `transpositions` field
// to something the LLM can parse without knowing chess-DB jargon.
function stripPositionResponse(r: unknown): void {
  if (!r || typeof r !== "object") return;
  const t = r as Record<string, unknown>;
  delete t.hash;         // internal zobrist string
  delete t.source;       // internal "database" marker; we overwrite with our own .source
  delete t.totalGames;   // duplicates statistics.totalCount often; hasMore covers pagination

  if (Array.isArray(t.moves)) {
    for (const m of t.moves as Array<Record<string, unknown>>) {
      if (typeof m.transpositions === "number") {
        m.reachedViaTransposition = m.transpositions;
        delete m.transpositions;
      }
      // Backend calls it "hotness" — a 0-100 time-decayed popularity score
      // (recent + played often = high). Rename to something an LLM can read
      // without guessing it means "on a winning streak".
      if (typeof m.hotness === "number") {
        m.fashionScore = m.hotness;
        delete m.hotness;
      }
    }
  }
  if (Array.isArray(t.games)) {
    for (const g of t.games as Array<Record<string, unknown>>) {
      delete g.gameId;
      delete g.whiteTitle;
      delete g.blackTitle;
      delete g.whiteTeam;
      delete g.blackTeam;
      delete g.round;
      delete g.plyNumber;
      delete g.relevance;
      delete g.site;
      delete g.ply;
    }
  }
}

// Trim every game's `moves` field to just the plies AFTER the queried
// position, using each game's `plyNumber`. Massive token save — a game
// 80 plies long queried at ply 12 drops to ~68 plies of movetext. Ports
// the frontend's GamesTable.getMoveDisplay() trim logic.
function trimGamesMovetext(response: unknown): void {
  if (!response || typeof response !== "object") return;
  const r = response as { games?: Array<{ moves?: string; plyNumber?: number; totalPly?: number; ply?: number }> };
  if (!Array.isArray(r.games)) return;
  for (const g of r.games) {
    if (typeof g.moves === "string" && typeof g.plyNumber === "number" && g.plyNumber > 0) {
      g.moves = trimMovesToPly(g.moves, g.plyNumber);
    }
  }
}

function trimMovesToPly(moves: string, plyNumber: number): string {
  // Split into plain SAN tokens, dropping standalone move-number tokens
  // ("1.", "12...") and any glued number prefix on a SAN token ("1.e4").
  // Result markers ("*", "1-0", "0-1", "1/2-1/2") are stripped so they
  // don't get counted as plies.
  const tokens: string[] = [];
  for (const chunk of moves.split(/\s+/)) {
    if (!chunk) continue;
    const cleaned = chunk.replace(/^\d+\.+/, "");
    if (!cleaned) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(cleaned)) continue;
    tokens.push(cleaned);
  }
  const remaining = tokens.slice(plyNumber);
  if (remaining.length === 0) return "";

  // Reconstruct with move numbering. First move gets "N..." if it's
  // Black's move (starting the slice mid-move-pair), so the reader knows
  // moves were dropped.
  const out: string[] = [];
  let ply = plyNumber;
  for (let i = 0; i < remaining.length; i++) {
    const san = remaining[i];
    const moveNumber = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) {
      out.push(`${moveNumber}. ${san}`);
    } else if (i === 0) {
      out.push(`${moveNumber}... ${san}`);
    } else {
      out.push(san);
    }
    ply++;
  }
  return out.join(" ");
}

// Rewrite availableMoves[].move UCI → SAN. The prep + position-stats
// endpoints return moves in UCI on the wire — same LLM-readability
// concern as engine PVs, and the same wrapper-only fix. Passes the
// response through unchanged if there's no availableMoves array.
function convertAvailableMovesToSAN(raw: unknown, fen: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { availableMoves?: Array<{ move?: string }> };
  if (!Array.isArray(r.availableMoves)) return raw;
  for (const m of r.availableMoves) {
    if (typeof m.move === "string" && m.move.length >= 4) {
      m.move = uciMoveToSAN(fen, m.move);
    }
  }
  return raw;
}

// Resolve a starting FEN from any combination of `fen`, `line`, and
// `moves` the tool received. Three modes, all valid:
//
//   fen alone                → use as-is
//   line/moves alone         → walk from startpos
//   fen + moves (or line)    → walk from that fen
//
// `line` is the historical field name from the backend's prep endpoint;
// `moves` is the flexible-input name we now surface for LLM ergonomics
// ("start from this FEN and play these moves next"). They're synonyms
// here — same SAN sequence, same chess.js walker. `moves` wins if both
// happen to be provided.
function resolveFenFromArgs(args: Args): string {
  const fenArg = typeof args.fen === "string" ? args.fen.trim() : "";
  const movesArg = typeof args.moves === "string" ? args.moves.trim() : "";
  const lineArg = typeof args.line === "string" ? args.line.trim() : "";
  const sequence = movesArg || lineArg;

  const board = fenArg ? new Chess(fenArg) : new Chess();
  if (sequence) {
    for (const raw of sequence.split(/\s+/)) {
      const san = raw.replace(/^\d+\.+/, "");
      if (!san) continue;
      try {
        board.move(san);
      } catch {
        throw new Error(`bad SAN token '${raw}' in moves`);
      }
    }
  }
  return board.fen();
}

// Normalize one MCP `prepare_opponent` source into the shape the backend's
// /api/chess/prep/prepare-multi expects. Handles two impedance mismatches:
//   - snake_case → camelCase (fide_id → fideId, start_month → startMonth, etc.)
//   - the unified `time_control` string → per-source-type filter:
//       * fide / chesscom → timeFormats: ["Classical" | "Rapid" | "Blitz"]
//       * lichess → perfType: "classical" | "rapid" | "blitz" | "bullet"
// Backend validates required fields per source type, so we don't need to
// pre-reject missing username/fideId here — it'll come back as a 400 the
// LLM can act on.
function normalizeSourceForBackend(src: Record<string, unknown>, idx: number): Record<string, unknown> {
  const type = typeof src.type === "string" ? src.type : "";
  if (type !== "fide" && type !== "chesscom" && type !== "lichess") {
    throw new Error(`sources[${idx}].type must be one of fide|chesscom|lichess (got ${JSON.stringify(src.type)})`);
  }
  const out: Record<string, unknown> = { type };
  if (typeof src.fide_id === "number") out.fideId = src.fide_id;
  if (typeof src.username === "string" && src.username.trim() !== "") out.username = src.username.trim();
  if (typeof src.color === "string" && (src.color === "white" || src.color === "black")) out.color = src.color;
  if (typeof src.start_month === "string" && src.start_month.trim() !== "") out.startMonth = src.start_month.trim();
  if (typeof src.end_month === "string" && src.end_month.trim() !== "") out.endMonth = src.end_month.trim();
  if (typeof src.exclude_online === "boolean") out.excludeOnline = src.exclude_online;

  const tc = typeof src.time_control === "string" ? src.time_control : "";
  if (tc) {
    if (type === "lichess") {
      out.perfType = tc;
    } else {
      // fide + chesscom take a titlecased timeFormats array.
      const titled = tc.charAt(0).toUpperCase() + tc.slice(1);
      out.timeFormats = [titled];
    }
  }
  return out;
}

// Handle to a loaded prep-file when an engine/DB tool was called with
// file_id+node_id. Carries enough state to (a) know which FEN to query,
// and (b) write ceoEval back onto the node without another parse.
type FileHandle = {
  id: string;
  version: number;
  parsedFile: PrepFile;
  idIndex: Map<string, Path>;
  nodePath: Path;
  fen: string;
};

// Async resolver used by every engine / DB tool. Three paths:
//
//   1. file_id + node_id → load file, resolve node, return FEN + handle
//      to persist ceoEval later. Cheapest, most explicit.
//
//   2. file_id + (fen | moves | line) → load file, resolve FEN
//      client-side, then scan the file's nodes for one matching that
//      FEN. If found, return the same handle as (1) so cloud_analyse
//      auto-stores on the matching node. Fixes the previous footgun
//      where `cloud_analyse({file_id, moves})` silently dropped the
//      eval because the server didn't try to match the resulting FEN
//      back to a node.
//
//   3. Just fen | moves | line, no file_id → scratch mode, no
//      persistence. Same as before.
async function resolveFromNodeOrFen(args: Args): Promise<{ fen: string; file?: FileHandle }> {
  const fileId = typeof args.file_id === "string" ? args.file_id.trim() : "";
  const nodeId = typeof args.node_id === "string" ? args.node_id.trim() : "";

  if (fileId && nodeId) {
    const g = await fetchGame(fileId);
    const parsedFile = parsePGN(g.pgnContent);
    const idIndex = buildIdIndex(parsedFile.root);
    const nodePath = resolveNodeId(idIndex, nodeId);
    const node = getNodeByPath(parsedFile.root, nodePath);
    return {
      fen: node.fen,
      file: { id: fileId, version: g.version ?? 0, parsedFile, idIndex, nodePath, fen: node.fen },
    };
  }

  if (fileId) {
    // file_id only — resolve FEN from fen/moves/line, then look it up
    // in the file's nodes. If a node has that FEN, treat this as if
    // node_id had been supplied (auto-persist on match).
    const fen = resolveFenFromArgs(args);
    try {
      const g = await fetchGame(fileId);
      const parsedFile = parsePGN(g.pgnContent);
      const match = findNodeByFen(parsedFile.root, fen);
      if (match) {
        const idIndex = buildIdIndex(parsedFile.root);
        return {
          fen,
          file: { id: fileId, version: g.version ?? 0, parsedFile, idIndex, nodePath: match.path, fen },
        };
      }
    } catch {
      // Best-effort: if the file load fails, fall through to scratch mode.
    }
    return { fen };
  }

  return { fen: resolveFenFromArgs(args) };
}

// Search the tree for a node whose FEN matches. Full-tree scan — trees
// max out ~1000 nodes so this is fine. FEN comparison is exact string
// match (both come from the same chessops normalisation).
function findNodeByFen(root: PrepNode, targetFen: string): { node: PrepNode; path: Path } | null {
  const stack: Array<{ node: PrepNode; path: Path }> = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.fen === targetFen) return { node, path };
    for (let i = 0; i < node.children.length; i++) {
      stack.push({ node: node.children[i], path: [...path, i] });
    }
  }
  return null;
}

// Local wrapper — the mutation module re-exports paths.getNode so this
// import stays consistent with the rest of the file's imports.
function getNodeByPath(root: PrepNode, path: Path): PrepNode {
  let cur = root;
  for (const idx of path) {
    if (idx < 0 || idx >= cur.children.length) throw new Error(`invalid node path segment ${idx}`);
    cur = cur.children[idx];
  }
  return cur;
}

// Persist a fresh ceoEval on the node referenced by the file handle
// AND on every other node in the same file that transposes to the
// same position (matches on the frontend's 3-field FEN key: piece
// placement + side to move + castling). Best-effort — if the file
// version raced (another agent saved between our GET and our PUT),
// we silently drop the store rather than fail the analysis the LLM
// actually asked for. The eval is still returned in the response
// either way.
//
// Return: ids of every node the eval was stamped on (empty on error).
// The primary node's id is always first (if present).
async function storeEvalOnNode(handle: FileHandle, ev: StoredEval): Promise<string[]> {
  try {
    const anchor = getNodeByPath(handle.parsedFile.root, handle.nodePath);
    const key = positionKey(anchor.fen);
    const fenIndex = buildFenIndex(handle.parsedFile.root);
    const group = fenIndex.get(key) ?? [anchor];

    // Resolve every transposed node back to its path. cloneOnPath
    // rebuilds the spine so we need paths, not references — the
    // id index was built against the original tree and every id in
    // `group` exists there.
    const idIndex = handle.idIndex ?? buildIdIndex(handle.parsedFile.root);
    const paths = group.map(n => resolveNodeId(idIndex, n.id));

    const { file: newFile, ids } = setCeoEvalMany(handle.parsedFile, paths, ev);
    const newPgn = exportPGN(newFile);
    await saveGame(handle.id, newPgn, handle.version);
    // Ensure the primary node (the one the LLM addressed) comes first.
    const anchorId = anchor.id;
    return [anchorId, ...ids.filter(x => x !== anchorId)];
  } catch {
    return [];
  }
}

function stringifyForLog(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s.length > LOG_MAX_CHARS) {
    s = s.slice(0, LOG_MAX_CHARS) + `…+${s.length - LOG_MAX_CHARS}chars`;
  }
  return s;
}

// Version tag stamped on every log line so a bug report can be traced
// to the exact MCP release that produced it. process.env.npm_package_version
// is set by npm when the package is run via `npx` / `npm start` (and by
// our systemd unit which uses npx); falls back to reading package.json
// during dev when we `node dist/index.js` directly. "unknown" if all
// else fails — better than pretending we know.
const MCP_VERSION: string = (() => {
  const fromEnv = process.env.npm_package_version?.trim();
  if (fromEnv) return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js is one level below package.json; src/index.ts is two
    // (src/index.ts → ../package.json). Try both.
    for (const p of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
})();
const MCP_TAG = `[mcp v${MCP_VERSION}]`;

// One-shot startup line so tailing the log from the beginning shows
// the running version immediately, before any tool call.
console.error(`${MCP_TAG} chessceo-mcp startup`);

async function callTool(name: string, args: Args): Promise<unknown> {
  const started = Date.now();
  console.error(`${MCP_TAG} IN  ${name} args=${stringifyForLog(args)}`);
  try {
    const result = await callToolInner(name, args);
    const dur = Date.now() - started;
    console.error(`${MCP_TAG} OUT ${name} ok ${dur}ms result=${stringifyForLog(result)}`);
    return result;
  } catch (err) {
    const dur = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${MCP_TAG} OUT ${name} err ${dur}ms error=${JSON.stringify(msg)}`);
    throw err;
  }
}

async function callToolInner(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "search_player":
      return get("/api/chess/players/search/simple", { q: String(args.name), view: "llm" });

    case "get_player_profile":
      return get("/api/chess/players/profile", { fideId: Number(args.fide_id) });

    case "prepare_opponent": {
      const rawSources = Array.isArray(args.sources) ? args.sources : [];
      if (rawSources.length === 0) throw new Error("`sources` array required");
      const sources = rawSources.map((s, i) => normalizeSourceForBackend(s as Record<string, unknown>, i));
      return authedRequest("POST", "/api/chess/prep/prepare-multi", { sources });
    }

    case "get_prep_position": {
      const token = String(args.session_token || "").trim();
      if (!token) throw new Error("`session_token` required — create one with prepare_opponent");
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const qs: Record<string, string | number | undefined> = {
        token,
        fen,
        limit: typeof args.limit === "number" ? args.limit : 10,
      };
      if (typeof args.offset === "number") qs.offset = args.offset;
      const [raw, ev] = await Promise.all([
        get("/api/chess/prep/unified", qs),
        fetchCompactEval(fen),
      ]);
      const converted = convertAvailableMovesToSAN(raw, fen);
      if (converted && typeof converted === "object") {
        trimGamesMovetext(converted);
        stripPositionResponse(converted);
        if (ev) (converted as { eval?: CompactEval }).eval = ev;
      }
      return converted;
    }

    case "list_prep_sessions":
      return authedRequest("GET", "/api/chess/prep/sessions");

    case "delete_prep_session": {
      const token = String(args.session_token || "").trim();
      if (!token) throw new Error("`session_token` required");
      return authedRequest("DELETE", `/api/chess/prep/sessions/${encodeURIComponent(token)}`);
    }

    case "get_position_stats": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const rawSource = typeof args.source === "string" ? args.source : "gm-classical";
      const source = rawSource === "main" ? "main" : "gm-classical";
      const [raw, ev] = await Promise.all([
        get(`/api/chess/database/${source}`, {
          fen,
          limit: typeof args.limit === "number" ? args.limit : 10,
          sort: "relevance",
        }),
        fetchCompactEval(fen),
      ]);
      const converted = convertAvailableMovesToSAN(raw, fen);
      if (converted && typeof converted === "object") {
        trimGamesMovetext(converted);
        stripPositionResponse(converted);
        (converted as { source?: string }).source = source;
        if (ev) (converted as { eval?: CompactEval }).eval = ev;
      }
      // Record that this position was DB-checked this session. Downstream
      // add_move / add_line under this parent won't fire the "no stats
      // check" warning. Keyed by 3-field FEN so transpositions count.
      positionsStatsChecked.add(positionKey(fen));
      return converted;
    }

    case "describe_position": {
      const resolved = await resolveFromNodeOrFen(args);
      // Chess-primitive analysis (structural, ~1 ms) + Stockfish eval-
      // term breakdown (~50-100 ms) in parallel. Merge into one response
      // so the LLM sees the whole position in one call — chess-concepts,
      // structural weaknesses, AND engine's per-term reasoning.
      // If Stockfish isn't installed the eval leg returns {found: false,
      // error} and we drop it from the response so callers see the same
      // shape either way (just without `engineEvalTerms`).
      const [structural, evalRaw] = await Promise.all([
        Promise.resolve(describePosition(resolved.fen)),
        runSfEval(resolved.fen).catch(err => ({
          found: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      ]);
      const merged = structural as Record<string, unknown>;
      const ev = evalRaw as { found?: boolean; terms?: unknown; total?: unknown };
      if (ev && ev.found === true) {
        merged.engineEvalTerms = { terms: ev.terms, total: ev.total };
      }
      // Record so set_comment on this node won't fire the "not described"
      // warning. Keyed by 3-field FEN so a described position is
      // credited across its transpositions too.
      positionsDescribed.add(positionKey(resolved.fen));
      return merged;
    }

    case "predict_human_move": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      // Rating is fixed at 2850 vs 2850. Not exposed to the LLM —
      // cross-position comparisons only mean something at a constant
      // rating, and top-level is the useful reference point for prep.
      const qs = new URLSearchParams();
      qs.set("fen", fen);
      qs.set("white_elo", "2850");
      qs.set("black_elo", "2850");
      if (typeof args.top === "number") qs.set("top", String(args.top));
      if (Array.isArray(args.prev_fens)) {
        for (const p of args.prev_fens as unknown[]) {
          if (typeof p === "string" && p.length > 0) qs.append("prev_fen", p);
        }
      }
      const raw = await authedRequest("GET", `/api/agent/predict-move?${qs.toString()}`);
      // Strip uci from each move — san is enough for the LLM and the
      // duplicate field is context bloat. Also drop whiteElo/blackElo
      // from the response (always 2850 now — echoing them adds nothing).
      if (raw && typeof raw === "object") {
        const r = raw as { moves?: Array<Record<string, unknown>>; whiteElo?: unknown; blackElo?: unknown };
        if (Array.isArray(r.moves)) {
          for (const m of r.moves) delete m.uci;
        }
        delete r.whiteElo;
        delete r.blackElo;
      }
      return raw;
    }

    case "get_head_to_head":
      return get("/api/chess/players/h2h", {
        a: Number(args.fide_id_a),
        b: Number(args.fide_id_b),
        limit: typeof args.limit === "number" ? args.limit : 10,
        offset: typeof args.offset === "number" ? args.offset : 0,
      });

    case "list_live_tournaments":
      return get("/api/chess/live/tournaments", {});

    case "list_tournament_players":
      return get("/api/chess/live/tournament/players", { tour_id: String(args.tour_id) });

    case "list_player_live_tournaments":
      // Note: snake_case fide_id, unlike the prep endpoints. Documented quirk.
      return get("/api/chess/live/player", { fide_id: Number(args.fide_id) });

    case "list_cloud_machine_options":
      return authedRequest("GET", "/api/agent/cloud-engines/options");

    case "start_cloud_engine":
      return authedRequest("POST", "/api/agent/cloud-engines", {
        machineType: String(args.machine_type),
      });

    case "list_cloud_engines":
      return authedRequest("GET", "/api/agent/cloud-engines");

    case "stop_cloud_engine":
      return authedRequest("DELETE", `/api/agent/cloud-engines/${encodeURIComponent(String(args.contract_id))}`);

    case "cloud_analyse": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const body: Record<string, unknown> = { fen };
      if (typeof args.movetime_ms === "number") body.movetime_ms = args.movetime_ms;
      if (typeof args.stockfish_multipv === "number") body.stockfish_multipv = args.stockfish_multipv;
      if (typeof args.lc0_multipv === "number") body.lc0_multipv = args.lc0_multipv;
      if (typeof args.contempt === "number") body.contempt = args.contempt;
      if (Array.isArray(args.engines)) body.engines = args.engines;
      const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse", body);
      const converted = convertCloudSnapshotResponse(raw, fen);
      // PV cap: engine PVs beyond ~6 plies are speculative (the tail is
      // where the search's confidence collapses — SF at depth 24 has
      // seen the first few plies solidly and hedged everything after).
      // More importantly, LLMs paste long PVs into `add_line` as if
      // they were prepared repertoire. A 15-move PV pasted as a
      // variation is one line of engine output through positions
      // where both sides had real choices — not a repertoire. Cap the
      // affordance: return only what's load-bearing (3 full moves for
      // understanding the point), let the caller re-analyse the
      // resulting position if they want to see further. Override via
      // `pv_max_plies` for the rare case (deep tactics verification).
      const pvMaxPlies = typeof args.pv_max_plies === "number" && args.pv_max_plies > 0
        ? Math.min(args.pv_max_plies, 40)
        : 6;
      capPvsInResponse(converted, pvMaxPlies);
      // Node-addressed calls: persist the result on the node's ceoEval
      // so a later quote_engine_eval can cite this measurement. This is
      // the anti-hallucination hinge — prose that says "engines say X
      // on node Y" can only trace back to a call actually made against
      // node_id=Y, because the store only fires when file_id+node_id
      // was supplied and the eval survives via the [%ceo-eval] escape.
      if (resolved.file) {
        const ev = analysisToStoredEval(converted);
        if (ev) {
          const stamped = await storeEvalOnNode(resolved.file, ev);
          if (stamped.length > 1) {
            // Surface the propagation so the LLM sees exactly which
            // other nodes now carry this eval (and can skip them for
            // re-analysis).
            (converted as Record<string, unknown>).also_stored_on = stamped.slice(1);
          }
        }
      }
      return converted;
    }

    case "deep_analyse":
      return deepAnalyseStart(args);
    case "deep_analyse_status":
      return deepAnalyseStatus(args);
    case "deep_analyse_cancel":
      return deepAnalyseCancel(args);

    case "find_position_in_courses":
      return findPositionInCourses(args);

    case "read_course_at_position":
      return readCourseAtPosition(args);

    case "list_collections":
      return listCollections(args);

    case "list_prep_files":
      return listPrepFiles(args);

    case "search_prep_files":
      return searchPrepFiles(args);

    case "find_position_in_files":
      return findPositionInFiles(args);

    case "read_prep_file":
      return readPrepFile(args);

    case "list_nodes":
      return listNodes(args);

    case "list_transpositions":
      return listTranspositions(args);

    case "create_prep_file":
      return createPrepFile(args);

    case "delete_prep_file": {
      await deleteGame(String(args.id));
      return { ok: true };
    }

    case "restore_prep_file": {
      const game = await restoreGame(String(args.id));
      return { ok: true, id: makeFileId(game.collectionId, game.id), version: game.version };
    }

    case "add_move":
      return applyMutation(args, (file, idIndex) => {
        const parentPath = resolveNodeId(idIndex, argNodeId(args, "parent_id"));
        const parent = getNodeByPath(file.root, parentPath);
        const noStatsWarn = noStatsCheckWarning(parent);
        const step = addMove(file, parentPath, String(args.san));
        return { ...step, ...(noStatsWarn ? { warning: noStatsWarn } : {}) };
      });

    case "add_line": {
      const sansArg = Array.isArray(args.sans) ? (args.sans as unknown[]).map(String) : [];
      const longLineWarn = longLineWarning(sansArg.length);
      return applyMutation(args, (file, idIndex) => {
        const parentPath = resolveNodeId(idIndex, argNodeId(args, "parent_id"));
        const parent = getNodeByPath(file.root, parentPath);
        const noStatsWarn = noStatsCheckWarning(parent);
        const step = addLine(file, parentPath, sansArg);
        const lastId = step.line.length > 0 ? step.line[step.line.length - 1].id : argNodeId(args, "parent_id");
        const combined = [longLineWarn, noStatsWarn].filter((s): s is string => !!s);
        return {
          file: step.file,
          id: lastId,
          results: step.line,
          ...(combined.length > 0 ? { warnings: combined } : {}),
        };
      });
    }

    case "set_comment": {
      const commentStr = typeof args.comment === "string" ? args.comment : "";
      const commentWarns = commentAntiPatterns(commentStr);
      return applyMutation(args, (file, idIndex) => {
        const targetPath = resolveNodeId(idIndex, argNodeId(args));
        const targetNode = getNodeByPath(file.root, targetPath);
        const describeWarn = noDescribeWarning(targetNode, commentStr);
        const step = setComment(file, targetPath, commentStr);
        const all = [...commentWarns, ...(describeWarn ? [describeWarn] : [])];
        return {
          ...step,
          ...(all.length > 0 ? { warnings: all } : {}),
        };
      });
    }

    case "set_nags":
      return applyMutation(args, (file, idIndex) =>
        setNags(file, resolveNodeId(idIndex, argNodeId(args)), Array.isArray(args.nags) ? (args.nags as unknown[]).map(String) : []),
      );

    case "set_annotations": {
      const arrowsRaw = Array.isArray(args.arrows) ? args.arrows as PrepArrow[] : [];
      const highlightsRaw = Array.isArray(args.highlights) ? args.highlights as PrepHighlight[] : [];
      const ann: PrepAnnotations | null =
        (arrowsRaw.length === 0 && highlightsRaw.length === 0)
          ? null
          : { arrows: arrowsRaw, highlights: highlightsRaw };
      return applyMutation(args, (file, idIndex) => setAnnotations(file, resolveNodeId(idIndex, argNodeId(args)), ann));
    }

    case "delete_subtree":
      return applyMutation(args, (file, idIndex) => deleteSubtree(file, resolveNodeId(idIndex, argNodeId(args))));

    case "promote_variation":
      return applyMutation(args, (file, idIndex) => promoteVariation(file, resolveNodeId(idIndex, argNodeId(args))));

    case "set_tag":
      return applyMutation(args, file => ({
        file: setTag(file, String(args.key), String(args.value ?? "")),
        id: ROOT_ID,
      }));

    case "apply_mutations":
      return applyBatchMutations(args);

    case "auto_evaluate":
      return autoEvaluate(args);

    case "auto_evaluate_status":
      return autoEvaluateStatus(args);

    case "auto_evaluate_cancel":
      return autoEvaluateCancel(args);

    case "quote_engine_eval": {
      const fileId = String(args.id);
      const nodeId = argNodeId(args);
      const g = await fetchGame(fileId);
      const file = parsePGN(g.pgnContent);
      const idIndex = buildIdIndex(file.root);
      const path = resolveNodeId(idIndex, nodeId);
      const node = getNodeByPath(file.root, path);
      return { ceoEval: node.ceoEval ?? null };
    }

    case "read_engine_usage_guide":
      return { guide: ENGINE_USAGE_DOC };

    case "read_opening_prep_guide":
      return { guide: PREP_STRATEGY_DOC };

    case "read_prep_files_guide":
      return { guide: PREP_FILES_DOC };

    case "read_pgn_authoring_guide":
      return { guide: PGN_AUTHORING_DOC };

    case "read_example_prep_files":
      return { overview: EXAMPLE_OVERVIEW_PGN, repertoire: EXAMPLE_REPERTOIRE_PGN };

    case "prep_snapshot": {
      const me = Number(args.fide_id_me);
      const opp = Number(args.fide_id_opponent);
      const myColor = String(args.my_color);
      const oppColor = myColor === "white" ? "black" : "white";

      // Prefer file_id+node_id — derives FEN from the tree, no LLM-typed
      // FEN in the loop. Falls back to line/fen for scratch positions.
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;

      const prepParams = (fideId: number, color: string) => ({
        fideId,
        color,
        compact: "true",
        fen,
      });

      const [opponent, you, general, ev] = await Promise.all([
        get("/api/chess/prep/by-player", prepParams(opp, oppColor)),
        get("/api/chess/prep/by-player", prepParams(me, myColor)),
        get("/api/chess/database/main", { fen, limit: 20, sort: "relevance" }),
        fetchCompactEval(fen),
      ]);

      return {
        position: { fen, my_color: myColor, ...(resolved.file ? { node_id: typeof args.node_id === "string" ? args.node_id : undefined } : {}) },
        eval: ev,
        opponent: convertAvailableMovesToSAN(opponent, fen),
        you: convertAvailableMovesToSAN(you, fen),
        general: convertAvailableMovesToSAN(general, fen),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}


// The workflow text for prepare_for_game. Kept in one place so both the
// MCP prompt handler and the /prepare fallback can share it.
const PREP_WORKFLOW = (args: Record<string, string | undefined>) => {
  const me = args.me ?? "the user";
  const opp = args.opponent ?? "the opponent";
  const color = args.my_color ? ` as ${args.my_color}` : "";
  const tc = args.time_control ? ` in a ${args.time_control} game` : "";
  return `You are preparing ${me} for a chess game against ${opp}${color}${tc}.

Preparation workflow — follow the steps in order and be explicit about which tools you called at each step:

1. **Resolve both players.** Call \`search_player\` for "${me}" and "${opp}" to get their FIDE IDs. Confirm the identity — many players share names.

2. **Understand the opponent.** Call \`get_player_profile\` for the opponent. Read out:
   - Current classical / rapid / blitz ratings.
   - Top openings as White and Black (from openingRepertoire).
   - Career win / draw / loss splits — is the draw rate above ~40%? That's a stylistic hint (drawish opponents need to be unbalanced).
   - Notable wins and worst losses — patterns?

3. **Weight games by quality when interpreting the data.**
   - Recent games (last 12-24 months) matter far more than old ones. Opening repertoires evolve.
   - Classical over-the-board games are the strongest signal — that's what real preparation reveals.
   - Rapid and blitz reveal what they play under time pressure but may include experiments.
   - Online games are useful but noisier (blitz gambits, alt accounts).

4. **Walk the opponent's repertoire against ${me}'s color.** Call \`prepare_opponent\` once with the opponent's FIDE ID (add \`chesscom\` / \`lichess\` sources if you know their handles), filtered to the color they'll have in this game — plus \`start_month\` (last 12-24 months) and \`time_control: "classical"\` if you want the strongest signal. That returns a session \`token\`. Then walk the tree with \`get_prep_position(session_token=token, node_id="r")\`, pick the opponent's most-played reply, call again as you descend. Look for:
   - **Weak lines**: variations where the opponent scores below 40% as their side.
   - **Shallow lines**: openings the opponent has played only a few times — probably less deeply prepared.
   - **Abandoned lines**: openings they used to play but stopped. Something went wrong; may not want to revisit.
   - **Variety**: places where the opponent picks different moves game to game — those are branching points where they can't predict your prep.

5. **Style considerations.**
   - High draw rate → propose openings that unbalance early (Benoni, King's Indian, gambit lines).
   - Sharp tactician → don't play their prepared attacks; steer toward quiet positional lines.
   - Endgame strong → keep queens on and keep complications.

6. **Cross-check head-to-head.** Call \`get_head_to_head\` on the two players. If they've met before, what openings decided those games? Anything the opponent showed only against ${me}?

7. **Deliver a concrete plan.** Summarize:
   - What the opponent will likely play on move 1 (with confidence level).
   - The 2-3 branching points where the opponent is weakest for ${me}'s color.
   - The concrete move sequence ${me} should aim for to steer into those positions.
   - What to avoid — the opponent's strongest weapons.

Don't just dump data. Reason about it. Cite specific numbers (game counts, win rates, dates) so the user can trust your conclusions.`;
};

// ── Server wiring ──────────────────────────────────────────────────

const server = new Server(
  { name: "chessceo-mcp", version: process.env.npm_package_version ?? "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const promptArgs: Record<string, string | undefined> = {};
  if (args) for (const [k, v] of Object.entries(args)) promptArgs[k] = String(v);

  let text: string;
  switch (name) {
    case "prepare_for_game":
      text = PREP_WORKFLOW(promptArgs);
      break;
    case "scout_player": {
      const p = promptArgs.player ?? "the player";
      text = `Produce a scouting report on ${p}. Steps:
1. \`search_player\` to get their FIDE ID.
2. \`get_player_profile\` — pull rating history, career splits by color and time control, opening repertoire, opponent analysis, top events, notable wins and losses.
3. Weight the data: recent (last 12-24 months) > older, classical OTB > rapid/blitz > online.
4. \`prepare_opponent\` twice (once per colour, or once with two sources), then \`get_prep_position(session_token, node_id="r")\` to summarise their opening choices with actual frequencies and win rates. Filter with \`start_month\` if you only care about their current repertoire.
5. Deliver: current strength, characteristic openings, one-sentence style read, biggest wins, biggest losses / recurring weakness. Cite the numbers.`;
      break;
    }
    case "engine_usage_primer":
      text = ENGINE_USAGE_DOC;
      break;
    case "prep_strategy_primer":
      text = PREP_STRATEGY_DOC;
      break;
    case "head_to_head_briefing": {
      const a = promptArgs.player_a ?? "player A";
      const b = promptArgs.player_b ?? "player B";
      text = `Briefing on the ${a} vs ${b} history. Steps:
1. Resolve both FIDE IDs with \`search_player\`.
2. \`get_head_to_head\` for the pair — pull overall + per-color W/D/L (from ${a}'s perspective), splits by time format, first / last meeting, most-played openings between them, average game length.
3. Read the pattern: who has the edge, in which colour, in which time format. Which openings decide the meetings? Anything unusual — very drawish, very sharp, big rating gap?
4. If either player is currently live in a tournament, note it with \`list_player_live_tournaments\`.
5. Deliver a one-paragraph read: score, dominant openings, one-line style clash, current form.`;
      break;
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }

  return {
    description: `chessceo prompt: ${name}`,
    messages: [
      { role: "user", content: { type: "text", text } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, (args ?? {}) as Args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

// ── Transport selection ────────────────────────────────────────────
//
// Two modes:
//   stdio        (default)  — local subprocess, host spawns via npx / config.
//                             Every existing Claude Desktop / Cursor / Claude Code
//                             install of this package uses stdio.
//   http         (--transport=http --http-port=8080)
//                            — remote MCP over Streamable HTTP. Bind to a port,
//                              expose /mcp, users add the URL to their host
//                              instead of running npx. This is what
//                              claude.ai / mobile / other zero-install hosts
//                              need. Stateless mode: each request creates a
//                              fresh transport + response, no session
//                              persistence, safe to scale horizontally.

const argv = process.argv.slice(2);
const arg = (name: string, def?: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const cur = argv[i];
  return cur.includes("=") ? cur.split("=").slice(1).join("=") : argv[i + 1];
};

const transportKind = (arg("transport", process.env.MCP_TRANSPORT ?? "stdio") ?? "stdio").toLowerCase();

if (transportKind === "stdio") {
  await server.connect(new StdioServerTransport());
} else if (transportKind === "http" || transportKind === "streamable-http") {
  const port = Number(arg("http-port", process.env.MCP_HTTP_PORT ?? "8080"));
  const host = arg("http-host", process.env.MCP_HTTP_HOST ?? "127.0.0.1") ?? "127.0.0.1";
  const path = arg("http-path", process.env.MCP_HTTP_PATH ?? "/mcp") ?? "/mcp";

  // Read a JSON body off req into memory. Bodies are tiny (JSON-RPC), so
  // no streaming needed; guard against absurd payloads with a hard cap.
  const MAX_BODY = 1_048_576; // 1 MB
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_BODY) {
          req.destroy();
          reject(new Error("body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text.length === 0 ? undefined : JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Basic CORS so browser-based MCP hosts can call us cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Liveness — cheap health check for load balancers / uptime monitors.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("ok\n");
      return;
    }

    const urlPath = (req.url ?? "").split("?")[0];

    // RFC 9728 protected-resource metadata. MCP hosts (claude.ai, ChatGPT)
    // fetch this after receiving a 401 with WWW-Authenticate below; it
    // points them at chess.ceo's OAuth 2.1 authorization server, which
    // handles registration (DCR), consent, and token issuance.
    if (req.method === "GET" && urlPath === "/.well-known/oauth-protected-resource") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(JSON.stringify({
        resource: "https://mcp.chess.ceo/mcp",
        authorization_servers: ["https://chess.ceo"],
        scopes_supported: ["agent"],
        bearer_methods_supported: ["header"],
      }));
      return;
    }

    // Everything else must hit the MCP path.
    if (urlPath !== path) {
      res.statusCode = 404;
      res.end();
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const authHeader = req.headers["authorization"];
      const authHeaderStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;

      // If the caller is invoking an authed tool without a token, respond
      // with 401 + WWW-Authenticate pointing at RFC 9728 metadata BEFORE
      // handing off to the MCP SDK — MCP hosts (claude.ai, ChatGPT) look
      // for this header at the HTTP layer to auto-start OAuth discovery.
      if (!authHeaderStr && isAuthedToolCall(body)) {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer realm="chess.ceo", resource_metadata="https://mcp.chess.ceo/.well-known/oauth-protected-resource"`,
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "authentication required" },
          id: (body as { id?: unknown } | undefined)?.id ?? null,
        }));
        return;
      }

      // Stateless: one transport per request, no session store. Simpler,
      // scales trivially, matches how claude.ai / ChatGPT connectors call.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      // Forward the caller's Authorization header down to tool handlers so
      // they can attach it when calling authenticated backend endpoints.
      // AsyncLocalStorage survives every await inside the tool handler.
      await authContext.run({ authHeader: authHeaderStr }, async () => {
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`chessceo-mcp: streamable-http on http://${host}:${port}${path}`);
  });

  // Graceful shutdown so `systemctl stop` doesn't leak connections.
  const shutdown = (sig: string) => {
    console.error(`chessceo-mcp: ${sig} received, closing`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  console.error(`chessceo-mcp: unknown --transport '${transportKind}' (expected stdio or http)`);
  process.exit(2);
}
