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
import { attacks } from "chessops/attacks";
import { makeSquare } from "chessops/util";
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
  castling: { white: string; black: string };
  epSquare: string | null;
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
    castling: { white: castlingW, black: castlingB },
    epSquare: typeof pos.epSquare === "number" ? makeSquare(pos.epSquare) : null,
  };
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
