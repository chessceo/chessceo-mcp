// Node addressing for the LLM: stable content-derived IDs, resolved
// internally to array-of-child-indices `Path` for the mutation
// implementation. LLM-facing tools never accept a path — they take a
// `node_id` (or `parent_id` for add_move) and this module turns it
// into the path the mutation code walks.
//
// The ID → path index is built once per parse and read many times per
// batch. Every mutation preserves IDs on unchanged nodes (IDs are pure
// functions of parent.id + san, so adding/removing/promoting siblings
// leaves every ID untouched), so callers don't need to rebuild the
// index between ops in a batch — they just extend it with the newly
// created node's id when applyMutations lands one.

import { createHash } from "node:crypto";

import type { PrepNode, Path } from "./types.js";

// Special ID for the root position (starting FEN, no move played).
export const ROOT_ID = "r";

// 8-hex-char content hash. Root is "r". Every other node's id is
// derived from (parent.id, san). Two nodes with the same (parent, san)
// can't co-exist as siblings in chess anyway, so within-parent
// collisions are impossible. Cross-tree collisions in 32 bits at 1000
// nodes are ~10^-4 — we throw on the rare hit rather than mask it.
export function deriveNodeId(parentId: string, san: string): string {
  const h = createHash("sha256");
  h.update(parentId);
  h.update("|");
  h.update(san);
  return h.digest("hex").slice(0, 8);
}

// Bad-node-id errors so the LLM sees exactly what went wrong. Message
// carries the offending id, which is often a copy-paste bug (missing
// character, wrong file id, stale reference to a deleted node).
export class NodeIdError extends Error {
  constructor(msg: string, public readonly nodeId: string) {
    super(`${msg} (node_id=${nodeId})`);
  }
}

export class PathError extends Error {
  constructor(msg: string, public readonly path: Path) {
    super(`${msg} (path=${JSON.stringify(path)})`);
  }
}

// Build the id → path index for a whole tree. Also detects the rare
// collision (two nodes with the same 32-bit id) and throws so the
// caller can surface a clear message.
export function buildIdIndex(root: PrepNode): Map<string, Path> {
  const index = new Map<string, Path>();
  const walk = (node: PrepNode, path: Path): void => {
    if (index.has(node.id)) {
      throw new Error(
        `node id collision on "${node.id}" — two distinct nodes in the tree ` +
        `hash to the same 32-bit id. This is statistically rare (~10^-4 at ` +
        `1000 nodes); if you see this, please report the file so we can ` +
        `widen the hash.`,
      );
    }
    index.set(node.id, path);
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], [...path, i]);
    }
  };
  walk(root, []);
  return index;
}

// Resolve a node_id to a Path against a specific tree. Throws
// NodeIdError with a message the LLM can act on.
export function resolveNodeId(index: Map<string, Path>, nodeId: string): Path {
  const path = index.get(nodeId);
  if (!path) {
    throw new NodeIdError(
      `no node with this id in the tree. Either it was deleted since your ` +
      `last read, you have a typo, or you're addressing a different file — ` +
      `call read_prep_file to refresh`,
      nodeId,
    );
  }
  return path;
}

// Resolve a path to a node reference. Throws PathError if the path
// escapes the tree — used internally by the mutation code after
// node_id → path resolution.
export function getNode(root: PrepNode, path: Path): PrepNode {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.children.length) {
      throw new PathError(
        `path segment ${i} = ${idx} is out of bounds; parent has ${cur.children.length} children`,
        path,
      );
    }
    cur = cur.children[idx];
  }
  return cur;
}

// Get the parent of the node at `path` plus this node's index in its
// parent's children array. Returns null if path refers to the root.
export function getParent(root: PrepNode, path: Path): { parent: PrepNode; index: number } | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const parent = getNode(root, parentPath);
  const index = path[path.length - 1];
  return { parent, index };
}

// Deep-clone nodes on the path from root to the mutation target,
// leaving unrelated subtrees shared. Downstream code treats siblings
// as immutable so this sharing is safe.
export function cloneOnPath(root: PrepNode, path: Path): { root: PrepNode; target: PrepNode; parentChain: PrepNode[] } {
  const newRoot: PrepNode = { ...root, children: [...root.children] };
  const parentChain: PrepNode[] = [newRoot];
  let cur = newRoot;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (idx < 0 || idx >= cur.children.length) {
      throw new PathError(`path segment ${i} = ${idx} out of bounds`, path);
    }
    const cloned: PrepNode = { ...cur.children[idx], children: [...cur.children[idx].children] };
    cur.children[idx] = cloned;
    cur = cloned;
    parentChain.push(cur);
  }
  return { root: newRoot, target: cur, parentChain };
}
