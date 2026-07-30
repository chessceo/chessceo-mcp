// Anti-pattern scanners for LLM output + session-level tracking that
// drives them. Every function returns either a string (the warning to
// surface on the LLM's next tool response) or undefined (the mutation
// looked fine). Callers append to a `warnings: string[]` field on the
// response the LLM sees.
//
// Extracted from index.ts in v0.44. All prior v0.42/v0.42.1 behaviour
// preserved bit-for-bit — this is a file split, not a rewrite.

import { positionKey } from "./pgn/paths.js";
import { ROOT_ID } from "./pgn/paths.js";
import type { PrepNode } from "./pgn/types.js";

// ── Session tracking sets ──────────────────────────────────────────
//
// Every one of these is per-process-lifetime memory (i.e. per-session
// for stdio callers; per-server-instance for streamable-http). Not
// persisted; a fresh MCP server starts empty. One MCP server process
// per user in the common stdio case, so these are effectively per-user.

// Positions the LLM has asked the DB about via `get_position_stats`.
// Keyed by the 3-field FEN (piece placement + side to move + castling —
// same key used for transposition detection). Used to warn on `add_move`
// / `add_line` under a parent the LLM never DB-checked, which is the
// exact shape of the bug where the LLM read course chapters and
// cargo-culted a "mainline" that the actual games at the position don't
// play.
export const positionsStatsChecked = new Set<string>();
// Nodes we've ALREADY warned on for the "no stats check" pattern this
// session, so repeated adds under the same parent don't spam the LLM.
export const noStatsWarned = new Set<string>();

// Positions the LLM has called `describe_position` on. Same 3-field FEN
// key. Live-log audit (2026-07-27 Modern Defence session): 13
// describe_position calls vs 50+ set_comment ops — most comments were
// written blind. When describe_position IS called before commentary,
// prose accuracy jumps sharply.
export const positionsDescribed = new Set<string>();
// Once-per-node dedup for the describe warning.
export const noDescribeWarned = new Set<string>();

// ── Scanners ───────────────────────────────────────────────────────

// Detect the anti-patterns the LLM keeps producing in comment prose.
// All of these restate what the app already renders elsewhere:
//   - spread lists ("5.O-O ≈50, 6.h3 ≈42, ...")
//   - raw centipawn values in prose ("≈-60", "+0.35", "at depth 24")
//   - long roster restatement ("146 GM games, Nakamura, Kramnik, MVL")
// Return an array of warning strings — one per matched category — so the
// LLM sees exactly which pattern to remove.
export function commentAntiPatterns(comment: string): string[] {
  if (!comment || typeof comment !== "string") return [];
  const warns: string[] = [];

  // Spread list: ≈ followed by a 2-3-digit number, appearing 2+ times
  // (one appearance is a stray, two+ is a comma-separated spread the LLM
  // pasted from stats output).
  const spreadMatches = comment.match(/≈\s*[+\-−]?\d{1,3}/g) ?? [];
  if (spreadMatches.length >= 2) {
    warns.push("comment contains a spread list (≈ + counts) — the DB viewer already shows sibling counts and fashion scores next to every move, so this is doubled noise. Name the character of the choice instead (\"solid vs sharp\", \"old vs fashionable\") or drop the numbers.");
  }

  // Raw centipawn in prose: "+0.35", "-0.20", "+80" (not preceded by move
  // number). Also "at depth N" or "N nodes" — engine metadata as prose.
  //
  // ceoEval itself is NOT rendered — it's LLM-internal state. But raw cp
  // values in prose are still bad for a different reason: they're opaque
  // decoration. "≈-60" gives the reader no chess signal without knowing
  // the unit (centipawns? spread rank? pawns?) and no scale (is -60
  // slight, meaningful, or losing?). The NAG glyph IS visible and is
  // the intended channel for that judgment — one ⩱ conveys what "-60"
  // fails to convey. Engine metadata like "at depth 24" or "259M nodes"
  // is even weaker: it's process detail, not a claim about the position.
  if (/(?:^|[^\d.])[+-]\d\.\d\d(?!\d)/.test(comment) || /≈\s*[+\-−]?\d{2,3}\b/.test(comment) ||
      /\bat depth \d+\b/i.test(comment) || /\b\d{2,3}M nodes\b/.test(comment)) {
    warns.push("comment contains raw centipawn values or engine metadata — these are opaque to the reader (no clear unit or scale) and the intended channel for the position-quality signal is the NAG glyph, which IS rendered. Set the NAG (set_nags) at the variation's endpoint and let the glyph carry the judgment; drop the number and any \"at depth N\" / \"N nodes\" fragments from the prose.");
  }

  // Roster: "N GM games" pattern
  if (/\b\d{2,4}\s+GM games\b/i.test(comment)) {
    warns.push("comment restates game count — the app shows the count on hover. Either cite a specific game with signal (\"Caruana-Liang, Superbet 2026\") or drop the number.");
  }

  return warns;
}

// Return a warning string when an add_line is suspiciously long-and-linear
// (the anti-pattern: LLM pastes a 15-ply engine PV into a single add_line
// call as if it were prepared repertoire). Two thresholds so the message
// escalates — a 10-ply Berlin mainline is fine, a 20-ply LLM extrapolation
// almost never is. Threshold applies at the CALL level, not against
// existing tree depth — the anti-pattern is a single tool call adding
// many plies at once with no user thought about where the branching should
// live.
export function longLineWarning(sansLength: number): string | undefined {
  if (sansLength >= 14) {
    return `you added ${sansLength} plies in one call without branching — this is the shape of a pasted engine PV, not a repertoire. Real prep branches at every ply where the opponent has meaningful alternatives. Either (a) delete the tail and rebuild with add_move at each decision point, calling cloud_analyse + get_position_stats to see what actually gets played, or (b) if this really is one forcing sequence (mate combination, tactical winner), add a comment naming what makes it forced. Long unbranched lines with no comment default to "engine PV pasted as prep" in the reader's eyes.`;
  }
  if (sansLength >= 9) {
    return `${sansLength}-ply linear line — check that every ply is a genuine only-move or a documented mainline. If the opponent has real alternatives at any ply (get_position_stats would show 2+ moves with meaningful frequency), that ply should branch instead. Prep is a tree, not a line.`;
  }
  return undefined;
}

// Compute the "you never called describe_position on this node" warning.
// Fires from set_comment when the comment is substantive (>= 40 chars —
// anything shorter is a label / pointer, doesn't need structural
// grounding). LLMs are unreliable at reading FEN strings and confidently
// describe positions that don't match the actual board; describe_position
// is a pure-computation grounding pass that reliably fixes this. Warn
// once per node.
export function noDescribeWarning(node: PrepNode, comment: string): string | undefined {
  if (node.id === ROOT_ID) return undefined;
  if (comment.length < 40) return undefined;
  const key = positionKey(node.fen);
  if (positionsDescribed.has(key)) return undefined;
  if (noDescribeWarned.has(node.id)) return undefined;
  noDescribeWarned.add(node.id);
  return `substantive comment (${comment.length} chars) on a node whose position was never grounded via describe_position this session (id=${node.id}, ${node.san}). LLMs invent captures, miscount pieces, and swap files/ranks when reading FEN strings — describe_position is a pure-computation pass (~1 ms, no engine cost, structural facts + Stockfish's per-term eval breakdown) that reliably prevents this class of hallucination. In live audits, prose accuracy jumps sharply on nodes where describe_position was called first. Call describe_position with file_id+node_id=${node.id} BEFORE writing prose. Warned once per node.`;
}

// Position NAGs on intermediate moves ("everything is ⩲" spam).
//
// Position NAGs — `$10` = / `$11` = / `$13` ∞ / `$14` ⩲ / `$15` ⩱ /
// `$16` ± / `$17` ∓ / `$18` +− / `$19` −+ — are visible glyphs on the
// move. They belong at variation ENDPOINTS: the reader plays through
// a line and, at the end, wants to know "so where did we land?"
// Tagging every mainline move with `$14` (routine slight White edge)
// turns the movetext into a wall of ⩲ symbols the reader skims past;
// it also pre-empts the walk-through by hard-coding the verdict at
// every step. The single leaf NAG carries the same information with
// none of the noise.
//
// Real-world case (Ruy Lopez Bc5 file, 2026-07-30): `$14` set on ~15
// mainline nodes plus 10+ intermediate move-choice nodes. Nothing
// signaled where the variation actually converged.
//
// Rule this warning encodes: position NAGs on non-leaf nodes are
// almost always noise. Move-quality NAGs — `$1` !, `$2` ?, `$3` !!,
// `$4` ??, `$5` !?, `$6` ?!, and `$146` novelty — are FINE at any
// depth because they're statements about the MOVE, not the resulting
// position. Warned once per node.
const positionalNagWarned = new Set<string>();
export function positionalNagOnIntermediateWarning(node: PrepNode, nags: string[]): string | undefined {
  const positional = new Set(["$10", "$11", "$12", "$13", "$14", "$15", "$16", "$17", "$18", "$19"]);
  const hit = nags.filter(n => positional.has(n));
  if (hit.length === 0) return undefined;
  if (node.children.length === 0) return undefined; // leaf — legitimate placement
  if (positionalNagWarned.has(node.id)) return undefined;
  positionalNagWarned.add(node.id);
  return `positional NAG ${hit.join(" ")} set on a non-leaf node (id=${node.id}, ${node.san}, ${node.children.length} children). Position NAGs (=, ⩲, ±, +−) belong at variation ENDPOINTS — the reader plays through the line and at the leaf wants to know how it lands. Marking every intermediate move with the same ⩲ turns the movetext into visual noise the eye skims past AND pre-empts the walk-through. Either move this NAG to the leaf, drop it entirely, or leave it only if THIS specific move is the one that tipped the balance (rare, and worth prose). Move-quality NAGs on intermediate moves — !, ?, !?, ?!, $146 novelty — are FINE, because they're statements about the move not the resulting position. Warned once per node.`;
}

// Compute the "you never DB-checked this parent" warning. Called from
// add_move / add_line handlers with the parent node. Returns undefined
// when either (a) the parent was checked this session (or is root — the
// starting position doesn't need a DB check), (b) we already warned on
// this parent (dedup so building a big branching subtree isn't spammy),
// or (c) the mutator is running against a parent whose position has a
// stored ceoEval (implies the LLM has done SOME analytical work here).
export function noStatsCheckWarning(parent: PrepNode): string | undefined {
  if (parent.id === ROOT_ID) return undefined;
  const key = positionKey(parent.fen);
  if (positionsStatsChecked.has(key)) return undefined;
  if (noStatsWarned.has(parent.id)) return undefined;
  noStatsWarned.add(parent.id);
  return `no get_position_stats call for the parent (id=${parent.id}, ${parent.san}) this session. Course chapter titles describe what an author chose to cover, not what practical opponents play — treating "the So chapter says 6.O-O-O" as "the mainline is 6.O-O-O" is the exact pattern this warning exists to catch. Call get_position_stats at this position (via file_id+node_id=${parent.id}) BEFORE deciding which branches belong here; suppress this warning by making that call. Warned once per parent per session.`;
}
