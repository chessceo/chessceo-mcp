// describe_position — structured facts about a position that LLMs can't
// reliably read out of a FEN string on their own. Pure computation
// (chessops); no engine needed.
//
// Output covers piece placements, material balance in pawn units,
// attackers/defenders on every piece that is currently contested, a
// hanging list (attacked and undefended), checkers if in check, and
// castling / ep state. NOT covered: pins, discovered attacks, tactical
// patterns — those need the engine and are already available via
// cloud_analyse.

import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { attacks, pawnAttacks } from "chessops/attacks";
import { makeSquare, squareRank, squareFile } from "chessops/util";
import { makeSan } from "chessops/san";
import { SquareSet } from "chessops/squareSet";
import type { Square, Piece, Color, Role } from "chessops/types";

const ROLE_LETTER: Record<Role, string> = {
  pawn: "", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K",
};
// SAN convention: pawn is empty prefix. For inventory listings we use "P"
// so counts are readable.
const ROLE_LETTER_INV: Record<Role, string> = {
  pawn: "P", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K",
};
const ROLE_VALUE: Record<Role, number> = {
  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0,
};

type SidePieces = { P: number; N: number; B: number; R: number; Q: number; K: number };
type PieceEntry = { piece: string; square: string };
type Contested = {
  target: string;         // "Nc3", "e4"
  color: Color;
  attackers: string[];    // opposite-colour attackers, SAN-notated
  defenders: string[];    // same-colour defenders, SAN-notated
};

export type PositionDescription = {
  fen: string;
  sideToMove: Color;
  inCheck: boolean;
  checkers: string[];         // squares of pieces giving check (attackers of the king to move)
  material: {
    white: SidePieces;
    black: SidePieces;
    diff: number;             // white_value - black_value, in pawn units (king excluded)
    summary: string;          // e.g. "even (both 39)", "white +1 (39 vs 38)"
  };
  pieces: {
    white: PieceEntry[];
    black: PieceEntry[];
  };
  contested: Contested[];     // every piece that has at least one attacker
  hanging: {                  // attacked pieces with no defenders
    white: string[];
    black: string[];
  };
  // ── Structural analysis ────────────────────────────────────────────
  // Concepts a human sees at a glance but the LLM cannot derive from a
  // FEN string alone. Emitted as observations, not verdicts — the LLM
  // interprets in context.
  pawnStructure: {
    files: Record<string, "open" | "half_open_for_white" | "half_open_for_black" | "closed">;
    islandsWhite: number;      // count of connected pawn groups
    islandsBlack: number;
    isolated: { white: string[]; black: string[] };  // squares of isolated pawns
    doubled:  { white: string[]; black: string[] };  // files (a-h) with >1 own pawn
    passed:   { white: string[]; black: string[] };  // pawns with no enemy pawn same/adjacent file ahead
    backward: { white: string[]; black: string[] };  // pawns unable to advance safely, attacked
  };
  weakSquares: { white: string[]; black: string[] };  // "holes": squares in ranks 3-6 no friendly pawn can ever attack
  outposts: {
    // Friendly minor piece (N or B) sitting on a hole in enemy territory,
    // defended by own pawn. The classical positional gold-star square.
    white: Array<{ piece: string; square: string }>;
    black: Array<{ piece: string; square: string }>;
  };
  bishops: {
    // Own-pawns-on-bishop-colour count. Rough good/bad tag: <4 own pawns
    // on colour = good, >=5 = bad. Rule of thumb, not gospel.
    white: Array<{ square: string; colorSquare: "light" | "dark"; ownPawnsOnColor: number; quality: "good" | "mixed" | "bad" }>;
    black: Array<{ square: string; colorSquare: "light" | "dark"; ownPawnsOnColor: number; quality: "good" | "mixed" | "bad" }>;
    pair: { white: boolean; black: boolean };
  };
  space: {
    // Squares in the enemy half (ranks 5-8 for White, 1-4 for Black)
    // controlled by side's pieces/pawns. Rough "how much room do I have".
    whiteSquaresInBlackHalf: number;
    blackSquaresInWhiteHalf: number;
  };
  castling: { white: string; black: string };
  epSquare: string | null;
  legalMoves: string[];       // every legal move for sideToMove, SAN-notated, sorted
};

function pieceSAN(piece: Piece, sq: Square): string {
  return `${ROLE_LETTER[piece.role]}${makeSquare(sq)}`;
}

export function describePosition(fen: string): PositionDescription {
  const setup = parseFen(fen);
  if (setup.isErr) throw new Error(`bad fen: ${setup.error}`);
  const posResult = Chess.fromSetup(setup.value);
  if (posResult.isErr) throw new Error(`bad position: ${posResult.error}`);
  const pos = posResult.value;
  const board = pos.board;

  const whitePieces: PieceEntry[] = [];
  const blackPieces: PieceEntry[] = [];
  const materialW: SidePieces = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0 };
  const materialB: SidePieces = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0 };

  for (const [sq, piece] of board) {
    const invLetter = ROLE_LETTER_INV[piece.role];
    const entry: PieceEntry = { piece: invLetter, square: makeSquare(sq) };
    if (piece.color === "white") {
      whitePieces.push(entry);
      materialW[invLetter as keyof SidePieces]++;
    } else {
      blackPieces.push(entry);
      materialB[invLetter as keyof SidePieces]++;
    }
  }
  whitePieces.sort(pieceSortKey);
  blackPieces.sort(pieceSortKey);

  const wValue = pieceValueSum(materialW);
  const bValue = pieceValueSum(materialB);
  const diff = wValue - bValue;
  const summary =
    diff === 0 ? `even (both ${wValue})` :
    diff > 0  ? `white +${diff} (${wValue} vs ${bValue})` :
    `black +${-diff} (${wValue} vs ${bValue})`;

  // Contested + hanging computation: for every piece, find who attacks
  // it and who defends it. attacks() returns the squares a piece
  // controls given the occupied board — we invert it into "attackers-of"
  // by iterating all pieces once and testing membership.
  const contested: Contested[] = [];
  const hangingWhite: string[] = [];
  const hangingBlack: string[] = [];
  for (const [sq, piece] of board) {
    const both = attackersOf(pos, sq);
    const oppSide: Color = piece.color === "white" ? "black" : "white";
    const attackers = both[oppSide];
    const defenders = both[piece.color];
    if (attackers.length === 0) continue;
    const targetName = pieceSAN(piece, sq);
    contested.push({
      target: targetName,
      color: piece.color,
      attackers: attackers.map(a => pieceSANFromBoard(board, a)),
      defenders: defenders.map(d => pieceSANFromBoard(board, d)),
    });
    if (defenders.length === 0) {
      if (piece.color === "white") hangingWhite.push(targetName);
      else hangingBlack.push(targetName);
    }
  }
  // Order contested by target square for stable output the LLM can
  // scan.
  contested.sort((a, b) => a.target.slice(-2).localeCompare(b.target.slice(-2)));

  // Castling rights encoded in the standard FEN letters (KQkq).
  const castlingW = castlingLetters(pos, "white");
  const castlingB = castlingLetters(pos, "black");

  const checkers: string[] = [];
  const ctx = pos.ctx();
  for (const sq of ctx.checkers) checkers.push(pieceSANFromBoard(board, sq));

  const legalMoves = generateLegalMoves(pos);

  const structural = computeStructural(pos);

  return {
    fen,
    sideToMove: pos.turn,
    inCheck: pos.isCheck(),
    checkers,
    material: {
      white: materialW,
      black: materialB,
      diff,
      summary,
    },
    pieces: { white: whitePieces, black: blackPieces },
    contested,
    hanging: { white: hangingWhite, black: hangingBlack },
    pawnStructure: structural.pawnStructure,
    weakSquares: structural.weakSquares,
    outposts: structural.outposts,
    bishops: structural.bishops,
    space: structural.space,
    castling: { white: castlingW, black: castlingB },
    epSquare: typeof pos.epSquare === "number" ? makeSquare(pos.epSquare) : null,
    legalMoves,
  };
}

// ── Structural analysis ──────────────────────────────────────────────
// Concepts a human sees at a glance but the LLM cannot derive from a
// FEN. All chess-primitive computations on top of chessops bitboards;
// no engine.

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

// Which files are occupied by pawns of each colour (bitmask, 8 bits).
function pawnFilesMask(pos: Chess, color: Color): number {
  let mask = 0;
  for (const sq of pos.board.pawn.intersect(pos.board[color])) {
    mask |= 1 << squareFile(sq);
  }
  return mask;
}

function computeStructural(pos: Chess) {
  const whitePawns = pos.board.pawn.intersect(pos.board.white);
  const blackPawns = pos.board.pawn.intersect(pos.board.black);
  const wFileMask = pawnFilesMask(pos, "white");
  const bFileMask = pawnFilesMask(pos, "black");

  // File status per column.
  const files: Record<string, "open" | "half_open_for_white" | "half_open_for_black" | "closed"> = {};
  for (let f = 0; f < 8; f++) {
    const wHas = (wFileMask & (1 << f)) !== 0;
    const bHas = (bFileMask & (1 << f)) !== 0;
    if (!wHas && !bHas) files[FILES[f]] = "open";
    else if (!bHas && wHas) files[FILES[f]] = "half_open_for_black"; // black has no pawn → open for black's rooks
    else if (!wHas && bHas) files[FILES[f]] = "half_open_for_white";
    else files[FILES[f]] = "closed";
  }

  // Islands: count runs of consecutive occupied files.
  const countIslands = (mask: number) => {
    let count = 0, prev = false;
    for (let f = 0; f < 8; f++) {
      const has = (mask & (1 << f)) !== 0;
      if (has && !prev) count++;
      prev = has;
    }
    return count;
  };

  // Isolated pawns: own pawn with no friend on adjacent files.
  const isolated = (color: Color) => {
    const mask = color === "white" ? wFileMask : bFileMask;
    const own = color === "white" ? whitePawns : blackPawns;
    const out: string[] = [];
    for (const sq of own) {
      const f = squareFile(sq);
      const left = f > 0 && ((mask >> (f - 1)) & 1);
      const right = f < 7 && ((mask >> (f + 1)) & 1);
      if (!left && !right) out.push(makeSquare(sq));
    }
    return out.sort();
  };

  // Doubled: files with >1 own pawn.
  const doubled = (color: Color) => {
    const counts: Record<number, number> = {};
    const own = color === "white" ? whitePawns : blackPawns;
    for (const sq of own) {
      const f = squareFile(sq);
      counts[f] = (counts[f] || 0) + 1;
    }
    return Object.entries(counts).filter(([, c]) => c > 1).map(([f]) => FILES[Number(f)]).sort();
  };

  // Passed pawns: no enemy pawn on same or adjacent file ahead of it.
  const passed = (color: Color) => {
    const own = color === "white" ? whitePawns : blackPawns;
    const enemyMask = color === "white" ? bFileMask : wFileMask;
    const enemyPawns = color === "white" ? blackPawns : whitePawns;
    const out: string[] = [];
    for (const sq of own) {
      const f = squareFile(sq);
      const r = squareRank(sq);
      let blocked = false;
      for (const ef of [f - 1, f, f + 1]) {
        if (ef < 0 || ef > 7) continue;
        if (((enemyMask >> ef) & 1) === 0) continue;
        // any enemy pawn on this file ahead of us?
        for (const esq of enemyPawns) {
          if (squareFile(esq) !== ef) continue;
          const er = squareRank(esq);
          if (color === "white" ? er > r : er < r) { blocked = true; break; }
        }
        if (blocked) break;
      }
      if (!blocked) out.push(makeSquare(sq));
    }
    return out.sort();
  };

  // Backward: own pawn attacked by enemy pawn, unable to safely advance
  // (advance square attacked by enemy pawn and undefended by own pawn).
  const backward = (color: Color) => {
    const own = color === "white" ? whitePawns : blackPawns;
    const dir = color === "white" ? 8 : -8;
    const enemyColor: Color = color === "white" ? "black" : "white";
    const out: string[] = [];
    for (const sq of own) {
      const advanceSq = (sq + dir) as Square;
      if (advanceSq < 0 || advanceSq > 63) continue;
      // Attacked by enemy pawn?
      const enemyAttackers = pawnAttacks(enemyColor, advanceSq).intersect(pos.board.pawn).intersect(pos.board[enemyColor]);
      if (enemyAttackers.isEmpty()) continue;
      // Defended by own pawn?
      const ownDefenders = pawnAttacks(color, advanceSq).intersect(pos.board.pawn).intersect(pos.board[color]);
      if (ownDefenders.nonEmpty()) continue;
      out.push(makeSquare(sq));
    }
    return out.sort();
  };

  // Weak squares (holes): squares in ranks 3-6 that no friendly pawn can
  // ever attack. For White the "own attack" is a pawn on rank-1 diagonal
  // behind (files ±1). We check every square in the middle four ranks.
  const weakSquares = (color: Color) => {
    const own = color === "white" ? whitePawns : blackPawns;
    const ownMask = color === "white" ? wFileMask : bFileMask;
    const out: string[] = [];
    const rankRange = color === "white" ? [3, 4, 5] : [2, 3, 4]; // 0-indexed 4,5,6 / 3,4,5 in real ranks
    for (const r of rankRange) {
      for (let f = 0; f < 8; f++) {
        const sq = (r * 8 + f) as Square;
        // Any friendly pawn on adjacent files that could ever attack this square?
        // For White, an attack on square (f,r) comes from (f±1, r-1);
        // any pawn on those adjacent files with rank < r could eventually reach.
        let canBeAttacked = false;
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          if (((ownMask >> nf) & 1) === 0) continue;
          // Any pawn on this file at a rank behind the target?
          for (const psq of own) {
            if (squareFile(psq) !== nf) continue;
            const pr = squareRank(psq);
            if (color === "white" ? pr < r : pr > r) { canBeAttacked = true; break; }
          }
          if (canBeAttacked) break;
        }
        if (!canBeAttacked) out.push(makeSquare(sq));
      }
    }
    return out.sort();
  };

  const wWeak = weakSquares("white");
  const bWeak = weakSquares("black");
  const wWeakSet = new Set(wWeak);
  const bWeakSet = new Set(bWeak);

  // Outposts: friendly N/B on a hole (WEAKNESS of the enemy) in enemy
  // territory, defended by an own pawn.
  const outposts = (color: Color) => {
    const enemyWeak = color === "white" ? bWeakSet : wWeakSet;
    const own = pos.board[color];
    const out: Array<{ piece: string; square: string }> = [];
    for (const sq of own) {
      const piece = pos.board.get(sq);
      if (!piece || (piece.role !== "knight" && piece.role !== "bishop")) continue;
      const sqName = makeSquare(sq);
      if (!enemyWeak.has(sqName)) continue;
      // Defended by own pawn?
      const enemyColor: Color = color === "white" ? "black" : "white";
      // A pawn defending sq for `color` = pawn one rank behind on adjacent file.
      const defenders = pawnAttacks(enemyColor, sq).intersect(pos.board.pawn).intersect(pos.board[color]);
      if (defenders.isEmpty()) continue;
      out.push({ piece: ROLE_LETTER_INV[piece.role], square: sqName });
    }
    return out.sort((a, b) => a.square.localeCompare(b.square));
  };

  // Bishops: quality based on own pawns on the bishop's colour.
  const bishopColor = (sq: Square): "light" | "dark" => {
    // a1 is dark, b1 is light. (file+rank) even = dark.
    return (squareFile(sq) + squareRank(sq)) % 2 === 0 ? "dark" : "light";
  };
  const bishops = (color: Color) => {
    const own = pos.board.bishop.intersect(pos.board[color]);
    const ownPawns = color === "white" ? whitePawns : blackPawns;
    let pawnsLight = 0, pawnsDark = 0;
    for (const p of ownPawns) {
      if (bishopColor(p) === "light") pawnsLight++;
      else pawnsDark++;
    }
    const out: Array<{ square: string; colorSquare: "light" | "dark"; ownPawnsOnColor: number; quality: "good" | "mixed" | "bad" }> = [];
    for (const sq of own) {
      const c = bishopColor(sq);
      const onColor = c === "light" ? pawnsLight : pawnsDark;
      const q = onColor <= 3 ? "good" : onColor >= 5 ? "bad" : "mixed";
      out.push({ square: makeSquare(sq), colorSquare: c, ownPawnsOnColor: onColor, quality: q });
    }
    return out;
  };

  // Space: squares in the enemy half controlled by side's pieces + pawns.
  const space = (color: Color) => {
    const attackedByColor = SquareSet.empty();
    let acc = attackedByColor;
    for (const sq of pos.board[color]) {
      const piece = pos.board.get(sq)!;
      acc = acc.union(attacks(piece, sq, pos.board.occupied));
    }
    // Enemy half: white attacks ranks 5-8 (rank index 4-7); black attacks 1-4 (0-3).
    let count = 0;
    for (const sq of acc) {
      const r = squareRank(sq);
      if (color === "white" && r >= 4) count++;
      else if (color === "black" && r <= 3) count++;
    }
    return count;
  };

  return {
    pawnStructure: {
      files,
      islandsWhite: countIslands(wFileMask),
      islandsBlack: countIslands(bFileMask),
      isolated: { white: isolated("white"), black: isolated("black") },
      doubled: { white: doubled("white"), black: doubled("black") },
      passed: { white: passed("white"), black: passed("black") },
      backward: { white: backward("white"), black: backward("black") },
    },
    weakSquares: { white: wWeak, black: bWeak },
    outposts: { white: outposts("white"), black: outposts("black") },
    bishops: {
      white: bishops("white"),
      black: bishops("black"),
      pair: {
        white: pos.board.bishop.intersect(pos.board.white).size() >= 2,
        black: pos.board.bishop.intersect(pos.board.black).size() >= 2,
      },
    },
    space: {
      whiteSquaresInBlackHalf: space("white"),
      blackSquaresInWhiteHalf: space("black"),
    },
  };
}

// All legal moves for the side to move, in SAN. Sorted for stable output.
// Handles promotion by expanding each pawn-promotion destination into
// the four promotion pieces (=Q, =R, =B, =N).
function generateLegalMoves(pos: Chess): string[] {
  const out: string[] = [];
  for (const [from, piece] of pos.board) {
    if (piece.color !== pos.turn) continue;
    const dests = pos.dests(from);
    for (const to of dests) {
      const isPromotion =
        piece.role === "pawn" &&
        ((piece.color === "white" && squareRank(to) === 7) ||
         (piece.color === "black" && squareRank(to) === 0));
      if (isPromotion) {
        for (const promo of ["queen", "rook", "bishop", "knight"] as Role[]) {
          const san = makeSan(pos, { from, to, promotion: promo });
          if (san) out.push(san);
        }
      } else {
        const san = makeSan(pos, { from, to });
        if (san) out.push(san);
      }
    }
  }
  return out.sort();
}

// Attackers-of a square, split by colour. A piece cannot attack its own
// square, so we skip the target index. The `occupied` for sliding
// pieces is the whole board minus nothing — chessops's `attacks()`
// takes care of blockers.
function attackersOf(pos: Chess, target: Square): { white: Square[]; black: Square[] } {
  const white: Square[] = [];
  const black: Square[] = [];
  for (const [sq, piece] of pos.board) {
    if (sq === target) continue;
    const set = attacks(piece, sq, pos.board.occupied);
    if (set.has(target)) {
      if (piece.color === "white") white.push(sq);
      else black.push(sq);
    }
  }
  return { white, black };
}

function pieceSANFromBoard(board: Chess["board"], sq: Square): string {
  const piece = board.get(sq);
  if (!piece) return makeSquare(sq);
  return pieceSAN(piece, sq);
}

// Sort: kings first, then queens, rooks, bishops, knights, pawns; within
// each type, by rank descending then file ascending. Matches the visual
// scan a human does.
const ROLE_ORDER: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];
function pieceSortKey(a: PieceEntry, b: PieceEntry): number {
  const roleA = roleOfEntry(a);
  const roleB = roleOfEntry(b);
  const orderA = ROLE_ORDER.indexOf(roleA);
  const orderB = ROLE_ORDER.indexOf(roleB);
  if (orderA !== orderB) return orderA - orderB;
  return a.square.localeCompare(b.square);
}
function roleOfEntry(e: PieceEntry): Role {
  switch (e.piece) {
    case "K": return "king";
    case "Q": return "queen";
    case "R": return "rook";
    case "B": return "bishop";
    case "N": return "knight";
    default:  return "pawn";
  }
}

function pieceValueSum(m: SidePieces): number {
  return m.P * ROLE_VALUE.pawn +
         m.N * ROLE_VALUE.knight +
         m.B * ROLE_VALUE.bishop +
         m.R * ROLE_VALUE.rook +
         m.Q * ROLE_VALUE.queen;
}

// Convert chessops castling representation to the standard FEN-letter
// form for the given color: "K" (kingside), "Q" (queenside), "KQ",
// or "" if none remain.
function castlingLetters(pos: Chess, color: Color): string {
  let out = "";
  const castles = pos.castles;
  // castles.rooksSideOf(color, 'a') and .rooksSideOf(color, 'h') return
  // the rook square or undefined per side. Fall back to inspecting the
  // stored castling squares — chessops's public API varies by version.
  const rooks = (castles as unknown as { rook: { white: { a: unknown; h: unknown }; black: { a: unknown; h: unknown } } }).rook;
  if (rooks?.[color]?.h !== undefined) out += color === "white" ? "K" : "k";
  if (rooks?.[color]?.a !== undefined) out += color === "white" ? "Q" : "q";
  return out;
}
