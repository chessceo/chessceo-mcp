#!/usr/bin/env node
// chess.ceo MCP server. Exposes the public GET API as MCP tools so LLM
// hosts (Claude Desktop, Cursor, etc.) can look up players, positions,
// preparation stats, and live broadcast state directly.
//
// Everything here is a thin wrapper around https://chess.ceo/api/chess/*
// endpoints — see the public contract at https://chess.ceo/llms.txt.
// No API key, no auth, no state; the API's own rate limits apply.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Chess } from "chess.js";
import { parsePGN } from "./pgn/parser.js";
import { exportPGN } from "./pgn/exporter.js";
import { describePosition } from "./pgn/describe.js";
import {
  addLine,
  addMove,
  deleteSubtree,
  MutationError,
  promoteVariation,
  setAnnotations,
  setCeoEval,
  setCeoEvalMany,
  setComment,
  setNags,
  setTag,
} from "./pgn/mutations.js";
import { buildFenIndex, buildIdIndex, NodeIdError, PathError, positionKey, resolveNodeId, ROOT_ID } from "./pgn/paths.js";
import type {
  Path,
  PrepAnnotations,
  PrepArrow,
  PrepFile,
  PrepHighlight,
  PrepNode,
  StoredEngineEval,
  StoredEval,
} from "./pgn/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { PROMPTS } from "./prompts.js";
import {
  commentAntiPatterns,
  longLineWarning,
  noDescribeWarning,
  noStatsCheckWarning,
  positionalNagOnIntermediateWarning,
  positionsDescribed,
  positionsStatsChecked,
} from "./warnings.js";
import {
  authContext,
  authedRequest,
  createGame,
  deleteGame,
  fetchGame,
  get,
  makeFileId,
  PGN_BASE,
  restoreGame,
  saveGame,
  splitFileId,
  unwrap,
  type PgnGame,
} from "./http.js";
import {
  analysisToStoredEval,
  capPvsInResponse,
  convertCloudSnapshotResponse,
  fetchCompactEval,
  nagFromCp,
  storedEvalToCompact,
  uciLineToSAN,
  uciMoveToSAN,
  type CompactEval,
  type EngineBlock,
} from "./analysis/response.js";
import {
  autoEvaluate,
  autoEvaluateCancel,
  autoEvaluateStatus,
} from "./analysis/auto.js";
import {
  deepAnalyseCancel,
  deepAnalyseStart,
  deepAnalyseStatus,
} from "./analysis/deep.js";
import {
  findNodeByFen,
  getNodeByPath,
  resolveFenFromArgs,
  resolveFromNodeOrFen,
  storeEvalOnNode,
  type FileHandle,
} from "./analysis/file_handle.js";
import { findPositionInCourses, readCourseAtPosition, runSfEval } from "./courses.js";
import {
  applyBatchMutations,
  applyMutation,
  argNodeId,
  dispatchMutation,
} from "./prep/mutations.js";
import {
  listNodes,
  listTranspositions,
  loadPrepFile,
  projectNode,
  readPrepFile,
} from "./prep/read.js";
import {
  createPrepFile,
  findPositionInFiles,
  listCollections,
  listPrepFiles,
  searchPrepFiles,
} from "./prep/library.js";
import {
  convertAvailableMovesToSAN,
  normalizeSourceForBackend,
  stripPositionResponse,
  trimGamesMovetext,
} from "./response_transforms.js";

// Tools that require an MCP token — cloud engine + prep-file tools
// operate on the caller's own account so we can't service them
// anonymously. The streamable-http transport uses this list to decide
// whether to trigger the OAuth discovery flow via 401 + WWW-Authenticate
// before the SDK gets a chance to handle the call.
const AUTHED_TOOLS = new Set([
  "start_cloud_engine",
  "list_cloud_engines",
  "stop_cloud_engine",
  "cloud_analyse",
  "list_collections",
  "list_prep_files",
  "search_prep_files",
  "find_position_in_files",
  "read_prep_file",
  "list_nodes",
  "list_transpositions",
  "create_prep_file",
  "delete_prep_file",
  "restore_prep_file",
  "add_move",
  "add_line",
  "set_comment",
  "set_nags",
  "set_annotations",
  "delete_subtree",
  "promote_variation",
  "set_tag",
  "apply_mutations",
  "auto_evaluate",
  "auto_evaluate_status",
  "auto_evaluate_cancel",
  "deep_analyse",
  "deep_analyse_status",
  "deep_analyse_cancel",
  "find_position_in_courses",
  "read_course_at_position",
  "quote_engine_eval",
  "predict_human_move",
  "prepare_opponent",
  "get_prep_position",
  "list_prep_sessions",
  "delete_prep_session",
]);

function isAuthedToolCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { method?: unknown; params?: { name?: unknown } };
  if (b.method !== "tools/call") return false;
  const name = b.params?.name;
  return typeof name === "string" && AUTHED_TOOLS.has(name);
}


// The engine-usage guide ships in the package (see package.json "files").
// Loaded once at startup and returned verbatim by the engine_usage_primer
// prompt — LLM hosts surface it in their slash menu so a user can push the
// full doc into the conversation on demand.
function loadBundledDoc(filename: string, fallbackLabel: string): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../docs/*.md when packaged; src/index.ts →
    // ../docs/*.md during dev. Same resolution either way.
    return readFileSync(join(here, "..", "docs", filename), "utf8");
  } catch {
    return `${fallbackLabel} not bundled with this install of @chessceo/mcp.`;
  }
}

const ENGINE_USAGE_DOC = loadBundledDoc("engine-usage.md", "Engine usage guide");
const PREP_STRATEGY_DOC = loadBundledDoc("prep-strategy.md", "Prep strategy guide");
const PREP_FILES_DOC = loadBundledDoc("prep-files-guide.md", "Prep files guide");
const PGN_AUTHORING_DOC = loadBundledDoc("pgn-authoring.md", "PGN authoring guide");

// Reference PGNs authored by a strong human coach. LLM pulls these when
// it wants to see the commentary style, NAG discipline, and annotation
// density we want it to hit. Kept as raw PGN so the LLM can parse them
// against its own understanding of the game (comments, arrows, NAGs
// all intact) — not summarised into English.
const EXAMPLE_OVERVIEW_PGN = loadBundledDoc("examples/italian-fried-liver.pgn", "Italian Fried Liver overview example");
const EXAMPLE_REPERTOIRE_PGN = loadBundledDoc("examples/najdorf-6-f4-white.pgn", "Najdorf 6.f4 White repertoire example");



// ── Handlers ───────────────────────────────────────────────────────

type Args = Record<string, unknown>;

// Log every tool call in and out. Keeps args + response payloads together
// with a per-call duration so we can trace what the LLM asked for and what
// it got back on the same journalctl line. Response is JSON-stringified and
// capped so the two doc-reading tools (~5-10 KB of static markdown each)
// don't drown the log stream.
const LOG_MAX_CHARS = 4096;






function stringifyForLog(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s.length > LOG_MAX_CHARS) {
    s = s.slice(0, LOG_MAX_CHARS) + `…+${s.length - LOG_MAX_CHARS}chars`;
  }
  return s;
}

// Version tag stamped on every log line so a bug report can be traced
// to the exact MCP release that produced it. process.env.npm_package_version
// is set by npm when the package is run via `npx` / `npm start` (and by
// our systemd unit which uses npx); falls back to reading package.json
// during dev when we `node dist/index.js` directly. "unknown" if all
// else fails — better than pretending we know.
const MCP_VERSION: string = (() => {
  const fromEnv = process.env.npm_package_version?.trim();
  if (fromEnv) return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js is one level below package.json; src/index.ts is two
    // (src/index.ts → ../package.json). Try both.
    for (const p of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
})();
const MCP_TAG = `[mcp v${MCP_VERSION}]`;

// One-shot startup line so tailing the log from the beginning shows
// the running version immediately, before any tool call.
console.error(`${MCP_TAG} chessceo-mcp startup`);

async function callTool(name: string, args: Args): Promise<unknown> {
  const started = Date.now();
  console.error(`${MCP_TAG} IN  ${name} args=${stringifyForLog(args)}`);
  try {
    const result = await callToolInner(name, args);
    const dur = Date.now() - started;
    console.error(`${MCP_TAG} OUT ${name} ok ${dur}ms result=${stringifyForLog(result)}`);
    return result;
  } catch (err) {
    const dur = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${MCP_TAG} OUT ${name} err ${dur}ms error=${JSON.stringify(msg)}`);
    throw err;
  }
}

async function callToolInner(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "search_player":
      return get("/api/chess/players/search/simple", { q: String(args.name), view: "llm" });

    case "get_player_profile":
      return get("/api/chess/players/profile", { fideId: Number(args.fide_id) });

    case "prepare_opponent": {
      const rawSources = Array.isArray(args.sources) ? args.sources : [];
      if (rawSources.length === 0) throw new Error("`sources` array required");
      const sources = rawSources.map((s, i) => normalizeSourceForBackend(s as Record<string, unknown>, i));
      return authedRequest("POST", "/api/chess/prep/prepare-multi", { sources });
    }

    case "get_prep_position": {
      const token = String(args.session_token || "").trim();
      if (!token) throw new Error("`session_token` required — create one with prepare_opponent");
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const qs: Record<string, string | number | undefined> = {
        token,
        fen,
        limit: typeof args.limit === "number" ? args.limit : 10,
      };
      if (typeof args.offset === "number") qs.offset = args.offset;
      const [raw, ev] = await Promise.all([
        get("/api/chess/prep/unified", qs),
        fetchCompactEval(fen),
      ]);
      const converted = convertAvailableMovesToSAN(raw, fen);
      if (converted && typeof converted === "object") {
        trimGamesMovetext(converted);
        stripPositionResponse(converted);
        if (ev) (converted as { eval?: CompactEval }).eval = ev;
      }
      return converted;
    }

    case "list_prep_sessions":
      return authedRequest("GET", "/api/chess/prep/sessions");

    case "delete_prep_session": {
      const token = String(args.session_token || "").trim();
      if (!token) throw new Error("`session_token` required");
      return authedRequest("DELETE", `/api/chess/prep/sessions/${encodeURIComponent(token)}`);
    }

    case "get_position_stats": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const rawSource = typeof args.source === "string" ? args.source : "gm-classical";
      const source = rawSource === "main" ? "main" : "gm-classical";
      const [raw, ev] = await Promise.all([
        get(`/api/chess/database/${source}`, {
          fen,
          limit: typeof args.limit === "number" ? args.limit : 10,
          sort: "relevance",
        }),
        fetchCompactEval(fen),
      ]);
      const converted = convertAvailableMovesToSAN(raw, fen);
      if (converted && typeof converted === "object") {
        trimGamesMovetext(converted);
        stripPositionResponse(converted);
        (converted as { source?: string }).source = source;
        if (ev) (converted as { eval?: CompactEval }).eval = ev;
      }
      // Record that this position was DB-checked this session. Downstream
      // add_move / add_line under this parent won't fire the "no stats
      // check" warning. Keyed by 3-field FEN so transpositions count.
      positionsStatsChecked.add(positionKey(fen));
      return converted;
    }

    case "describe_position": {
      const resolved = await resolveFromNodeOrFen(args);
      // Chess-primitive analysis (structural, ~1 ms) + Stockfish eval-
      // term breakdown (~50-100 ms) in parallel. Merge into one response
      // so the LLM sees the whole position in one call — chess-concepts,
      // structural weaknesses, AND engine's per-term reasoning.
      // If Stockfish isn't installed the eval leg returns {found: false,
      // error} and we drop it from the response so callers see the same
      // shape either way (just without `engineEvalTerms`).
      const [structural, evalRaw] = await Promise.all([
        Promise.resolve(describePosition(resolved.fen)),
        runSfEval(resolved.fen).catch(err => ({
          found: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      ]);
      const merged = structural as Record<string, unknown>;
      const ev = evalRaw as { found?: boolean; terms?: unknown; total?: unknown };
      if (ev && ev.found === true) {
        merged.engineEvalTerms = { terms: ev.terms, total: ev.total };
      }
      // Record so set_comment on this node won't fire the "not described"
      // warning. Keyed by 3-field FEN so a described position is
      // credited across its transpositions too.
      positionsDescribed.add(positionKey(resolved.fen));
      return merged;
    }

    case "predict_human_move": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      // Rating is fixed at 2850 vs 2850. Not exposed to the LLM —
      // cross-position comparisons only mean something at a constant
      // rating, and top-level is the useful reference point for prep.
      const qs = new URLSearchParams();
      qs.set("fen", fen);
      qs.set("white_elo", "2850");
      qs.set("black_elo", "2850");
      if (typeof args.top === "number") qs.set("top", String(args.top));
      if (Array.isArray(args.prev_fens)) {
        for (const p of args.prev_fens as unknown[]) {
          if (typeof p === "string" && p.length > 0) qs.append("prev_fen", p);
        }
      }
      const raw = await authedRequest("GET", `/api/agent/predict-move?${qs.toString()}`);
      // Strip uci from each move — san is enough for the LLM and the
      // duplicate field is context bloat. Also drop whiteElo/blackElo
      // from the response (always 2850 now — echoing them adds nothing).
      if (raw && typeof raw === "object") {
        const r = raw as { moves?: Array<Record<string, unknown>>; whiteElo?: unknown; blackElo?: unknown };
        if (Array.isArray(r.moves)) {
          for (const m of r.moves) delete m.uci;
        }
        delete r.whiteElo;
        delete r.blackElo;
      }
      return raw;
    }

    case "get_head_to_head":
      return get("/api/chess/players/h2h", {
        a: Number(args.fide_id_a),
        b: Number(args.fide_id_b),
        limit: typeof args.limit === "number" ? args.limit : 10,
        offset: typeof args.offset === "number" ? args.offset : 0,
      });

    case "list_live_tournaments":
      return get("/api/chess/live/tournaments", {});

    case "list_tournament_players":
      return get("/api/chess/live/tournament/players", { tour_id: String(args.tour_id) });

    case "list_player_live_tournaments":
      // Note: snake_case fide_id, unlike the prep endpoints. Documented quirk.
      return get("/api/chess/live/player", { fide_id: Number(args.fide_id) });

    case "list_cloud_machine_options":
      return authedRequest("GET", "/api/agent/cloud-engines/options");

    case "start_cloud_engine":
      return authedRequest("POST", "/api/agent/cloud-engines", {
        machineType: String(args.machine_type),
      });

    case "list_cloud_engines":
      return authedRequest("GET", "/api/agent/cloud-engines");

    case "stop_cloud_engine":
      return authedRequest("DELETE", `/api/agent/cloud-engines/${encodeURIComponent(String(args.contract_id))}`);

    case "cloud_analyse": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const body: Record<string, unknown> = { fen };
      if (typeof args.movetime_ms === "number") body.movetime_ms = args.movetime_ms;
      if (typeof args.stockfish_multipv === "number") body.stockfish_multipv = args.stockfish_multipv;
      if (typeof args.lc0_multipv === "number") body.lc0_multipv = args.lc0_multipv;
      if (typeof args.contempt === "number") body.contempt = args.contempt;
      if (Array.isArray(args.engines)) body.engines = args.engines;
      const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse", body);
      const converted = convertCloudSnapshotResponse(raw, fen);
      // PV cap: engine PVs beyond ~6 plies are speculative (the tail is
      // where the search's confidence collapses — SF at depth 24 has
      // seen the first few plies solidly and hedged everything after).
      // More importantly, LLMs paste long PVs into `add_line` as if
      // they were prepared repertoire. A 15-move PV pasted as a
      // variation is one line of engine output through positions
      // where both sides had real choices — not a repertoire. Cap the
      // affordance: return only what's load-bearing (3 full moves for
      // understanding the point), let the caller re-analyse the
      // resulting position if they want to see further. Override via
      // `pv_max_plies` for the rare case (deep tactics verification).
      const pvMaxPlies = typeof args.pv_max_plies === "number" && args.pv_max_plies > 0
        ? Math.min(args.pv_max_plies, 40)
        : 6;
      capPvsInResponse(converted, pvMaxPlies);
      // Node-addressed calls: persist the result on the node's ceoEval
      // so a later quote_engine_eval can cite this measurement. This is
      // the anti-hallucination hinge — prose that says "engines say X
      // on node Y" can only trace back to a call actually made against
      // node_id=Y, because the store only fires when file_id+node_id
      // was supplied and the eval survives via the [%ceo-eval] escape.
      if (resolved.file) {
        const ev = analysisToStoredEval(converted);
        if (ev) {
          const stamped = await storeEvalOnNode(resolved.file, ev);
          if (stamped.length > 1) {
            // Surface the propagation so the LLM sees exactly which
            // other nodes now carry this eval (and can skip them for
            // re-analysis).
            (converted as Record<string, unknown>).also_stored_on = stamped.slice(1);
          }
        }
      }
      return converted;
    }

    case "deep_analyse":
      return deepAnalyseStart(args);
    case "deep_analyse_status":
      return deepAnalyseStatus(args);
    case "deep_analyse_cancel":
      return deepAnalyseCancel(args);

    case "find_position_in_courses":
      return findPositionInCourses(args);

    case "read_course_at_position":
      return readCourseAtPosition(args);

    case "list_collections":
      return listCollections(args);

    case "list_prep_files":
      return listPrepFiles(args);

    case "search_prep_files":
      return searchPrepFiles(args);

    case "find_position_in_files":
      return findPositionInFiles(args);

    case "read_prep_file":
      return readPrepFile(args);

    case "list_nodes":
      return listNodes(args);

    case "list_transpositions":
      return listTranspositions(args);

    case "create_prep_file":
      return createPrepFile(args);

    case "delete_prep_file": {
      await deleteGame(String(args.id));
      return { ok: true };
    }

    case "restore_prep_file": {
      const game = await restoreGame(String(args.id));
      return { ok: true, id: makeFileId(game.collectionId, game.id), version: game.version };
    }

    case "add_move":
      return applyMutation(args, (file, idIndex) => {
        const parentPath = resolveNodeId(idIndex, argNodeId(args, "parent_id"));
        const parent = getNodeByPath(file.root, parentPath);
        const noStatsWarn = noStatsCheckWarning(parent);
        const step = addMove(file, parentPath, String(args.san));
        return { ...step, ...(noStatsWarn ? { warning: noStatsWarn } : {}) };
      });

    case "add_line": {
      const sansArg = Array.isArray(args.sans) ? (args.sans as unknown[]).map(String) : [];
      const longLineWarn = longLineWarning(sansArg.length);
      return applyMutation(args, (file, idIndex) => {
        const parentPath = resolveNodeId(idIndex, argNodeId(args, "parent_id"));
        const parent = getNodeByPath(file.root, parentPath);
        const noStatsWarn = noStatsCheckWarning(parent);
        const step = addLine(file, parentPath, sansArg);
        const lastId = step.line.length > 0 ? step.line[step.line.length - 1].id : argNodeId(args, "parent_id");
        const combined = [longLineWarn, noStatsWarn].filter((s): s is string => !!s);
        return {
          file: step.file,
          id: lastId,
          results: step.line,
          ...(combined.length > 0 ? { warnings: combined } : {}),
        };
      });
    }

    case "set_comment": {
      const commentStr = typeof args.comment === "string" ? args.comment : "";
      const commentWarns = commentAntiPatterns(commentStr);
      return applyMutation(args, (file, idIndex) => {
        const targetPath = resolveNodeId(idIndex, argNodeId(args));
        const targetNode = getNodeByPath(file.root, targetPath);
        const describeWarn = noDescribeWarning(targetNode, commentStr);
        const step = setComment(file, targetPath, commentStr);
        const all = [...commentWarns, ...(describeWarn ? [describeWarn] : [])];
        return {
          ...step,
          ...(all.length > 0 ? { warnings: all } : {}),
        };
      });
    }

    case "set_nags":
      return applyMutation(args, (file, idIndex) => {
        const nagsArg = Array.isArray(args.nags) ? (args.nags as unknown[]).map(String) : [];
        const targetPath = resolveNodeId(idIndex, argNodeId(args));
        const targetNode = getNodeByPath(file.root, targetPath);
        const nagWarn = positionalNagOnIntermediateWarning(targetNode, nagsArg);
        const step = setNags(file, targetPath, nagsArg);
        return { ...step, ...(nagWarn ? { warning: nagWarn } : {}) };
      });

    case "set_annotations": {
      const arrowsRaw = Array.isArray(args.arrows) ? args.arrows as PrepArrow[] : [];
      const highlightsRaw = Array.isArray(args.highlights) ? args.highlights as PrepHighlight[] : [];
      const ann: PrepAnnotations | null =
        (arrowsRaw.length === 0 && highlightsRaw.length === 0)
          ? null
          : { arrows: arrowsRaw, highlights: highlightsRaw };
      return applyMutation(args, (file, idIndex) => setAnnotations(file, resolveNodeId(idIndex, argNodeId(args)), ann));
    }

    case "delete_subtree":
      return applyMutation(args, (file, idIndex) => deleteSubtree(file, resolveNodeId(idIndex, argNodeId(args))));

    case "promote_variation":
      return applyMutation(args, (file, idIndex) => promoteVariation(file, resolveNodeId(idIndex, argNodeId(args))));

    case "set_tag":
      return applyMutation(args, file => ({
        file: setTag(file, String(args.key), String(args.value ?? "")),
        id: ROOT_ID,
      }));

    case "apply_mutations":
      return applyBatchMutations(args);

    case "auto_evaluate":
      return autoEvaluate(args, applyBatchMutations);

    case "auto_evaluate_status":
      return autoEvaluateStatus(args);

    case "auto_evaluate_cancel":
      return autoEvaluateCancel(args);

    case "quote_engine_eval": {
      const fileId = String(args.id);
      const nodeId = argNodeId(args);
      const g = await fetchGame(fileId);
      const file = parsePGN(g.pgnContent);
      const idIndex = buildIdIndex(file.root);
      const path = resolveNodeId(idIndex, nodeId);
      const node = getNodeByPath(file.root, path);
      return { ceoEval: node.ceoEval ?? null };
    }

    case "read_engine_usage_guide":
      return { guide: ENGINE_USAGE_DOC };

    case "read_opening_prep_guide":
      return { guide: PREP_STRATEGY_DOC };

    case "read_prep_files_guide":
      return { guide: PREP_FILES_DOC };

    case "read_pgn_authoring_guide":
      return { guide: PGN_AUTHORING_DOC };

    case "read_example_prep_files":
      return { overview: EXAMPLE_OVERVIEW_PGN, repertoire: EXAMPLE_REPERTOIRE_PGN };

    case "prep_snapshot": {
      const me = Number(args.fide_id_me);
      const opp = Number(args.fide_id_opponent);
      const myColor = String(args.my_color);
      const oppColor = myColor === "white" ? "black" : "white";

      // Prefer file_id+node_id — derives FEN from the tree, no LLM-typed
      // FEN in the loop. Falls back to line/fen for scratch positions.
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;

      const prepParams = (fideId: number, color: string) => ({
        fideId,
        color,
        compact: "true",
        fen,
      });

      const [opponent, you, general, ev] = await Promise.all([
        get("/api/chess/prep/by-player", prepParams(opp, oppColor)),
        get("/api/chess/prep/by-player", prepParams(me, myColor)),
        get("/api/chess/database/main", { fen, limit: 20, sort: "relevance" }),
        fetchCompactEval(fen),
      ]);

      return {
        position: { fen, my_color: myColor, ...(resolved.file ? { node_id: typeof args.node_id === "string" ? args.node_id : undefined } : {}) },
        eval: ev,
        opponent: convertAvailableMovesToSAN(opponent, fen),
        you: convertAvailableMovesToSAN(you, fen),
        general: convertAvailableMovesToSAN(general, fen),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}


// The workflow text for prepare_for_game. Kept in one place so both the
// MCP prompt handler and the /prepare fallback can share it.
const PREP_WORKFLOW = (args: Record<string, string | undefined>) => {
  const me = args.me ?? "the user";
  const opp = args.opponent ?? "the opponent";
  const color = args.my_color ? ` as ${args.my_color}` : "";
  const tc = args.time_control ? ` in a ${args.time_control} game` : "";
  return `You are preparing ${me} for a chess game against ${opp}${color}${tc}.

Preparation workflow — follow the steps in order and be explicit about which tools you called at each step:

1. **Resolve both players.** Call \`search_player\` for "${me}" and "${opp}" to get their FIDE IDs. Confirm the identity — many players share names.

2. **Understand the opponent.** Call \`get_player_profile\` for the opponent. Read out:
   - Current classical / rapid / blitz ratings.
   - Top openings as White and Black (from openingRepertoire).
   - Career win / draw / loss splits — is the draw rate above ~40%? That's a stylistic hint (drawish opponents need to be unbalanced).
   - Notable wins and worst losses — patterns?

3. **Weight games by quality when interpreting the data.**
   - Recent games (last 12-24 months) matter far more than old ones. Opening repertoires evolve.
   - Classical over-the-board games are the strongest signal — that's what real preparation reveals.
   - Rapid and blitz reveal what they play under time pressure but may include experiments.
   - Online games are useful but noisier (blitz gambits, alt accounts).

4. **Walk the opponent's repertoire against ${me}'s color.** Call \`prepare_opponent\` once with the opponent's FIDE ID (add \`chesscom\` / \`lichess\` sources if you know their handles), filtered to the color they'll have in this game — plus \`start_month\` (last 12-24 months) and \`time_control: "classical"\` if you want the strongest signal. That returns a session \`token\`. Then walk the tree with \`get_prep_position(session_token=token, node_id="r")\`, pick the opponent's most-played reply, call again as you descend. Look for:
   - **Weak lines**: variations where the opponent scores below 40% as their side.
   - **Shallow lines**: openings the opponent has played only a few times — probably less deeply prepared.
   - **Abandoned lines**: openings they used to play but stopped. Something went wrong; may not want to revisit.
   - **Variety**: places where the opponent picks different moves game to game — those are branching points where they can't predict your prep.

5. **Style considerations.**
   - High draw rate → propose openings that unbalance early (Benoni, King's Indian, gambit lines).
   - Sharp tactician → don't play their prepared attacks; steer toward quiet positional lines.
   - Endgame strong → keep queens on and keep complications.

6. **Cross-check head-to-head.** Call \`get_head_to_head\` on the two players. If they've met before, what openings decided those games? Anything the opponent showed only against ${me}?

7. **Deliver a concrete plan.** Summarize:
   - What the opponent will likely play on move 1 (with confidence level).
   - The 2-3 branching points where the opponent is weakest for ${me}'s color.
   - The concrete move sequence ${me} should aim for to steer into those positions.
   - What to avoid — the opponent's strongest weapons.

Don't just dump data. Reason about it. Cite specific numbers (game counts, win rates, dates) so the user can trust your conclusions.`;
};

// ── Server wiring ──────────────────────────────────────────────────

const server = new Server(
  { name: "chessceo-mcp", version: process.env.npm_package_version ?? "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const promptArgs: Record<string, string | undefined> = {};
  if (args) for (const [k, v] of Object.entries(args)) promptArgs[k] = String(v);

  let text: string;
  switch (name) {
    case "prepare_for_game":
      text = PREP_WORKFLOW(promptArgs);
      break;
    case "scout_player": {
      const p = promptArgs.player ?? "the player";
      text = `Produce a scouting report on ${p}. Steps:
1. \`search_player\` to get their FIDE ID.
2. \`get_player_profile\` — pull rating history, career splits by color and time control, opening repertoire, opponent analysis, top events, notable wins and losses.
3. Weight the data: recent (last 12-24 months) > older, classical OTB > rapid/blitz > online.
4. \`prepare_opponent\` twice (once per colour, or once with two sources), then \`get_prep_position(session_token, node_id="r")\` to summarise their opening choices with actual frequencies and win rates. Filter with \`start_month\` if you only care about their current repertoire.
5. Deliver: current strength, characteristic openings, one-sentence style read, biggest wins, biggest losses / recurring weakness. Cite the numbers.`;
      break;
    }
    case "engine_usage_primer":
      text = ENGINE_USAGE_DOC;
      break;
    case "prep_strategy_primer":
      text = PREP_STRATEGY_DOC;
      break;
    case "head_to_head_briefing": {
      const a = promptArgs.player_a ?? "player A";
      const b = promptArgs.player_b ?? "player B";
      text = `Briefing on the ${a} vs ${b} history. Steps:
1. Resolve both FIDE IDs with \`search_player\`.
2. \`get_head_to_head\` for the pair — pull overall + per-color W/D/L (from ${a}'s perspective), splits by time format, first / last meeting, most-played openings between them, average game length.
3. Read the pattern: who has the edge, in which colour, in which time format. Which openings decide the meetings? Anything unusual — very drawish, very sharp, big rating gap?
4. If either player is currently live in a tournament, note it with \`list_player_live_tournaments\`.
5. Deliver a one-paragraph read: score, dominant openings, one-line style clash, current form.`;
      break;
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }

  return {
    description: `chessceo prompt: ${name}`,
    messages: [
      { role: "user", content: { type: "text", text } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, (args ?? {}) as Args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

// ── Transport selection ────────────────────────────────────────────
//
// Two modes:
//   stdio        (default)  — local subprocess, host spawns via npx / config.
//                             Every existing Claude Desktop / Cursor / Claude Code
//                             install of this package uses stdio.
//   http         (--transport=http --http-port=8080)
//                            — remote MCP over Streamable HTTP. Bind to a port,
//                              expose /mcp, users add the URL to their host
//                              instead of running npx. This is what
//                              claude.ai / mobile / other zero-install hosts
//                              need. Stateless mode: each request creates a
//                              fresh transport + response, no session
//                              persistence, safe to scale horizontally.

const argv = process.argv.slice(2);
const arg = (name: string, def?: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const cur = argv[i];
  return cur.includes("=") ? cur.split("=").slice(1).join("=") : argv[i + 1];
};

const transportKind = (arg("transport", process.env.MCP_TRANSPORT ?? "stdio") ?? "stdio").toLowerCase();

if (transportKind === "stdio") {
  await server.connect(new StdioServerTransport());
} else if (transportKind === "http" || transportKind === "streamable-http") {
  const port = Number(arg("http-port", process.env.MCP_HTTP_PORT ?? "8080"));
  const host = arg("http-host", process.env.MCP_HTTP_HOST ?? "127.0.0.1") ?? "127.0.0.1";
  const path = arg("http-path", process.env.MCP_HTTP_PATH ?? "/mcp") ?? "/mcp";

  // Read a JSON body off req into memory. Bodies are tiny (JSON-RPC), so
  // no streaming needed; guard against absurd payloads with a hard cap.
  const MAX_BODY = 1_048_576; // 1 MB
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_BODY) {
          req.destroy();
          reject(new Error("body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text.length === 0 ? undefined : JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Basic CORS so browser-based MCP hosts can call us cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Liveness — cheap health check for load balancers / uptime monitors.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("ok\n");
      return;
    }

    const urlPath = (req.url ?? "").split("?")[0];

    // RFC 9728 protected-resource metadata. MCP hosts (claude.ai, ChatGPT)
    // fetch this after receiving a 401 with WWW-Authenticate below; it
    // points them at chess.ceo's OAuth 2.1 authorization server, which
    // handles registration (DCR), consent, and token issuance.
    if (req.method === "GET" && urlPath === "/.well-known/oauth-protected-resource") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(JSON.stringify({
        resource: "https://mcp.chess.ceo/mcp",
        authorization_servers: ["https://chess.ceo"],
        scopes_supported: ["agent"],
        bearer_methods_supported: ["header"],
      }));
      return;
    }

    // Everything else must hit the MCP path.
    if (urlPath !== path) {
      res.statusCode = 404;
      res.end();
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const authHeader = req.headers["authorization"];
      const authHeaderStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;

      // If the caller is invoking an authed tool without a token, respond
      // with 401 + WWW-Authenticate pointing at RFC 9728 metadata BEFORE
      // handing off to the MCP SDK — MCP hosts (claude.ai, ChatGPT) look
      // for this header at the HTTP layer to auto-start OAuth discovery.
      if (!authHeaderStr && isAuthedToolCall(body)) {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer realm="chess.ceo", resource_metadata="https://mcp.chess.ceo/.well-known/oauth-protected-resource"`,
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "authentication required" },
          id: (body as { id?: unknown } | undefined)?.id ?? null,
        }));
        return;
      }

      // Stateless: one transport per request, no session store. Simpler,
      // scales trivially, matches how claude.ai / ChatGPT connectors call.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      // Forward the caller's Authorization header down to tool handlers so
      // they can attach it when calling authenticated backend endpoints.
      // AsyncLocalStorage survives every await inside the tool handler.
      await authContext.run({ authHeader: authHeaderStr }, async () => {
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`chessceo-mcp: streamable-http on http://${host}:${port}${path}`);
  });

  // Graceful shutdown so `systemctl stop` doesn't leak connections.
  const shutdown = (sig: string) => {
    console.error(`chessceo-mcp: ${sig} received, closing`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  console.error(`chessceo-mcp: unknown --transport '${transportKind}' (expected stdio or http)`);
  process.exit(2);
}
