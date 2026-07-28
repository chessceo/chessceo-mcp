// PrepFile → PGN text. Deterministic — same tree always exports to the
// same PGN modulo whitespace, so paths stay stable across
// export→reparse cycles.

import { codeFromColor, type PrepFile, type PrepNode, type StoredEngineEval, type StoredEval } from "./types.js";

// Standard PGN "seven tag roster" order. We emit these first (in the
// order they appear in tags), then any extra tags in insertion order.
const STR_ORDER = ["Event", "Site", "Date", "Round", "White", "Black", "Result"];

export function exportPGN(file: PrepFile): string {
  const parts: string[] = [];

  // Tag pairs. Ensure the seven-tag roster is present with sane
  // defaults; other tags come after in whatever order the map yields.
  const emittedTags = new Set<string>();
  const withDefaults: [string, string][] = STR_ORDER.map(k => {
    const value = file.tags[k];
    emittedTags.add(k);
    return [k, value ?? defaultTagValue(k)];
  });
  for (const [k, v] of Object.entries(file.tags)) {
    if (emittedTags.has(k)) continue;
    withDefaults.push([k, v]);
    emittedTags.add(k);
  }
  for (const [k, v] of withDefaults) {
    parts.push(`[${k} "${escapeTagValue(v)}"]`);
  }
  parts.push(""); // blank line between headers and movetext

  // Movetext. Root can carry a text comment AND visual annotations
  // AND a stored eval — all rendered in a single {…} block before the
  // first move so the parser's regexes pick them all up on re-parse.
  // (v0.46 fix: previously only the visual/eval annotation was emitted
  // and it went out unbraced — a plain comment set on the root via
  // set_comment silently disappeared during export.)
  const rootPreludeBits: string[] = [];
  if (file.root.comment && file.root.comment.trim().length > 0) {
    rootPreludeBits.push(file.root.comment.trim());
  }
  const rootAnnotation = renderNodeAnnotation(file.root);
  if (rootAnnotation) rootPreludeBits.push(rootAnnotation);
  const rootPrelude = rootPreludeBits.length > 0 ? `{${rootPreludeBits.join(" ")}} ` : "";
  const movetext = rootPrelude + renderChildren(file.root.children, file.root.ply + 1, /* forceMoveNumber */ true);
  const result = file.tags.Result ?? "*";
  parts.push(`${movetext.trim()} ${result}`);

  return parts.join("\n") + "\n";
}

function defaultTagValue(k: string): string {
  switch (k) {
    case "Result": return "*";
    case "Date":   return "????.??.??";
    default:       return "?";
  }
}

function escapeTagValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Render a variation (a sequence of children starting at children[0] as
// mainline and children[1..N] as parenthesised alternatives).
function renderChildren(children: PrepNode[], ply: number, forceMoveNumber: boolean): string {
  if (children.length === 0) return "";
  const mainline = children[0];
  const alts = children.slice(1);

  const bits: string[] = [];

  // Emit the mainline node with move number as needed.
  bits.push(renderMoveWithNumber(mainline, forceMoveNumber));

  // Then, alternative variations that branch AT THIS POSITION —
  // i.e. all siblings of the mainline child. They must fork from the
  // same position (parent), so their move number matches the mainline's.
  for (const alt of alts) {
    bits.push(`(${renderMoveWithNumber(alt, /* forceMoveNumber */ true)}${renderVariationTail(alt)})`);
  }

  // Continue down the mainline. After emitting a variation, the next
  // mainline move needs its own number rendered (Black's move after a
  // variation should show "N... Nf6", etc.).
  const forceNext = alts.length > 0;
  bits.push(renderChildren(mainline.children, ply + 1, forceNext));

  return bits.filter(Boolean).join(" ");
}

// Render the tail of a variation — everything after the variation's
// first move (which is rendered by the parent). The recursion here
// mirrors renderChildren but doesn't force a move number on the very
// next move (unless a nested variation intervenes).
function renderVariationTail(startNode: PrepNode): string {
  const suffix = renderChildren(startNode.children, startNode.ply + 1, /* forceMoveNumber */ false);
  return suffix ? " " + suffix : "";
}

// Render a single move — number prefix + SAN + NAGs + comment.
function renderMoveWithNumber(node: PrepNode, forceMoveNumber: boolean): string {
  if (!node.san) return "";
  const whiteToMove = (node.ply % 2) === 1;
  let prefix = "";
  if (whiteToMove) {
    prefix = `${Math.ceil(node.ply / 2)}. `;
  } else if (forceMoveNumber) {
    prefix = `${Math.ceil(node.ply / 2)}... `;
  }
  const suffix = renderNagsAndComment(node);
  return `${prefix}${node.san}${suffix ? " " + suffix : ""}`.trimEnd();
}

function renderNagsAndComment(node: PrepNode): string {
  const bits: string[] = [];
  if (node.nags && node.nags.length > 0) {
    bits.push(node.nags.join(" "));
  }
  const commentBits: string[] = [];
  if (node.comment && node.comment.trim().length > 0) {
    commentBits.push(node.comment.trim());
  }
  const annotationCmd = renderNodeAnnotation(node);
  if (annotationCmd) commentBits.push(annotationCmd);
  if (commentBits.length > 0) {
    bits.push(`{${commentBits.join(" ")}}`);
  }
  return bits.join(" ");
}

// Build the [%cal ...] / [%csl ...] / [%ceo-eval ...] fragments if
// this node has any. Returns "" if none.
function renderNodeAnnotation(node: PrepNode): string {
  const bits: string[] = [];
  if (node.annotations) {
    if (node.annotations.arrows.length > 0) {
      const entries = node.annotations.arrows
        .map(a => `${codeFromColor(a.color)}${a.from}${a.to}`)
        .join(",");
      bits.push(`[%cal ${entries}]`);
    }
    if (node.annotations.highlights.length > 0) {
      const entries = node.annotations.highlights
        .map(h => `${codeFromColor(h.color)}${h.square}`)
        .join(",");
      bits.push(`[%csl ${entries}]`);
    }
  }
  if (node.ceoEval) {
    const s = renderCeoEval(node.ceoEval);
    if (s) bits.push(s);
  }
  return bits.join(" ");
}

// Serialise a stored eval as `[%ceo-eval sf=+0.20/38 lc0=+0.35/24 nag=$14]`.
// Compact: no PVs (regenerable via cloud_analyse), decimal cp for
// readability, mate as `MN`/`-MN`, depth as `/N`.
function renderCeoEval(ev: StoredEval): string {
  const bits: string[] = [];
  if (ev.sf)  bits.push(`sf=${formatEngineEval(ev.sf)}`);
  if (ev.lc0) bits.push(`lc0=${formatEngineEval(ev.lc0)}`);
  if (ev.nag) bits.push(`nag=${ev.nag}`);
  return bits.length > 0 ? `[%ceo-eval ${bits.join(" ")}]` : "";
}

function formatEngineEval(e: StoredEngineEval): string {
  let body: string;
  if (typeof e.mate === "number") {
    body = e.mate >= 0 ? `+M${e.mate}` : `M${e.mate}`; // "+M5" / "M-5"
  } else if (typeof e.cp === "number") {
    const pawns = e.cp / 100;
    body = pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
  } else {
    body = "+0.00";
  }
  if (typeof e.depth === "number") body += `/${e.depth}`;
  return body;
}
