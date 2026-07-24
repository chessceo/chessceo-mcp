// PGN → PrepFile. Uses chessops for the heavy lifting (SAN parsing,
// legality, FEN generation) and walks the resulting parse tree into
// our compact PrepNode shape.
//
// ChessBase annotations ([%cal ...], [%csl ...]) get stripped out of
// the comment text and reified into the node's `annotations` field.
// Unknown [%foo bar] blocks are dropped silently — the LLM won't be
// writing arbitrary commands, and preserving unknown ones adds noise.

import { parsePgn, startingPosition } from "chessops/pgn";
import { parseSan } from "chessops/san";
import { makeFen } from "chessops/fen";
import { opposite } from "chessops/util";
import type { Position } from "chessops/chess";

import {
  colorFromCode,
  type PrepAnnotations,
  type PrepFile,
  type PrepNode,
  type PrepTags,
  type StoredEngineEval,
  type StoredEval,
} from "./types.js";
import { deriveNodeId, ROOT_ID } from "./paths.js";

const CAL_RE = /\[%cal\s+([^\]]+)\]/g;
const CSL_RE = /\[%csl\s+([^\]]+)\]/g;
const CEO_EVAL_RE = /\[%ceo-eval\s+([^\]]+)\]/g;
const ANY_CMD_RE = /\[%[a-z-]+\s+[^\]]+\]/g;

// Parse a `sf=+0.20/38` or `lc0=M-5/22` fragment into its numeric parts.
// Returns null if the value doesn't parse; the parser tolerates missing
// depth and mate notation.
function parseEngineEvalFragment(raw: string): StoredEngineEval | null {
  const m = raw.match(/^([+-]?)(?:M(-?\d+)|(\d+(?:\.\d+)?))(?:\/(\d+))?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const out: StoredEngineEval = {};
  if (m[2] !== undefined) {
    out.mate = sign * parseInt(m[2], 10);
  } else if (m[3] !== undefined) {
    // pawn units → centipawns
    out.cp = Math.round(sign * parseFloat(m[3]) * 100);
  } else {
    return null;
  }
  if (m[4] !== undefined) out.depth = parseInt(m[4], 10);
  return out;
}

// Parse a comment string, splitting out visual annotations + stored
// evals from prose.
export function parseCommentAnnotations(comment: string): {
  text: string;
  annotations?: PrepAnnotations;
  ceoEval?: StoredEval;
} {
  const arrows: PrepAnnotations["arrows"] = [];
  const highlights: PrepAnnotations["highlights"] = [];

  for (const m of comment.matchAll(CAL_RE)) {
    for (const entry of m[1].split(",")) {
      const e = entry.trim().match(/^([GCRBOY])([a-h][1-8])([a-h][1-8])$/i);
      if (e) arrows.push({ color: colorFromCode(e[1]), from: e[2].toLowerCase(), to: e[3].toLowerCase() });
    }
  }
  for (const m of comment.matchAll(CSL_RE)) {
    for (const entry of m[1].split(",")) {
      const e = entry.trim().match(/^([GCRBOY])([a-h][1-8])$/i);
      if (e) highlights.push({ color: colorFromCode(e[1]), square: e[2].toLowerCase() });
    }
  }

  let ceoEval: StoredEval | undefined;
  for (const m of comment.matchAll(CEO_EVAL_RE)) {
    const ev: StoredEval = ceoEval ?? {};
    for (const entry of m[1].trim().split(/\s+/)) {
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      const k = entry.slice(0, eq).toLowerCase();
      const v = entry.slice(eq + 1);
      if (k === "sf") {
        const parsed = parseEngineEvalFragment(v);
        if (parsed) ev.sf = parsed;
      } else if (k === "lc0") {
        const parsed = parseEngineEvalFragment(v);
        if (parsed) ev.lc0 = parsed;
      } else if (k === "nag") {
        if (/^\$\d+$/.test(v)) ev.nag = v;
      }
    }
    if (ev.sf || ev.lc0 || ev.nag) ceoEval = ev;
  }

  const text = comment.replace(ANY_CMD_RE, "").replace(/\s+/g, " ").trim();
  const annotations = arrows.length || highlights.length ? { arrows, highlights } : undefined;
  return { text, annotations, ceoEval };
}

// Parse full PGN → PrepFile. Throws on unrecoverable errors (no games,
// invalid starting FEN). Illegal SAN moves in the movetext are skipped
// silently — matches the frontend's tolerant behaviour so a game with
// one typo doesn't nuke the whole tree.
export function parsePGN(pgn: string): PrepFile {
  const games = parsePgn(pgn);
  if (games.length === 0) throw new Error("no games in PGN");
  const game = games[0];

  const tags: PrepTags = {};
  game.headers.forEach((value, key) => { tags[key] = value; });

  const startResult = startingPosition(game.headers);
  if (startResult.isErr) {
    throw new Error(`invalid starting position: ${startResult.error}`);
  }
  const startPos = startResult.value;

  const rootFen = makeFen(startPos.toSetup());
  const root: PrepNode = { id: ROOT_ID, san: null, fen: rootFen, ply: 0, children: [] };

  // Root-level comment on the game (rare, but supported).
  const gameComments = (game.moves as { comments?: string[] }).comments;
  if (gameComments && gameComments.length > 0) {
    const parsed = parseCommentAnnotations(gameComments.join(" "));
    if (parsed.text) root.comment = parsed.text;
    if (parsed.annotations) root.annotations = parsed.annotations;
    if (parsed.ceoEval) root.ceoEval = parsed.ceoEval;
  }

  const build = (childNode: any, treeParent: PrepNode, pos: Position, ply: number): void => {
    if (!childNode.data || typeof childNode.data.san !== "string") return;
    const san = childNode.data.san;

    let nodeFen: string;
    if (san === "--") {
      // Null move — flip side, clear en-passant.
      (pos as unknown as { turn: unknown; epSquare: unknown }).turn = opposite((pos as unknown as { turn: any }).turn);
      (pos as unknown as { epSquare: unknown }).epSquare = undefined;
      nodeFen = makeFen(pos.toSetup());
    } else {
      const move = parseSan(pos, san);
      if (!move) return; // skip illegal — chessops tolerates the rest of the tree
      pos.play(move);
      nodeFen = makeFen(pos.toSetup());
    }

    const node: PrepNode = {
      id: deriveNodeId(treeParent.id, san),
      san,
      fen: nodeFen,
      ply,
      children: [],
    };

    // Comment on this move (both "starting comments" attached to
    // variations and "after-move comments" — we fold both into the
    // node's own comment; the LLM doesn't need the PGN's positional
    // subtlety here).
    const combined: string[] = [];
    if (Array.isArray(childNode.data.startingComments)) combined.push(...childNode.data.startingComments);
    if (Array.isArray(childNode.data.comments)) combined.push(...childNode.data.comments);
    if (combined.length > 0) {
      const parsed = parseCommentAnnotations(combined.join(" "));
      if (parsed.text) node.comment = parsed.text;
      if (parsed.annotations) node.annotations = parsed.annotations;
      if (parsed.ceoEval) node.ceoEval = parsed.ceoEval;
    }

    if (Array.isArray(childNode.data.nags) && childNode.data.nags.length > 0) {
      node.nags = childNode.data.nags.map((n: number) => `$${n}`);
    }

    treeParent.children.push(node);

    for (const grandchild of childNode.children as any[]) {
      // chessops shares position state across siblings; we need a fresh
      // clone per variation branch.
      const forked = pos.clone();
      build(grandchild, node, forked, ply + 1);
    }
  };

  for (const child of game.moves.children as any[]) {
    const forked = startPos.clone();
    build(child, root, forked, 1);
  }

  return { tags, root };
}
