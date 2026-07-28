// Response shape transformations applied to backend payloads before
// they reach the LLM. Two responsibilities:
//   - Drop internal / debug-only fields the LLM doesn't need
//     (`hash`, `plyNumber`, `relevance`, etc.).
//   - Rewrite backend jargon into LLM-friendly names
//     (`transpositions` → `reachedViaTransposition`, `hotness` →
//     `fashionScore`, UCI moves → SAN).
//
// Plus a couple of tool-input adapters that also live here for lack of
// a better home:
//   - `trimMovesToPly` (used by trimGamesMovetext, exported for reuse).
//   - `normalizeSourceForBackend` (prepare_opponent request adapter).
//
// Extracted from index.ts in v0.44 as part of the file split.

import { uciMoveToSAN } from "./analysis/response.js";

// Strip cruft the LLM doesn't need from the DB-position response.
// Called AFTER trimGamesMovetext so plyNumber survives long enough to
// slice each game's movetext. Also renames the `transpositions` field
// to something the LLM can parse without knowing chess-DB jargon.
export function stripPositionResponse(r: unknown): void {
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
export function trimGamesMovetext(response: unknown): void {
  if (!response || typeof response !== "object") return;
  const r = response as { games?: Array<{ moves?: string; plyNumber?: number; totalPly?: number; ply?: number }> };
  if (!Array.isArray(r.games)) return;
  for (const g of r.games) {
    if (typeof g.moves === "string" && typeof g.plyNumber === "number" && g.plyNumber > 0) {
      g.moves = trimMovesToPly(g.moves, g.plyNumber);
    }
  }
}

export function trimMovesToPly(moves: string, plyNumber: number): string {
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
export function convertAvailableMovesToSAN(raw: unknown, fen: string): unknown {
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

// Normalize one MCP `prepare_opponent` source into the shape the backend's
// /api/chess/prep/prepare-multi expects. Handles two impedance mismatches:
//   - snake_case → camelCase (fide_id → fideId, start_month → startMonth, etc.)
//   - the unified `time_control` string → per-source-type filter:
//       * fide / chesscom → timeFormats: ["Classical" | "Rapid" | "Blitz"]
//       * lichess → perfType: "classical" | "rapid" | "blitz" | "bullet"
// Backend validates required fields per source type, so we don't need to
// pre-reject missing username/fideId here — it'll come back as a 400 the
// LLM can act on.
export function normalizeSourceForBackend(src: Record<string, unknown>, idx: number): Record<string, unknown> {
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
