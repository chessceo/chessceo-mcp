// Prep-file reads and list-queries. Everything the LLM calls to inspect
// a file WITHOUT mutating it:
//   - readPrepFile (with four view modes: compact / full / spine / pgn)
//   - listNodes (cheap filter-based node queries)
//   - listTranspositions (positions occurring 2+ times in the file)
//
// Extracted from index.ts in v0.44 as part of the file split. Was
// originally split off the read-case handler because both readPrepFile
// and listNodes need the same load-parse pipeline and share the
// compact / spine / pgn view logic.

import { fetchGame } from "../http.js";
import { parsePGN } from "../pgn/parser.js";
import { exportPGN } from "../pgn/exporter.js";
import {
  buildFenIndex,
  buildIdIndex,
  positionKey,
  resolveNodeId,
  ROOT_ID,
} from "../pgn/paths.js";
import type { PrepFile, PrepNode } from "../pgn/types.js";
import { getNodeByPath } from "../analysis/file_handle.js";

type Args = Record<string, unknown>;

export type ViewMode = "compact" | "full" | "spine" | "pgn";

export async function loadPrepFile(id: string): Promise<{ file: PrepFile; version: number | undefined; fileIdEcho: string | undefined; pgn: string }> {
  const g = await fetchGame(id);
  // Echo the composite id back so read_prep_file responses match the
  // exact id the LLM passed in. The backend returns the raw game_id;
  // recompose so the LLM never sees the split form.
  return { file: parsePGN(g.pgnContent), version: g.version, fileIdEcho: id, pgn: g.pgnContent };
}

// Recursively project a PrepNode into the requested view. `depthLeft`
// null → unlimited; 0 → just the node without children.
//
// `fenIndex` (optional) enables the `transposes_to` field — for each
// node whose position also appears elsewhere in the SAME file, we
// annotate it with the OTHER occurrences' ids. Pass null (the default)
// to skip the annotation entirely; passing the map costs one lookup
// per node projected.
export function projectNode(node: PrepNode, view: ViewMode, depthLeft: number | null, fenIndex: Map<string, PrepNode[]> | null = null): unknown {
  const base: Record<string, unknown> = {
    id: node.id,
    san: node.san,
    ply: node.ply,
  };
  if (node.nags && node.nags.length > 0) base.nags = node.nags;
  if (node.comment) base.comment = node.comment;
  if (node.ceoEval) base.ceoEval = node.ceoEval;
  if (view === "full") {
    base.fen = node.fen;
    if (node.annotations) base.annotations = node.annotations;
  }
  if (fenIndex && node.id !== ROOT_ID) {
    const group = fenIndex.get(positionKey(node.fen));
    if (group && group.length > 1) {
      const others = group.filter(n => n.id !== node.id).map(n => n.id);
      if (others.length > 0) base.transposes_to = others;
    }
  }
  // Children handling depends on view + depth budget.
  const showChildren = depthLeft === null || depthLeft > 0;
  const childDepth = depthLeft === null ? null : depthLeft - 1;
  if (showChildren && node.children.length > 0) {
    if (view === "spine") {
      // Only follow children[0] — collapses the tree to the mainline.
      base.children = [projectNode(node.children[0], view, childDepth, fenIndex)];
    } else {
      base.children = node.children.map(c => projectNode(c, view, childDepth, fenIndex));
    }
  } else {
    base.children = [];
  }
  return base;
}

export async function readPrepFile(args: Args): Promise<unknown> {
  const id = String(args.id);
  const view: ViewMode = (typeof args.view === "string" && ["compact", "full", "spine", "pgn"].includes(args.view))
    ? args.view as ViewMode
    : "compact";
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0 ? args.node_id : ROOT_ID;
  const maxDepth: number | null = typeof args.max_depth === "number" && args.max_depth >= 0 ? args.max_depth : null;

  const { file, version, fileIdEcho, pgn } = await loadPrepFile(id);
  const idIndex = buildIdIndex(file.root);
  const path = resolveNodeId(idIndex, startNodeId);
  const anchor = getNodeByPath(file.root, path);
  const fenIndex = buildFenIndex(file.root);

  // How many DISTINCT positions in the file appear more than once,
  // and how many nodes are involved. Shown in the header so the LLM
  // sees at a glance whether transpositions matter here before diving
  // into the tree.
  let transGroups = 0;
  let transNodes = 0;
  for (const arr of fenIndex.values()) {
    if (arr.length > 1) { transGroups++; transNodes += arr.length; }
  }

  const header: Record<string, unknown> = {
    id: fileIdEcho ?? id,
    version,
    tags: file.tags,
    view,
    node_id: startNodeId,
    max_depth: maxDepth,
    transposition_groups: transGroups,
    transposition_nodes: transNodes,
  };

  if (view === "pgn") {
    // For the root, just return the file's actual PGN as-is. For a
    // subtree, build a mini-Game from the anchor and export it. Keeps
    // formatting identical to what the app renders.
    if (startNodeId === ROOT_ID && (maxDepth === null || maxDepth >= 999)) {
      return { ...header, pgn };
    }
    // Truncate to a subtree with max_depth. Simple: walk the anchor's
    // subtree, produce a synthetic PGN starting from the anchor's FEN.
    const subtreePgn = exportSubtreePgn(file, anchor, maxDepth);
    return { ...header, pgn: subtreePgn };
  }

  return { ...header, tree: projectNode(anchor, view, maxDepth, fenIndex) };
}

// Produce a PGN string for a subtree rooted at `anchor`, truncated
// at `maxDepth` plies below (null = unlimited). Reuses the exporter
// by building a synthetic PrepFile whose root is a shallow clone of
// the anchor with its children trimmed to depth.
function exportSubtreePgn(file: PrepFile, anchor: PrepNode, maxDepth: number | null): string {
  const trim = (n: PrepNode, depthLeft: number | null): PrepNode => {
    if (depthLeft !== null && depthLeft <= 0) return { ...n, children: [] };
    const next = depthLeft === null ? null : depthLeft - 1;
    return { ...n, children: n.children.map(c => trim(c, next)) };
  };
  const trimmedAnchor = trim(anchor, maxDepth);
  // If the anchor IS the root, exporter handles it. If it's an inner
  // node, we set the root's FEN to the anchor's position and hang the
  // trimmed subtree off it. Tags carried over.
  if (anchor.id === ROOT_ID) {
    return exportPGN({ tags: file.tags, root: trimmedAnchor });
  }
  const syntheticRoot: PrepNode = {
    id: ROOT_ID,
    san: null,
    fen: anchor.fen,
    ply: 0,
    children: trimmedAnchor.children,
  };
  const tags = { ...file.tags, FEN: anchor.fen, SetUp: "1" };
  return exportPGN({ tags, root: syntheticRoot });
}

export async function listNodes(args: Args): Promise<unknown> {
  const id = String(args.id);
  const filter = String(args.filter || "");
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0 ? args.node_id : ROOT_ID;
  const maxDepth: number | null = typeof args.max_depth === "number" && args.max_depth >= 0 ? args.max_depth : null;

  const { file } = await loadPrepFile(id);
  const idIndex = buildIdIndex(file.root);
  const path = resolveNodeId(idIndex, startNodeId);
  const anchor = getNodeByPath(file.root, path);
  const fenIndex = filter === "transpositions" ? buildFenIndex(file.root) : null;

  type Hit = Record<string, unknown>;
  const hits: Hit[] = [];

  const walk = (node: PrepNode, depthLeft: number | null, spineOnly: boolean) => {
    // Root has no san — never emit it as a match. Everything else is fair game.
    if (node.id !== ROOT_ID) {
      let include = false;
      let extra: Record<string, unknown> = {};
      switch (filter) {
        case "missing_eval":
          include = !node.ceoEval; break;
        case "has_comment":
          include = !!(node.comment && node.comment.length > 0);
          if (include) extra.comment_preview = (node.comment || "").slice(0, 80);
          break;
        case "has_annotations":
          include = !!(node.annotations && (node.annotations.arrows.length > 0 || node.annotations.highlights.length > 0));
          break;
        case "novelties":
          include = !!(node.nags && node.nags.includes("$146"));
          break;
        case "leaves":
          include = node.children.length === 0; break;
        case "mainline":
          include = spineOnly; break;
        case "transpositions": {
          const group = fenIndex!.get(positionKey(node.fen));
          if (group && group.length > 1) {
            include = true;
            extra.transposes_to = group.filter(n => n.id !== node.id).map(n => n.id);
          }
          break;
        }
        case "all":
          include = true; break;
        default:
          throw new Error(`unknown filter: ${filter}`);
      }
      if (include) {
        const hit: Hit = { node_id: node.id, san: node.san, ply: node.ply };
        Object.assign(hit, extra);
        hits.push(hit);
      }
    }
    if (depthLeft !== null && depthLeft <= 0) return;
    const nextDepth = depthLeft === null ? null : depthLeft - 1;
    if (filter === "mainline" && spineOnly) {
      if (node.children.length > 0) walk(node.children[0], nextDepth, true);
    } else {
      for (const c of node.children) walk(c, nextDepth, filter === "mainline");
    }
  };

  const rootIsSpineForFilter = filter === "mainline";
  walk(anchor, maxDepth, rootIsSpineForFilter);

  return { file_id: id, filter, node_id: startNodeId, max_depth: maxDepth, count: hits.length, nodes: hits };
}

// list_transpositions — every position that occurs 2+ times in the
// file, so the LLM knows where its analysis / prose will double up.
export async function listTranspositions(args: Args): Promise<unknown> {
  const id = String(args.id);
  const { file } = await loadPrepFile(id);
  const fenIndex = buildFenIndex(file.root);

  type Group = { position_key: string; size: number; node_ids: string[]; sans: (string | null)[] };
  const groups: Group[] = [];
  for (const [key, arr] of fenIndex.entries()) {
    if (arr.length < 2) continue;
    groups.push({
      position_key: key,
      size: arr.length,
      node_ids: arr.map(n => n.id),
      sans: arr.map(n => n.san),
    });
  }
  groups.sort((a, b) => b.size - a.size || a.position_key.localeCompare(b.position_key));

  const nodeCount = groups.reduce((s, g) => s + g.size, 0);
  return { file_id: id, group_count: groups.length, node_count: nodeCount, groups };
}
