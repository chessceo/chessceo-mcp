// Shared engine-response helpers used across cloud_analyse, auto_evaluate,
// deep_analyse, and get_position_stats. All PGN-shape data comes back
// from the backend in UCI ("g1f3") — this module converts to SAN, extracts
// stored evals from the raw JSON, and derives the eval → NAG mapping.
//
// Extracted from src/index.ts in v0.44 as part of the file split.

import { Chess } from "chess.js";
import type { StoredEngineEval, StoredEval } from "../pgn/types.js";
import { authedRequest } from "../http.js";

// Compact eval attached to per-position responses (get_position_stats,
// prep_snapshot, etc.) so the LLM sees the stockfish + lc0 read without
// a separate cloud_analyse call. `nag` is the threshold-derived glyph
// (see nagFromCp) — the LLM can promote it to a visible NAG on the
// node via set_nags if it carries editorial signal.
export type CompactEval = {
  nag: string | null;
  stockfish?: { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
  lc0?:       { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
};

// One engine's slice of the cloud_analyse response — the lines[] array
// plus a bestMove. `pv` is what capPvsInResponse trims and
// convertCloudSnapshotResponse converts UCI→SAN.
export type EngineBlock = {
  lines?: Array<{ pv?: string[] }>;
  bestMove?: string;
};

// Convert a UCI move sequence into SAN by walking it move-by-move on
// chess.js from the given starting FEN. LLMs reason far better in SAN
// ("Nf3", "Bxc4") than UCI ("g1f3", "b5c4"), and matches how prep
// discussion is written in the real world. If a move fails to parse
// (illegal from the current position — bug or truncated PV), we
// truncate cleanly rather than throwing so the response still carries
// what we could convert.
export function uciLineToSAN(startFen: string, uciMoves: string[]): string[] {
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

export function uciMoveToSAN(startFen: string, uci: string): string {
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
export async function fetchCompactEval(fen: string): Promise<CompactEval | null> {
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
export function capPvsInResponse(converted: unknown, maxPlies: number): void {
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

export function convertCloudSnapshotResponse(raw: unknown, startFen: string): unknown {
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

export function analysisToStoredEval(analysis: unknown): StoredEval | null {
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

export function nagFromCp(cp?: number, mate?: number): string | null {
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
export function storedEvalToCompact(ev: StoredEval | null, analysis: unknown): CompactEval | null {
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
