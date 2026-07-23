// Pure mutation functions on a PrepFile tree. Each returns a new
// PrepFile (structural sharing where safe) plus the effective path of
// the touched node, so tools can report where the LLM's request
// actually landed after any rebalancing.
//
// All move-making mutations validate SAN against the current FEN via
// chessops before touching the tree — a bad move surfaces as a thrown
// error containing the FEN and rejected SAN, which the LLM can act on
// (usually by re-checking the position it thought it was at).

import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { parseSan } from "chessops/san";
import { makeFen } from "chessops/fen";

import { cloneOnPath, getNode, getParent, PathError } from "./paths.js";
import type {
  Path,
  PrepAnnotations,
  PrepFile,
  PrepNode,
} from "./types.js";

export class MutationError extends Error {}

// Apply a SAN move as a new child at `path`. If the target already has
// children, the new node is appended (becomes a variation, since
// mainline is children[0]). Use promoteVariation to make the new node
// the mainline afterwards if that's what you wanted.
export function addMove(file: PrepFile, path: Path, san: string): { file: PrepFile; path: Path } {
  const parent = getNode(file.root, path);
  const move = validateSan(parent.fen, san);
  const posSetup = parseFen(parent.fen);
  if (posSetup.isErr) throw new MutationError(`bad parent FEN in tree: ${posSetup.error}`);
  const pos = Chess.fromSetup(posSetup.value);
  if (pos.isErr) throw new MutationError(`bad parent position: ${pos.error}`);
  const board = pos.value;
  board.play(move);
  const childFen = makeFen(board.toSetup());

  const newNode: PrepNode = {
    san,
    fen: childFen,
    ply: parent.ply + 1,
    children: [],
  };

  const { root: newRoot, target } = cloneOnPath(file.root, path);
  target.children = [...target.children, newNode];

  return {
    file: { tags: file.tags, root: newRoot },
    path: [...path, target.children.length - 1],
  };
}

// Replace the comment on the node at `path`. Passing empty string /
// null clears it.
export function setComment(file: PrepFile, path: Path, comment: string | null): { file: PrepFile; path: Path } {
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  const trimmed = (comment ?? "").trim();
  if (trimmed) target.comment = trimmed;
  else delete target.comment;
  return { file: { tags: file.tags, root: newRoot }, path };
}

// Replace the NAG list. Empty array clears.
export function setNags(file: PrepFile, path: Path, nags: string[]): { file: PrepFile; path: Path } {
  const cleaned = nags
    .map(s => s.trim())
    .filter(s => /^\$\d+$/.test(s));
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  if (cleaned.length > 0) target.nags = cleaned;
  else delete target.nags;
  return { file: { tags: file.tags, root: newRoot }, path };
}

// Replace visual annotations (arrows + highlighted squares). Empty
// arrows and highlights arrays clear the annotations entirely.
export function setAnnotations(file: PrepFile, path: Path, ann: PrepAnnotations | null): { file: PrepFile; path: Path } {
  const { root: newRoot, target } = cloneOnPath(file.root, path);
  const isEmpty = !ann || (ann.arrows.length === 0 && ann.highlights.length === 0);
  if (isEmpty) delete target.annotations;
  else target.annotations = { arrows: ann!.arrows, highlights: ann!.highlights };
  return { file: { tags: file.tags, root: newRoot }, path };
}

// Delete the node at `path` and all its descendants. Refuses to delete
// the root. Returns the path of the deleted node's parent for the
// caller's convenience.
export function deleteSubtree(file: PrepFile, path: Path): { file: PrepFile; path: Path } {
  if (path.length === 0) throw new MutationError("cannot delete root");
  const parentPath = path.slice(0, -1);
  const removeIdx = path[path.length - 1];
  const { root: newRoot, target: parent } = cloneOnPath(file.root, parentPath);
  if (removeIdx < 0 || removeIdx >= parent.children.length) {
    throw new PathError(`delete index ${removeIdx} out of bounds`, path);
  }
  parent.children = parent.children.filter((_, i) => i !== removeIdx);
  return { file: { tags: file.tags, root: newRoot }, path: parentPath };
}

// Promote the node at `path` to be its parent's first child (the
// mainline). Silently no-ops if it's already the mainline. Refuses on
// root (root has no parent to promote against).
export function promoteVariation(file: PrepFile, path: Path): { file: PrepFile; path: Path } {
  if (path.length === 0) throw new MutationError("cannot promote root");
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  if (idx === 0) return { file, path }; // already mainline
  const { root: newRoot, target: parent } = cloneOnPath(file.root, parentPath);
  const promoted = parent.children[idx];
  const rest = parent.children.filter((_, i) => i !== idx);
  parent.children = [promoted, ...rest];
  return { file: { tags: file.tags, root: newRoot }, path: [...parentPath, 0] };
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
      `illegal SAN "${san}" at fen "${fen}" — check the position (side to move, piece disambiguation, promotion piece) and re-check the path.`,
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
export { getNode, getParent } from "./paths.js";
