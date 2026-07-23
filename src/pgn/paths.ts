// Path-based addressing for the LLM. The frontend uses UUIDs but they
// regenerate every parse, so we can't use them across sessions. Paths
// are child-index arrays — deterministic across parse/export cycles as
// long as we don't reorder children on export.

import type { PrepNode, Path } from "./types.js";

export class PathError extends Error {
  constructor(msg: string, public readonly path: Path) {
    super(`${msg} (path=${JSON.stringify(path)})`);
  }
}

// Resolve a path to a node reference. Throws PathError if the path
// escapes the tree — that's ALWAYS the LLM's fault, and the message
// tells it exactly where things fell apart.
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

// Read-only shallow clone helper the mutation functions use to avoid
// hidden aliasing. Deep-clones nodes on the path from root to the
// mutation target, leaving unrelated subtrees shared (they're
// immutable-by-convention downstream, so this is safe and cheap).
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
