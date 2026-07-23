// Compact tree types the LLM works with. No stable ids — chessops
// regenerates them per parse — so we address nodes by PATH: the array
// of child indices from the root. [] is the root, [0] is root's first
// child, [0, 1] is the second child of the first child, etc.
//
// Paths ARE stable across parse/export/reparse cycles because move
// order is deterministic and we don't rearrange children on export.

export type PrepArrow = { color: string; from: string; to: string };
export type PrepHighlight = { color: string; square: string };
export type PrepAnnotations = { arrows: PrepArrow[]; highlights: PrepHighlight[] };

export type PrepNode = {
  san: string | null;        // null for root
  fen: string;
  ply: number;               // 0 for root; +1 per ply
  comment?: string;          // plain text with [%cal]/[%csl] STRIPPED — annotations live below
  nags?: string[];           // e.g. ["$1", "$14"]
  annotations?: PrepAnnotations;
  children: PrepNode[];      // children[0] is the mainline continuation
};

export type PrepTags = Record<string, string>;

export type PrepFile = {
  tags: PrepTags;
  root: PrepNode;
};

// Path: array of child indices from root. Empty = root itself.
export type Path = number[];

// Named colours as they appear in the parsed tree. The wire format uses
// single-letter codes (G, R, Y, C, B, O); the tree uses these longer
// names to match how the frontend represents them.
export const COLOR_NAMES = ["green", "red", "yellow", "light-blue", "dark-blue", "orange"] as const;
export type ColorName = typeof COLOR_NAMES[number];

const COLOR_CODE_TO_NAME: Record<string, ColorName> = {
  G: "green", R: "red", Y: "yellow", C: "light-blue", B: "dark-blue", O: "orange",
};
const COLOR_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_CODE_TO_NAME).map(([code, name]) => [name, code]),
);

export function colorFromCode(code: string): ColorName {
  return COLOR_CODE_TO_NAME[code.toUpperCase()] ?? "green";
}
export function codeFromColor(color: string): string {
  return COLOR_NAME_TO_CODE[color] ?? "G";
}
