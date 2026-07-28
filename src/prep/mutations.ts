// Mutation orchestration for prep files.
//
// Every mutation tool goes through one of two entry points:
//   - `applyMutation(args, mutator)` — the standard case handler wrapper.
//     Fetches the file, runs the mutator, saves. Auto-saves so every
//     tool call is atomic; the LLM never sees intermediate state.
//   - `applyBatchMutations(args)` — the `apply_mutations` tool. Loads
//     once, runs N ops in order via `dispatchMutation`, saves once.
//     All-or-nothing.
//
// `dispatchMutation` is the switch that maps `op` names to the actual
// mutation helpers from `pgn/mutations` plus the anti-pattern warning
// scanners.
//
// Extracted from index.ts in v0.44 as part of the file split.

import { fetchGame, saveGame } from "../http.js";
import { parsePGN } from "../pgn/parser.js";
import { exportPGN } from "../pgn/exporter.js";
import {
  buildIdIndex,
  NodeIdError,
  PathError,
  resolveNodeId,
  ROOT_ID,
} from "../pgn/paths.js";
import {
  addLine,
  addMove,
  deleteSubtree,
  MutationError,
  promoteVariation,
  setAnnotations,
  setCeoEval,
  setComment,
  setNags,
  setTag,
} from "../pgn/mutations.js";
import type {
  Path,
  PrepAnnotations,
  PrepArrow,
  PrepFile,
  PrepHighlight,
  StoredEval,
} from "../pgn/types.js";
import { getNodeByPath } from "../analysis/file_handle.js";
import {
  commentAntiPatterns,
  longLineWarning,
  noDescribeWarning,
  noStatsCheckWarning,
} from "../warnings.js";

type Args = Record<string, unknown>;

// Extract a node id from the args. Accepts either `node_id` or a
// `parent_id` alias for the add-style tools. Throws with a helpful
// message if malformed.
export function argNodeId(args: Args, key: "node_id" | "parent_id" = "node_id"): string {
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
export function dispatchMutation(
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
export async function applyBatchMutations(args: Args): Promise<unknown> {
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

// Load-mutate-save: fetch current PGN, parse, apply mutation, re-export,
// save with optimistic lock. Auto-saves so every tool call is atomic;
// the LLM never sees intermediate state. The mutator is called with
// both the parsed file and its id → path index, so the mutation can
// resolve node_ids without rebuilding the index itself.
export async function applyMutation(
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
