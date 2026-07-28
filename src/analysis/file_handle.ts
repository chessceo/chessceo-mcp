// Shared address resolution for engine + DB tools. Every position-taking
// tool (cloud_analyse, describe_position, predict_human_move,
// prep_snapshot, get_prep_position, find_position_in_files,
// find_position_in_courses, deep_analyse, quote_engine_eval) accepts the
// same set of position inputs — this module normalises them into a FEN
// (and, when the caller was inside a prep file, a FileHandle that lets
// the downstream write ceoEval back on the resolved node).
//
// Extracted from index.ts in v0.44 as part of the file split.

import { Chess } from "chess.js";
import { fetchGame, saveGame } from "../http.js";
import { parsePGN } from "../pgn/parser.js";
import { exportPGN } from "../pgn/exporter.js";
import {
  buildFenIndex,
  buildIdIndex,
  positionKey,
  resolveNodeId,
} from "../pgn/paths.js";
import { setCeoEvalMany } from "../pgn/mutations.js";
import type { Path, PrepFile, PrepNode, StoredEval } from "../pgn/types.js";

type Args = Record<string, unknown>;

// Everything a downstream write needs to persist a fresh ceoEval on the
// node the caller resolved to. `nodePath` is the internal array-of-child-
// indices form; the LLM only ever sees node ids.
export type FileHandle = {
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
export async function resolveFromNodeOrFen(args: Args): Promise<{ fen: string; file?: FileHandle }> {
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

// Normalize the LLM's position inputs into a single FEN. Used both by
// resolveFromNodeOrFen and directly by tools that don't need a file
// handle. Accepts three shapes: bare `fen`, `moves` from startpos (SAN
// space-separated, with optional `1.` / `1...` move-number prefixes
// stripped), or `fen`+`moves` layered together. `line` is a legacy
// alias for `moves`.
export function resolveFenFromArgs(args: Args): string {
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

// Search the tree for a node whose FEN matches. Full-tree scan — trees
// max out ~1000 nodes so this is fine. FEN comparison is exact string
// match (both come from the same chessops normalisation).
export function findNodeByFen(root: PrepNode, targetFen: string): { node: PrepNode; path: Path } | null {
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

// Local wrapper for path→node navigation — kept here so callers of the
// file_handle module don't have to import pgn/paths.js just for one
// walk. Body identical to paths.getNode.
export function getNodeByPath(root: PrepNode, path: Path): PrepNode {
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
export async function storeEvalOnNode(handle: FileHandle, ev: StoredEval): Promise<string[]> {
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
