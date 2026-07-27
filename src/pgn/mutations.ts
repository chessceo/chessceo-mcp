// Pure mutation functions on a PrepFile tree. Each returns a new
// PrepFile (structural sharing where safe) plus the node_id of the
// touched node (the LLM addresses nodes by content-derived id — see
// paths.ts — so tools return the id, not the path).
//
// All move-making mutations validate SAN against the current FEN via
// chessops before touching the tree — a bad move surfaces as a thrown
// error containing the FEN and rejected SAN, which the LLM can act on
// (usually by re-checking the position it thought it was at).

import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { parseSan } from "chessops/san";
import { makeFen } from "chessops/fen";

import { cloneOnPath, deriveNodeId, getNode, getParent, PathError } from "./paths.js";
import type {
  Path,
  PrepAnnotations,
  PrepFile,
  PrepNode,
  StoredEval,
} from "./types.js";

export class MutationError extends Error {}

// Result shape returned by every mutation: the new file, and the id of
// the node the mutation landed on. `id` is what the tool hands back to
// the LLM; the underlying path is an implementation detail.
export type MutationResult = { file: PrepFile; id: string };

// Add a SAN move as a new child under `parentPath`. **Idempotent on
// SAN**: if a child with this SAN already exists under the parent, we
// return that existing child's id and leave the file unchanged. Same
// SAN from the same position IS the same move in chess — appending a
// duplicate sibling would (a) let the LLM create ambiguous "two lines
// both starting with d5" trees and (b) produce two nodes with the
// same content-derived id. Frontend's MoveService.playMove has the
// same "append new or navigate to existing" behaviour; this mirrors it.
//
// If there's no existing child with that SAN, we validate the move,
// derive the new id from (parent.id, san), and append. Because
// mainline is children[0], any appended move becomes a variation
// unless the parent had no children yet; use promoteVariation to
// switch mainline afterwards.
export function addMove(file: PrepFile, parentPath: Path, san: string): MutationResult {
  const parent = getNode(file.root, parentPath);

  // Idempotence: join to an existing child with the same SAN.
  const existing = parent.children.find(c => c.san === san);
  if (existing) {
    return { file, id: existing.id };
  }

  const move = validateSan(parent.fen, san);
  const posSetup = parseFen(parent.fen);
  if (posSetup.isErr) throw new MutationError(`bad parent FEN in tree: ${posSetup.error}`);
  const pos = Chess.fromSetup(posSetup.value);
  if (pos.isErr) throw new MutationError(`bad parent position: ${pos.error}`);
  const board = pos.value;
  board.play(move);
  const childFen = makeFen(board.toSetup());

  const newId = deriveNodeId(parent.id, san);
  const newNode: PrepNode = {
    id: newId,
    san,
    fen: childFen,
    ply: parent.ply + 1,
    children: [],
  };

  const { root: newRoot, target } = cloneOnPath(file.root, parentPath);
  target.children = [...target.children, newNode];

  return {
    file: { tags: file.tags, root: newRoot },
    id: newId,
  };
}

// Add a linear sequence of moves under `parentPath` — one call for a
// whole variation instead of N add_move calls. Inherits addMove's
// idempotence: if the line's prefix overlaps an existing branch, we
// join to it and only start creating new nodes at the divergence
// point. So two `add_line` calls sharing a prefix (e.g. `[d5, Bb5,
// Nd7]` and `[d5, Bb5, Ne4]`) build a proper Y-shape — one d5 → one
// Bb5 → two siblings from there — not two duplicate chains.
//
// Returns the ids and SANs of every node along the resulting line
// (both joined and newly-created), so the LLM can address any of
// them next.
export function addLine(
  file: PrepFile,
  parentPath: Path,
  sans: string[],
): { file: PrepFile; line: Array<{ id: string; san: string }> } {
  if (sans.length === 0) throw new MutationError("add_line requires at least one san");

  let cur = file;
  let curPath = parentPath;
  const line: Array<{ id: string; san: string }> = [];

  for (const san of sans) {
    const step = addMove(cur, curPath, san);
    cur = step.file;
    // Find the child we just addressed (whether we appended a new
    // node or joined to an existing one) by its id, so the next
    // iteration extends from the RIGHT node — not necessarily the
    // parent's last child.
    const parent = getNode(cur.root, curPath);
    const childIdx = parent.children.findIndex(c => c.id === step.id);
    if (childIdx < 0) throw new MutationError(`internal: node ${step.id} not found after addMove`);
    curPath = [...curPath, childIdx];
    line.push({ id: step.id, san });
  }

  return { file: cur, line };
}

// Replace the comment on the node at `path`. Passing empty string /
// null clears it.
export function setComment(file: PrepFile, path: Path, comment: string | null): MutationResult {
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  const trimmed = (comment ?? "").trim();
  if (trimmed) target.comment = trimmed;
  else delete target.comment;
  return { file: { tags: file.tags, root: newRoot }, id: target.id };
}

// Replace the NAG list. Empty array clears.
export function setNags(file: PrepFile, path: Path, nags: string[]): MutationResult {
  const cleaned = nags
    .map(s => s.trim())
    .filter(s => /^\$\d+$/.test(s));
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  if (cleaned.length > 0) target.nags = cleaned;
  else delete target.nags;
  return { file: { tags: file.tags, root: newRoot }, id: target.id };
}

// Replace visual annotations (arrows + highlighted squares). Empty
// arrows and highlights arrays clear the annotations entirely.
export function setAnnotations(file: PrepFile, path: Path, ann: PrepAnnotations | null): MutationResult {
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  const isEmpty = !ann || (ann.arrows.length === 0 && ann.highlights.length === 0);
  if (isEmpty) delete target.annotations;
  else target.annotations = { arrows: ann!.arrows, highlights: ann!.highlights };
  return { file: { tags: file.tags, root: newRoot }, id: target.id };
}

// Delete the node at `path` and all its descendants. Refuses to delete
// the root. Returns the id of the deleted node's parent.
export function deleteSubtree(file: PrepFile, path: Path): MutationResult {
  if (path.length === 0) throw new MutationError("cannot delete root");
  const parentPath = path.slice(0, -1);
  const removeIdx = path[path.length - 1];
  const { root: newRoot, target: parent } = cloneOnPath(file.root, parentPath);
  if (removeIdx < 0 || removeIdx >= parent.children.length) {
    throw new PathError(`delete index ${removeIdx} out of bounds`, path);
  }
  parent.children = parent.children.filter((_, i) => i !== removeIdx);
  return { file: { tags: file.tags, root: newRoot }, id: parent.id };
}

// Promote the node at `path` to be its parent's first child (the
// mainline). Silently no-ops if it's already the mainline. Refuses on
// root (root has no parent to promote against). Returns the promoted
// node's id (unchanged by the reorder — IDs don't depend on sibling
// position).
export function promoteVariation(file: PrepFile, path: Path): MutationResult {
  if (path.length === 0) throw new MutationError("cannot promote root");
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  if (idx === 0) {
    // Already mainline — return the existing id without touching anything.
    const target = getNode(file.root, path);
    return { file, id: target.id };
  }
  const { root: newRoot, target: parent } = cloneOnPath(file.root, parentPath);
  const promoted = parent.children[idx];
  const rest = parent.children.filter((_, i) => i !== idx);
  parent.children = [promoted, ...rest];
  return { file: { tags: file.tags, root: newRoot }, id: promoted.id };
}

// Replace the stored ceoEval on the node at `path`. Passing null clears.
// This is what auto_evaluate / cloud_analyse(node_id) calls per-node.
export function setCeoEval(file: PrepFile, path: Path, ev: StoredEval | null): MutationResult {
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  if (ev === null || (!ev.sf && !ev.lc0 && !ev.nag)) delete target.ceoEval;
  else target.ceoEval = ev;
  return { file: { tags: file.tags, root: newRoot }, id: target.id };
}

// Set the same ceoEval on every path in `paths`. One clone-and-return
// rather than N sequential setCeoEval calls. Used by cloud_analyse to
// propagate a single measurement to every transposition of the position
// in the file — the LLM shouldn't have to re-analyse a position it
// already measured under a different move order.
export function setCeoEvalMany(file: PrepFile, paths: Path[], ev: StoredEval | null): { file: PrepFile; ids: string[] } {
  if (paths.length === 0) return { file, ids: [] };
  // Sort deepest-first so cloning one target doesn't invalidate later
  // ones' path references — cloneOnPath re-parents everything along
  // the path, so mutating a shallower path after a deeper one is safe;
  // sorting is defensive.
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  let cur = file;
  const ids: string[] = [];
  for (const p of sorted) {
    const step = setCeoEval(cur, p, ev);
    cur = step.file;
    ids.push(step.id);
  }
  return { file: cur, ids };
}

// Set or clear a tag. Passing null / empty removes.
export function setTag(file: PrepFile, key: string, value: string | null): PrepFile {
  const cleanedKey = key.trim();
  if (!cleanedKey) throw new MutationError("tag key required");
  const newTags = { ...file.tags };
  if (value === null || value === "") delete newTags[cleanedKey];
  else newTags[cleanedKey] = value;
  return { tags: newTags, root: file.root };
}

// SAN validation: parses via chessops from the parent FEN. Throws a
// MutationError with the FEN + rejected SAN so the LLM sees what
// position it was actually attacking.
function validateSan(fen: string, san: string) {
  const setup = parseFen(fen);
  if (setup.isErr) throw new MutationError(`bad parent FEN: ${setup.error}`);
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) throw new MutationError(`bad parent position: ${pos.error}`);
  const board = pos.value;
  const move = parseSan(board, san);
  if (!move) {
    throw new MutationError(
      `illegal SAN "${san}" at fen "${fen}". Call describe_position on this node to see the full list of legal moves.`,
    );
  }
  return move;
}

// Utility: report the path of a node reference. Used when a tool wants
// to tell the LLM where the mutation landed after any rebalancing.
export function pathOf(root: PrepNode, target: PrepNode): Path | null {
  const stack: { node: PrepNode; path: Path }[] = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === target) return path;
    for (let i = 0; i < node.children.length; i++) {
      stack.push({ node: node.children[i], path: [...path, i] });
    }
  }
  return null;
}

// Re-exports so index.ts only imports from mutations.
export { getNode, getParent, buildIdIndex, resolveNodeId, NodeIdError, ROOT_ID } from "./paths.js";
