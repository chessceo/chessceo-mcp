#!/usr/bin/env node
// chess.ceo MCP server. Exposes the public GET API as MCP tools so LLM
// hosts (Claude Desktop, Cursor, etc.) can look up players, positions,
// preparation stats, and live broadcast state directly.
//
// Everything here is a thin wrapper around https://chess.ceo/api/chess/*
// endpoints — see the public contract at https://chess.ceo/llms.txt.
// No API key, no auth, no state; the API's own rate limits apply.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
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
  setComment,
  setNags,
  setTag,
} from "./pgn/mutations.js";
import { buildIdIndex, NodeIdError, PathError, resolveNodeId, ROOT_ID } from "./pgn/paths.js";
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
  type Prompt,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.CHESSCEO_BASE_URL ?? "https://chess.ceo";
const UA = `chessceo-mcp/${process.env.npm_package_version ?? "0.1.0"} (+https://chess.ceo)`;

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

// ── HTTP ────────────────────────────────────────────────────────────
//
// Two auth flavours coexist:
//   - Anonymous GETs (players, positions, prep, live) — no auth.
//   - Authed tools (cloud engines) — `Authorization: Bearer mcp_...`.
//
// The token comes from one of two sources:
//   - stdio: `CHESSCEO_TOKEN` env var, set by the MCP host config. Bare
//     `mcp_...` — we prepend the `Bearer ` scheme when building the header.
//   - streamable-http: the caller's `Authorization` header, forwarded
//     per-request via AsyncLocalStorage so tool handlers can see it even
//     though the MCP SDK's request handler doesn't know about HTTP.

const authContext = new AsyncLocalStorage<{ authHeader: string | undefined }>();

// Tools that require an MCP token — cloud engine tools operate on the
// user's rented instances so we can't service them anonymously. The
// streamable-http transport uses this list to decide whether to trigger
// the OAuth discovery flow via 401 + WWW-Authenticate before the SDK
// gets a chance to handle the call.
const AUTHED_TOOLS = new Set([
  "start_cloud_engine",
  "list_cloud_engines",
  "stop_cloud_engine",
  "cloud_analyse",
  "list_prep_files",
  "search_prep_files",
  "read_prep_file",
  "create_prep_file",
  "delete_prep_file",
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
  "quote_engine_eval",
  "predict_human_move",
]);

function isAuthedToolCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { method?: unknown; params?: { name?: unknown } };
  if (b.method !== "tools/call") return false;
  const name = b.params?.name;
  return typeof name === "string" && AUTHED_TOOLS.has(name);
}

function resolveAuthHeader(): string | undefined {
  const store = authContext.getStore();
  if (store?.authHeader) return store.authHeader;
  const env = process.env.CHESSCEO_TOKEN?.trim();
  if (!env) return undefined;
  return env.toLowerCase().startsWith("bearer ") ? env : `Bearer ${env}`;
}

async function get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) {
    // Bubble up the ProblemDetail body when the API returns one — LLM can
    // then correct the query (e.g. wrong fideId) rather than retry blind.
    let body: string;
    try { body = await res.text(); } catch { body = ""; }
    throw new Error(`chess.ceo ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// authedRequest is the shared code path for POST/GET/DELETE calls that need
// an MCP token. Missing-token errors are surfaced early with a message the
// LLM can act on (either configure CHESSCEO_TOKEN or generate a token in
// user settings) rather than a generic 401 from the backend.
async function authedRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = resolveAuthHeader();
  if (!auth) {
    throw new Error(
      "No MCP token available. Set CHESSCEO_TOKEN env (stdio mode) or pass an " +
        "Authorization: Bearer mcp_... header (streamable-http mode). Generate " +
        "a token at chess.ceo → user settings → MCP tokens.",
    );
  }
  const url = new URL(path, BASE);
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Authorization": auth,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`chess.ceo ${res.status}: ${text.slice(0, 500)}`);
  }
  return text.length ? JSON.parse(text) : null;
}

// ── Tool definitions ───────────────────────────────────────────────
//
// Descriptions are written for the LLM, not humans — they should hint
// at when to call the tool, what inputs mean, and what the response
// contains. Terse is fine; the LLM already reads the parameter names.

const TOOLS: Tool[] = [
  {
    name: "search_player",
    description:
      "Fuzzy name lookup for FIDE-rated chess players. Returns candidate matches with their FIDE ID, current rating, title (GM/IM/etc.), and country. Use this to resolve a plain-English name (e.g. 'Carlsen', 'Ding Liren') to the FIDE ID that every other tool needs.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Player name or partial name. Case-insensitive, fuzzy.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_player_profile",
    description:
      "Full stats for one player: identity, monthly rating history, peak / trend stats, career W/D/L by color and time control, top-10 openings as White and Black, opponent analysis by rating bracket, notable wins and worst losses, top events with performance ratings. Often enough on its own for 'how strong is X, what do they play, who have they beaten'.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id: {
          type: "integer",
          description: "FIDE ID from search_player.",
        },
      },
      required: ["fide_id"],
    },
  },
  {
    name: "get_player_preparation",
    description:
      "For a given player, colour and starting position, return both the moves the player actually chose (frequency + win rate) and the underlying games. Position is specified either as a move sequence in SAN (`line`) or a raw FEN. Use `line` iteratively to walk the opening tree: call once with empty `line`, pick a move, call again with `line` extended by that move, etc.\n\n" +
      "GROUNDING: every claim about the opponent's repertoire must trace back to this tool's output. Don't assert 'they play sharply' or 'they hate isolated queen pawn' without pointing at the actual game counts / win rates in the response. Don't invent 'the opponent typically plays X' — check first. Compute is cheap: run this on more branches instead of pattern-matching from a chess book.\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes `.eval` with a compact Stockfish + Lc0 read at the requested position (top move + score + PV) and the corresponding NAG. Do NOT fire a separate cloud_analyse for the same FEN — the eval is right there.\n\n" +
      "Reading the response — CRITICAL:\n" +
      "• Win % is one weight, not a verdict. Recommend 1.b3 over 1.d4 because 60% > 50% is wrong. Sample size matters (3 games at 66% is noise; 300 at 55% is signal); avgWhite / avgBlack per move show the rating context (a big score often means a rating gap, not repertoire truth).\n" +
      "• Prep is symmetric information — both sides see the same history. Assume the opponent knows the weakness you spotted; a weak opponent won't patch it, a strong or improving one already has (but structural weaknesses like 'bad in Catalan structures' hold anyway).\n" +
      "• Recency > career. The last 12-24 months dominate. This endpoint's compact/LLM view deliberately omits per-move `fashionScore` — at the individual level it's trailing noise. The general DB endpoint (`get_position_stats`) keeps it, where it's real fashion signal (what the top field is playing this month).\n" +
      "• Opponent will deviate early. Prep is a tree, not a line — cover the 2 most likely replies at each real branching point, not one 20-move line.\n" +
      "• Surprise is a scalpel. Don't tell a lifelong 1.e4 player to switch to 1.d4 — meta-signal screams prep. Rare secondary lines within the user's existing repertoire (e.g. 6.Bc4 instead of usual 6.Bg5 vs the Najdorf) are where surprise is real.\n\n" +
      "For the full guide call the `read_prep_strategy_guide` tool.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id: { type: "integer", description: "FIDE ID from search_player." },
        color: {
          type: "string",
          enum: ["white", "black"],
          description: "Which colour the player is analysed with.",
        },
        file_id: {
          type: "string",
          description: "Prep file id to address the position from. Combine with `node_id` — the server derives the FEN from the tree, so you don't paste a FEN string. **Prefer this over `fen`/`line`/`moves` when a prep file is open.**",
        },
        node_id: {
          type: "string",
          description: "Node id inside `file_id` whose position to query. Root is 'r'. When set, overrides `fen`/`line`/`moves`.",
        },
        line: {
          type: "string",
          description:
            "Move sequence in SAN from the starting position, space-separated, no move numbers required. Example: 'e4 e5 Nf3'. Leave empty for startpos. Alias: `moves` (same thing). Only used if `node_id` is not set.",
        },
        moves: {
          type: "string",
          description:
            "SAN moves to apply on top of `fen` (or on top of startpos if no fen). Same shape as `line`. Wins over `line` if both are set. Only used if `node_id` is not set.",
        },
        fen: {
          type: "string",
          description: "Starting position as FEN. Combine with `moves` to walk from there, or use alone. Only used if `node_id` is not set.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of games to return (max 10 per request; page with offset).",
        },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["fide_id", "color"],
    },
  },
  {
    name: "get_position_stats",
    description:
      "Move statistics + example games at a position. Answers 'how often is 4.O-O vs 4.d3 played here and which scores better'.\n\n" +
      "SOURCE (default: `gm-classical`) selects a pre-aggregated database shard:\n" +
      "- `gm-classical` — GM classical games (both players ≥2500, real thinking-time). BEST for opening prep — every move is signal, avgElo ~2600 across all listed moves.\n" +
      "- `main` — the whole 11.7M-game DB. Widest coverage but noisiest (includes 1000-Elo blunder-fests in the move stats). Use as fallback when gm-classical's totalCount is too small to be informative.\n\n" +
      "Game movetext is trimmed to the moves AFTER the queried position (using each game's plyNumber). Saves ~70% of the bytes vs full movetext.\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes `.eval` with a compact Stockfish + Lc0 read and the corresponding NAG. Do NOT fire cloud_analyse separately for the same FEN. When called with `file_id`+`node_id`, the eval is also auto-stored on that node's `ceoEval` — later readable via quote_engine_eval.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Prep file id. **Prefer file_id+node_id over `fen`** when a prep file is open — the server derives the FEN from the tree.",
        },
        node_id: {
          type: "string",
          description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`/`line`.",
        },
        fen: {
          type: "string",
          description: "Starting position as FEN. Combine with `moves`. Only used if `node_id` is not set.",
        },
        moves: {
          type: "string",
          description: "Optional SAN moves on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        line: {
          type: "string",
          description: "Synonym for `moves` from startpos; kept for compatibility.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Number of example games to return (default 10).",
        },
        source: {
          type: "string",
          enum: ["gm-classical", "main"],
          description: "Which database shard to query. Default `gm-classical`. Switch to `main` only when gm-classical's totalCount is too low.",
        },
      },
    },
  },
  {
    name: "describe_position",
    description:
      "Structured facts about a chess position: piece placements per colour (SAN-style letters), material balance in pawn units, list of every contested piece (attackers + defenders), hanging pieces, checkers if in check, castling rights, en passant square, side to move, and the full list of LEGAL MOVES for the side to move. Pure computation — no engine, ~1 ms per call.\n\n" +
      "USE THIS BEFORE COMMENTING ON A POSITION. LLMs are not reliable at reading FEN strings — you'll misplace pieces or invent captures. This tool gives you the same board state a human sees.\n\n" +
      "ALSO USE THIS if `add_move` rejects an illegal SAN — the `.legalMoves` array shows exactly what's playable from that position.\n\n" +
      "Position input: prefer `file_id`+`node_id` if you're inside a prep file. Otherwise `fen`, `moves` from startpos, or `fen + moves`.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. When combined with `node_id`, describes that node's position." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'." },
        fen:     { type: "string", description: "Starting position as FEN (defaults to startpos). Only used if `node_id` is not set." },
        moves:   { type: "string", description: "Optional SAN moves to apply on top of `fen`. Only used if `node_id` is not set." },
      },
    },
  },
  {
    name: "predict_human_move",
    description:
      "Predicts what a HUMAN of the given rating will most likely play from a position. Rating-conditioned neural net (ResNet-20x256) — you get the top-N most likely moves with their probabilities and a WDL value head (White POV).\n\n" +
      "This is a completely different question from the engine tools (analyse / cloud_analyse):\n" +
      "• Engines answer: 'what is objectively best?'\n" +
      "• predict_human_move answers: 'what will my 2200-rated opponent actually play here?'\n\n" +
      "Prime use cases in prep:\n" +
      "• After you've found what the opponent SHOULD do (with the engine), check what they'll ACTUALLY do at their rating. If the top human move is a mistake, you have a real practical advantage.\n" +
      "• The WDL head is rating-aware — a 400-point gap will show up as a big win probability even in equal positions (the model has learned that human errors compound).\n" +
      "• Pass `prev_fen` (most recent first) when analysing mid-trade positions — without history the model treats the position as quiet.\n\n" +
      "Position input: prefer `file_id`+`node_id` when inside a prep file. Otherwise `fen`, `moves` from startpos, or `fen + moves`. Default rating 2400 both sides. ~1-2s per call. **Premium (or admin/moderator) only** — anonymous calls get 402.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. Combine with `node_id` to point at a tree node's position." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'." },
        fen: { type: "string", description: "Starting position as FEN. Only used if `node_id` is not set." },
        moves: {
          type: "string",
          description: "Optional SAN moves to apply on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        white_elo: {
          type: "integer",
          minimum: 100,
          maximum: 3400,
          description: "White's rating (default 2400).",
        },
        black_elo: {
          type: "integer",
          minimum: 100,
          maximum: 3400,
          description: "Black's rating (default 2400).",
        },
        top: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of top predicted moves to return (default 5).",
        },
        prev_fens: {
          type: "array",
          items: { type: "string" },
          description: "Previous FEN(s), most recent first. Optional — omit for quiet-position analysis. Useful mid-trade so the model doesn't assume the position is stable.",
        },
      },
    },
  },
  {
    name: "get_head_to_head",
    description:
      "Complete head-to-head record between two players. Includes overall and per-colour W/D/L (from player A's perspective), splits by time control, most-played openings between them, first / last meeting, average game length, and the game list.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id_a: { type: "integer", description: "FIDE ID of player A (record is from A's perspective)." },
        fide_id_b: { type: "integer", description: "FIDE ID of player B." },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["fide_id_a", "fide_id_b"],
    },
  },
  {
    name: "list_live_tournaments",
    description:
      "Tournaments currently being broadcast live on chess.ceo. Use this when the user asks 'what's on right now' / 'live tournaments today'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tournament_players",
    description: "Players participating in one live-broadcast tournament.",
    inputSchema: {
      type: "object",
      properties: {
        tour_id: { type: "string", description: "Tournament ID from list_live_tournaments." },
      },
      required: ["tour_id"],
    },
  },
  {
    name: "list_player_live_tournaments",
    description:
      "Which currently-live broadcasts a given player is competing in. Use when the user asks 'is X playing anywhere right now'.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id: { type: "integer", description: "FIDE ID from search_player." },
      },
      required: ["fide_id"],
    },
  },
  {
    name: "list_cloud_machine_options",
    description:
      "Returns the catalog of combo cloud-engine machine types the user can start (SKU, human display name, cost per hour, availability). ALWAYS call this before start_cloud_engine — SKU strings like 'rtx-5090-64' do not match the display names ('Stockfish 32 CPUs + Lc0 1× RTX 5090') and are NOT guessable. Present the user the display names + prices; pass the SKU to start_cloud_engine.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_cloud_engine",
    description:
      "Rent a combo GPU instance (Stockfish + Lc0 in the same container) on the user's chess.ceo account. Real money — billed per second while running.\n\n" +
      "CRITICAL: `machine_type` must be an exact SKU from `list_cloud_machine_options` (e.g. 'rtx-5090-64', NOT 'rtx-5090'). Guessing SKUs will fail. Call list_cloud_machine_options first, show the user the display names + prices, get their confirmation, then pass the SKU here.\n\n" +
      "Use list_cloud_engines first to check if the user already has one running; don't start a second combo unless the user asked for it. Requires an MCP token with agent access.",
    inputSchema: {
      type: "object",
      properties: {
        machine_type: {
          type: "string",
          description:
            "SKU from list_cloud_machine_options (e.g. 'rtx-5090-64', 'rtx-5090-dual-64'). MUST be the exact SKU, not the display name and not a guess.",
        },
      },
      required: ["machine_type"],
    },
  },
  {
    name: "list_cloud_engines",
    description:
      "List the user's currently running cloud engines. Use before starting a new one, or to find the contract_id for stop_cloud_engine. `cloud_analyse` auto-picks the only running combo, so listing is only necessary when the user might have zero or several.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_cloud_engine",
    description:
      "Destroy a running cloud engine. Billing stops immediately. Use the contract_id from `list_cloud_engines` — don't guess.",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: {
          type: "string",
          description: "Instance contract_id, from list_cloud_engines.",
        },
      },
      required: ["contract_id"],
    },
  },
  {
    name: "cloud_analyse",
    description:
      "Runs a synchronous ~2s analysis on the user's running combo instance and returns both Stockfish and Lc0's final read for the FEN — depth, top-N candidate moves with scores (centipawns from side-to-move POV, or mate distance), and each engine's principal variation.\n\n" +
      "GROUNDING: every claim you make about a position must trace back to actual engine output from a call in THIS session. Don't invent evaluations, don't name 'best moves' you haven't seen the engine list, don't fabricate variations that 'look plausible.' Compute is cheap — call this 5-10 times while walking a tree rather than pattern-matching from your training data. When you don't have data for the position, either run the tool or say so; don't fill the gap with chess prose the user can't distinguish from measured output.\n\n" +
      "Auto-picks the caller's only running combo instance; errors clearly if there are zero (start one first with start_cloud_engine) or more than one (destroy the extras first).\n\n" +
      "How to read the response:\n" +
      "• Stockfish is objective truth — trust it for 'does this line hold?' 'is there a tactic?' 'is this endgame drawn?' A Stockfish 0.00 means 'objectively equal', NOT 'trivial draw' — one side can still be much harder to play in practice.\n" +
      "• Lc0 is practical eval — trust it for 'which side is easier?' 'which candidate is best when Stockfish shows several as equal?' Lc0 sees long-term positional factors Stockfish's fixed search can miss.\n" +
      "• When they agree → high confidence. When they disagree → look at both scores and reason WHY (Stockfish sharply higher = tactic Lc0 missed; Lc0 higher = long-term positional edge past Stockfish's horizon). Never dismiss either — the disagreement is the signal.\n\n" +
      "Contempt (`contempt`) skews Lc0 (only Lc0 — Stockfish always stays objective) toward White (positive) or Black (negative). Signed 0-100 strength — same scale as the web UI's ContemptStrength slider (the server multiplies by 8 to produce Lc0's internal cp bias). Typical values: ±15 for a light nudge, ±30-60 for real fighting play, ±80-100 for maximum steer. Use it to find non-objective 'practical' ideas or when the user needs to lean toward fighting/solid lines with a specific colour. Do NOT quote a contempt-biased eval as objective — cross-check with Stockfish.\n\n" +
      "Also useful: pass `moves` on top of `fen` to explore a variation without computing FENs yourself (e.g. fen='<tabiya>', moves='b4 a5 c3'). And the flip-side-to-move threat check documented in the guide is a great free trick.\n\n" +
      "For the full guide including worked examples, call the `read_engine_usage_guide` tool.\n\n" +
      "Not for casual questions — this costs real money per second. Use `get_position_stats` for anything that doesn't require deep prep.\n\n" +
      "**When called with `file_id`+`node_id` (preferred inside a prep file), the resulting eval is auto-stored on that node's `ceoEval` — you can then quote it with quote_engine_eval on any later call.** This is what makes engine attribution trustworthy: prose that says 'engines say X on node Y' can only be true if a call was actually made against node_id=Y.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. **Prefer file_id+node_id over fen** when inside a prep file — the FEN comes from the tree AND the result is stored on the node." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`." },
        fen: { type: "string", description: "Starting position as FEN. Only used if `node_id` is not set." },
        moves: {
          type: "string",
          description: "Optional SAN moves to apply on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        movetime_ms: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          description: "Think time in milliseconds (default 2000).",
        },
        multipv: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of candidate lines per engine (default 3).",
        },
        contempt: {
          type: "integer",
          minimum: -100,
          maximum: 100,
          description:
            "Lc0 contempt bias. Signed 0-100 strength (same scale as the web UI's ContemptStrength slider — server multiplies by 8 to get the internal cp bias). 0 = objective (default). Positive favours White, negative favours Black. Typical: ±15 light nudge, ±30-60 real fighting play, ±80-100 maximum steer. Not applied to Stockfish. See engine_usage_primer for when to use.",
        },
      },
    },
  },
  {
    name: "list_prep_files",
    description:
      "List every prep file the user has (all games inside their dedicated AI Prep collection). Returns id, PGN tags (Event, White, Black, Date, etc. — read the Event tag for the user-facing name), size, updated_at. ALWAYS call this before create_prep_file to check for existing coverage — creating a second 'Prep vs Firouzja' when one already exists is a common LLM failure. If the user has many, use search_prep_files with a query to narrow down.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_prep_files",
    description:
      "Text search over the user's prep files (matches PGN headers, comments, and content). Use this instead of list_prep_files when you know a keyword — e.g. search_prep_files(query='Firouzja') or search_prep_files(query='Najdorf').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query (opponent name, opening name, event keyword)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_prep_file",
    description:
      "Read one prep file. Returns a compact tree (each node carries a stable `id`, `san`, `fen`, `ply`, optional `comment`/`nags`/`annotations`/`ceoEval`, and `children`) plus tags and the `version` for optimistic locking on subsequent mutations. NO raw PGN — all edits go through the mutation tools (add_move / add_line / set_comment / set_nags / set_annotations / delete_subtree / promote_variation / set_tag), which validate SAN and structure for you.\n\n" +
      "**Node addressing.** Every node has a stable `id` — root is `'r'`, every other node is an 8-hex-char content hash derived from its parent's id + its SAN. Sibling insertions, deletions and variation promotions do NOT change any other node's id. Pass this id as `node_id` (or `parent_id` for add_move / add_line) to every mutation and engine/DB tool.\n\n" +
      "**Every engine/DB tool accepts `file_id`+`node_id`** (get_position_stats, cloud_analyse, describe_position, predict_human_move, prep_snapshot, get_player_preparation, quote_engine_eval). Use it whenever a file is open — the server derives the FEN from the tree, so you can't 'analyse the wrong position' by mis-typing a FEN.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prep file id, from list_prep_files or search_prep_files." },
      },
      required: ["id"],
    },
  },
  {
    name: "create_prep_file",
    description:
      "Create a new (empty) prep file. `name` becomes the Event PGN tag. You then extend it with mutation tools (add_move, set_comment, …).\n\n" +
      "ALWAYS call list_prep_files (or search_prep_files with the opponent / opening keyword) FIRST — creating a duplicate 'Prep vs Firouzja' when one exists is the #1 LLM failure mode. If a file already covers the topic, add moves to that one instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "User-facing name — becomes the [Event] tag. Example: 'Prep vs Firouzja (Black) 2026-07-23'.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_prep_file",
    description:
      "Soft-delete a prep file. User can restore from the app's recycle bin. Rare — usually you extend or edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prep file id." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_move",
    description:
      "Append a move as a new child of the node identified by `parent_id`. If the parent already has children, the new move becomes a variation (appended at the end); use promote_variation afterwards to make it the mainline. SAN is validated against the position — illegal moves are rejected with a clear error.\n\n" +
      "Auto-saves. Returns `{node_id, version}` — the id of the new node (pass this to follow-up set_comment / set_nags / etc.) and the new file version for optimistic locking. **Node ids are content-derived and stable** — sibling insertions, deletions, and promotions do NOT change any other node's id.",
    inputSchema: {
      type: "object",
      properties: {
        id:        { type: "string", description: "Prep file id." },
        parent_id: { type: "string", description: "Node id of the parent (the position the move is played FROM). Root id is 'r'." },
        san:       { type: "string", description: "The move in SAN notation (e.g. 'Nf3', 'exd5', 'O-O', 'Qxf7+')." },
        expected_version: { type: "integer", description: "Optimistic-lock check; pass the `version` from your last read." },
      },
      required: ["id", "parent_id", "san"],
    },
  },
  {
    name: "add_line",
    description:
      "Append a linear sequence of moves under `parent_id`. Each SAN in the list becomes the mainline child of the previous — one call instead of N add_move calls for a straight variation. If the parent already has other children, this whole line is appended as a variation (promote_variation the first move if you want it as the mainline).\n\n" +
      "Auto-saves. Returns `{node_id, line: [{node_id, san}, ...], version}` — `node_id` is the last (leaf) node's id, `line` is every node created in order so you can address any of them next.",
    inputSchema: {
      type: "object",
      properties: {
        id:        { type: "string", description: "Prep file id." },
        parent_id: { type: "string", description: "Node id of the parent to build from. Root is 'r'." },
        sans:      { type: "array", items: { type: "string" }, minItems: 1, description: "SAN moves in order, e.g. ['e4','e5','Nf3','Nc6','Bb5']." },
        expected_version: { type: "integer" },
      },
      required: ["id", "parent_id", "sans"],
    },
  },
  {
    name: "set_comment",
    description:
      "Set (or clear, with empty string) the text comment on the node identified by `node_id`. Comments are for plans, prep-signal, and interpretation the app can't derive — NOT for describing moves that should be variations instead. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "Prep file id." },
        node_id: { type: "string", description: "Node id from read_prep_file / add_move." },
        comment: { type: "string", description: "New comment text. Empty string clears." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id", "comment"],
    },
  },
  {
    name: "set_nags",
    description:
      "Replace the list of NAGs on the node identified by `node_id`. Empty array clears them. NAGs are your EDITORIAL call — see read_pgn_authoring_guide for the discipline (novelty $146, sharp choice $5, decisive $18/$19, etc.). Do NOT set $10 '=' on every equal position; that's board noise. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        nags:    { type: "array", items: { type: "string", pattern: "^\\$\\d+$" }, description: "NAG list, e.g. ['$14'] or ['$146', '$44']." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id", "nags"],
    },
  },
  {
    name: "set_annotations",
    description:
      "Replace the visual annotations (arrows + coloured squares) on the node identified by `node_id`. Passing empty arrays clears them.\n\n" +
      "Colours: green, red, yellow, light-blue, dark-blue, orange. Keep it LIGHT: 1-3 arrows and 2-3 squares per move maximum. Twenty arrows is noise, not signal. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        arrows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color: { type: "string", enum: ["green", "red", "yellow", "light-blue", "dark-blue", "orange"] },
              from:  { type: "string", pattern: "^[a-h][1-8]$" },
              to:    { type: "string", pattern: "^[a-h][1-8]$" },
            },
            required: ["color", "from", "to"],
          },
        },
        highlights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color:  { type: "string", enum: ["green", "red", "yellow", "light-blue", "dark-blue", "orange"] },
              square: { type: "string", pattern: "^[a-h][1-8]$" },
            },
            required: ["color", "square"],
          },
        },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "delete_subtree",
    description:
      "Delete the node identified by `node_id` and all its descendants. Refuses to delete the root. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "promote_variation",
    description:
      "Make the node identified by `node_id` its parent's mainline (children[0]), demoting the current mainline (and any other siblings) into variation order. Silently no-op if already the mainline. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string", description: "Node id of the variation to promote. Cannot be root." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "apply_mutations",
    description:
      "Batch: apply a list of mutations in one call. One load-parse-mutate-export-save cycle for N ops, so building a 100-move repertoire costs one HTTP round-trip and one save instead of 100. This is the RIGHT way to build a file — use single mutations only for surgical follow-up edits.\n\n" +
      "Each mutation is `{op, node_id | parent_id, ...args}` where `op` is one of: add_move, add_line, set_comment, set_nags, set_annotations, delete_subtree, promote_variation, set_tag. Same arg shape as the individual tools. Ops apply in order; because node ids are content-derived (hash of parent_id + san), a node created by an early op has a deterministic id you can reference in later ops in the same batch.\n\n" +
      "Any op error aborts the batch (nothing saved). Response is `{ok, results: [{node_id, line?}], version}` — one entry per op with the id it landed on (add_line also returns the full line array).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        expected_version: { type: "integer" },
        mutations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add_move", "add_line", "set_comment", "set_nags", "set_annotations", "delete_subtree", "promote_variation", "set_tag"] },
              node_id:   { type: "string" },
              parent_id: { type: "string" },
              san:  { type: "string" },
              sans: { type: "array", items: { type: "string" } },
              comment: { type: "string" },
              nags: { type: "array", items: { type: "string", pattern: "^\\$\\d+$" } },
              arrows: { type: "array" },
              highlights: { type: "array" },
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["op"],
          },
        },
      },
      required: ["id", "mutations"],
    },
  },
  {
    name: "auto_evaluate",
    description:
      "Walk the tree from `node_id` (default `'r'` = whole file) and populate the persistent `ceoEval` (Stockfish + Lc0 numbers) on every descendant via cloud_analyse. Requires a running cloud combo instance.\n\n" +
      "**Does NOT set visible NAGs.** NAG placement is your call, not the engine's — an opening tree full of 0.00 positions doesn't need a `$10` (=) glyph on every move (that's just noise on the board), and a `!` on a novelty or a `?!` on a risky committal is a judgment call the engine can't make. Use this tool to persist the raw numbers on every node, then re-read the file and hand-pick NAGs on the moves where a glyph carries real signal.\n\n" +
      "On re-read every evaluated node carries `ceoEval: { sf: {cp, depth}, lc0: {cp, depth} }` — the numbers travel with the file. Read those back with quote_engine_eval before writing prose that references engine numbers. Use `only_missing=true` (default) to skip nodes already evaluated on repeat runs.\n\n" +
      "Costs real money — hits cloud_analyse per node. A 200-node tree at 1.5s/node = ~5 min of engine time. Runs 4 evaluations in parallel to save wall time.",
    inputSchema: {
      type: "object",
      properties: {
        id:            { type: "string" },
        node_id:       { type: "string", description: "Subtree root (default 'r' = whole file)." },
        only_missing:  { type: "boolean", description: "Skip nodes that already carry a stored ceoEval (default true)." },
        movetime_ms:   { type: "integer", minimum: 500, maximum: 5000, description: "Per-node cloud_analyse think time (default 1500)." },
        expected_version: { type: "integer" },
      },
      required: ["id"],
    },
  },
  {
    name: "quote_engine_eval",
    description:
      "Return the stored engine eval for a node, or null if that node was never analysed. **Call this before writing prose or NAGs that quote engine numbers** — if it returns null, you have no measurement to cite. Do NOT infer an eval for the node from siblings or children; either analyse it (cloud_analyse with node_id) or omit the number from your prose.\n\n" +
      "Response: `{ ceoEval: { sf: {cp, depth}, lc0: {cp, depth}, nag } | null }`. `cp` is White-POV centipawns as an integer (+20 = +0.20). `nag` is the threshold-derived glyph as a SUGGESTION — promote to a visible NAG via set_nags only when a glyph on that move carries editorial signal.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "Prep file id." },
        node_id: { type: "string", description: "Node id whose stored eval you want to quote." },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "set_tag",
    description:
      "Set or clear a game-level PGN tag (Event, Site, Date, White, Black, Result, or any custom tag). Passing empty string removes the tag. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:    { type: "string" },
        key:   { type: "string", description: "Tag key, e.g. 'Event', 'White', 'Date'." },
        value: { type: "string", description: "Tag value. Empty string removes the tag." },
        expected_version: { type: "integer" },
      },
      required: ["id", "key", "value"],
    },
  },
  {
    name: "read_engine_usage_guide",
    description:
      "Returns the full chess.ceo engine-usage guide: when to trust Stockfish (objective truth) vs Lc0 (practical eval), how to read disagreements between them, and how to use Lc0 contempt to find non-objective 'practical' ideas. Call this ONCE per session before running expensive `cloud_analyse` calls or when the user asks WHY the engines gave certain scores. Same content is also available as the `engine_usage_primer` prompt (for clients that surface prompts as slash commands), but many clients do not expose prompts to the model — this tool works everywhere.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_prep_strategy_guide",
    description:
      "Returns the full chess.ceo prep-strategy guide: why win% is one weight not a verdict, why prep is a two-player game with symmetric information (opponent sees your history too), how sample size and recency change the reading, when 'revealed weaknesses' are actionable vs already patched, how to use move-order tricks with the `trs` field, and how to calibrate surprise (rare secondary lines inside the existing repertoire, not big first-move switches). Call this ONCE per session before recommending an opening plan, especially when the user is preparing for a specific real opponent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_prep_files_guide",
    description:
      "Returns the guide to the prep-files FEATURE — how the storage works, when to list vs search vs create, optimistic locking with `version`, and naming conventions for the [Event] tag. Call this ONCE per session before your first create_prep_file. For how to actually WRITE PGN (mainline, variations, NAGs, arrows, comments) call read_pgn_authoring_guide instead — separate concern.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_pgn_authoring_guide",
    description:
      "Returns the guide on how to write correct, useful PGN — mainline discipline, variations as moves (never prose describing moves), NAG symbols including novelty ($146), unclear ($13), compensation ($44) and the standard set, ChessBase arrow/coloured-square syntax ([%cal] / [%csl]), and common pitfalls the parser will reject. Call this ONCE per session before any save_prep_file call, or any time you're producing PGN output for the user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_example_prep_files",
    description:
      "Returns two full reference PGNs authored by a strong human coach — one a general opening overview (Italian Fried Liver, both sides, 1600+ audience) and one a one-sided repertoire (Najdorf 6.f4 for White, 2200+ audience). Bundled with the MCP; not the user's files.\n\n" +
      "Read these ONCE per session before writing your first substantial prep file. The authoring guide (read_pgn_authoring_guide) tells you the rules; these examples show you what the rules look like when applied by someone who knows what they're doing — comment density, when to cite games by player name, how to use `$146` / `$3` / `$44` sparingly and correctly, when a bare `[%csl Rf7]` says everything, how to acknowledge transpositions, how to phrase practical guidance vs objective evaluation. Study the rhythm before writing your own.\n\n" +
      "Response: `{ overview: <pgn>, repertoire: <pgn> }`. Raw PGN — comments, arrows, NAGs, and stored evals all intact.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prep_snapshot",
    description:
      "One call, three parallel fetches at the same position: opponent's stats on their side, your stats on your side, and the 11.7M-game general database at that position. Use this while walking the opening tree — one round trip instead of three separate calls, and you can compare the three views directly (e.g. opponent has 2 games here but the general DB has 8k → prep candidate).\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes a top-level `.eval` (Stockfish + Lc0 read at the shared position) so you get four signals in one call. Do NOT fire cloud_analyse separately for the same FEN.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id_me: { type: "integer", description: "Your FIDE ID." },
        fide_id_opponent: { type: "integer", description: "Opponent's FIDE ID." },
        my_color: { type: "string", enum: ["white", "black"], description: "The colour YOU will play." },
        file_id: { type: "string", description: "Prep file id. **Prefer file_id+node_id** when inside a prep file." },
        node_id: { type: "string", description: "Node id inside `file_id`. When set, overrides `line`/`fen`." },
        line: {
          type: "string",
          description:
            "Move sequence in SAN, space-separated. Empty = starting position. Only used if `node_id` is not set.",
        },
        fen: {
          type: "string",
          description: "Alternative to line — raw FEN of the target position. Only used if `node_id` is not set.",
        },
      },
      required: ["fide_id_me", "fide_id_opponent", "my_color"],
    },
  },
];

// ── Handlers ───────────────────────────────────────────────────────

type Args = Record<string, unknown>;

// Log every tool call in and out. Keeps args + response payloads together
// with a per-call duration so we can trace what the LLM asked for and what
// it got back on the same journalctl line. Response is JSON-stringified and
// capped so the two doc-reading tools (~5-10 KB of static markdown each)
// don't drown the log stream.
const LOG_MAX_CHARS = 4096;

// Convert a UCI move sequence into SAN by walking it move-by-move on
// chess.js from the given starting FEN. LLMs reason far better in SAN
// ("Nf3", "Bxc4") than UCI ("g1f3", "b5c4"), and matches how prep
// discussion is written in the real world. If a move fails to parse
// (illegal from the current position — bug or truncated PV), we
// truncate cleanly rather than throwing so the response still carries
// what we could convert.
function uciLineToSAN(startFen: string, uciMoves: string[]): string[] {
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

function uciMoveToSAN(startFen: string, uci: string): string {
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
type CompactEval = {
  nag: string | null;
  stockfish?: { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
  lc0?:       { cp?: number; mate?: number; bestMove?: string; pv?: string[] };
};

async function fetchCompactEval(fen: string): Promise<CompactEval | null> {
  try {
    const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse",
      { fen, movetime_ms: 1500, multipv: 1 });
    const converted = convertCloudSnapshotResponse(raw, fen);
    const stored = analysisToStoredEval(converted, fen);
    return storedEvalToCompact(stored, converted);
  } catch {
    return null;
  }
}

// Rewrite the /api/agent/cloud-engines/analyse response (two engines,
// each with lines[] and a bestMove) so PVs and bestMove come back in SAN.
function convertCloudSnapshotResponse(raw: unknown, startFen: string): unknown {
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

type EngineBlock = {
  lines?: Array<{ pv?: string[] }>;
  bestMove?: string;
};

// Extract a node id from the args. Accepts either `node_id` or a
// `parent_id` alias for the add-style tools. Throws with a helpful
// message if malformed.
function argNodeId(args: Args, key: "node_id" | "parent_id" = "node_id"): string {
  const raw = args[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`\`${key}\` is required (call read_prep_file to get valid node ids)`);
  }
  return raw.trim();
}

// Dispatch table for the batch tool: name → mutator that returns
// { file, id } where id is the node the mutation touched. The batch
// caller rebuilds the id → path index between ops so newly-created
// nodes are addressable within the same batch.
function dispatchMutation(
  file: PrepFile,
  idIndex: Map<string, Path>,
  op: Record<string, unknown>,
): { file: PrepFile; id: string; results?: Array<{ id: string; san: string }> } {
  const kind = String(op.op);
  // Small local helper — resolves a node_id (or parent_id) op field to
  // a path against the CURRENT tree state.
  const nodeIdField = (key: "node_id" | "parent_id"): string => {
    const raw = op[key];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`\`${key}\` required on op ${kind}`);
    }
    return raw.trim();
  };
  const resolve = (id: string): Path => resolveNodeId(idIndex, id);
  switch (kind) {
    case "add_move":
      return addMove(file, resolve(nodeIdField("parent_id")), String(op.san));
    case "add_line": {
      const sans = Array.isArray(op.sans) ? (op.sans as unknown[]).map(String) : [];
      const parentPath = resolve(nodeIdField("parent_id"));
      const step = addLine(file, parentPath, sans);
      const lastId = step.line.length > 0 ? step.line[step.line.length - 1].id : nodeIdField("parent_id");
      return { file: step.file, id: lastId, results: step.line };
    }
    case "set_comment":
      return setComment(file, resolve(nodeIdField("node_id")), typeof op.comment === "string" ? op.comment : "");
    case "set_nags":
      return setNags(file, resolve(nodeIdField("node_id")), Array.isArray(op.nags) ? (op.nags as unknown[]).map(String) : []);
    case "set_annotations": {
      const arrows = Array.isArray(op.arrows) ? (op.arrows as PrepArrow[]) : [];
      const highlights = Array.isArray(op.highlights) ? (op.highlights as PrepHighlight[]) : [];
      const ann: PrepAnnotations | null =
        arrows.length === 0 && highlights.length === 0 ? null : { arrows, highlights };
      return setAnnotations(file, resolve(nodeIdField("node_id")), ann);
    }
    case "set_ceo_eval": {
      const ev = op.ceoEval as StoredEval | null | undefined;
      return setCeoEval(file, resolve(nodeIdField("node_id")), ev ?? null);
    }
    case "delete_subtree":
      return deleteSubtree(file, resolve(nodeIdField("node_id")));
    case "promote_variation":
      return promoteVariation(file, resolve(nodeIdField("node_id")));
    case "set_tag":
      return { file: setTag(file, String(op.key), String(op.value ?? "")), id: ROOT_ID };
    default:
      throw new Error(`unknown mutation op: ${kind}`);
  }
}

// Batch: load, parse, apply N mutations in order, export, save.
// All-or-nothing — any error aborts and nothing is saved. The id index
// is rebuilt after each op so nodes created earlier in the batch can be
// addressed by later ops via their newly-derived node_id.
async function applyBatchMutations(args: Args): Promise<unknown> {
  const id = String(args.id);
  const mutations = Array.isArray(args.mutations) ? args.mutations : [];
  if (mutations.length === 0) throw new Error("mutations array required");

  const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(id)}`);
  const g = raw as { pgnContent?: string; version?: number };
  if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");

  let file = parsePGN(g.pgnContent);
  let idIndex = buildIdIndex(file.root);
  const results: Array<{ node_id: string; line?: unknown }> = [];
  for (let i = 0; i < mutations.length; i++) {
    const op = mutations[i] as Record<string, unknown>;
    try {
      const step = dispatchMutation(file, idIndex, op);
      file = step.file;
      idIndex = buildIdIndex(file.root);
      results.push({ node_id: step.id, ...(step.results !== undefined ? { line: step.results } : {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`mutation #${i} (${String(op.op)}) failed: ${msg}`);
    }
  }
  const newPgn = exportPGN(file);
  const expected = typeof args.expected_version === "number" ? args.expected_version : g.version;
  const saved = await authedRequest("PUT", `/api/agent/prep-files/${encodeURIComponent(id)}`, {
    pgn: newPgn,
    expected_version: expected,
  });
  const savedRow = saved as { version?: number };
  return { ok: true, results, version: savedRow.version };
}

// Auto-evaluate: walk the tree from `path`, run cloud_analyse on each node,
// stash the compact per-engine eval in the node's `ceoEval` field (which
// survives across sessions and appears on every read_prep_file), and
// derive the NAG from the SF score. Both writes go via a single batch
// mutation at the end so a 200-node evaluate is one save.
async function autoEvaluate(args: Args): Promise<unknown> {
  const id = String(args.id);
  const startNodeId = typeof args.node_id === "string" && args.node_id.length > 0
    ? String(args.node_id)
    : ROOT_ID;
  const onlyMissing = args.only_missing !== false; // default true
  const movetimeMs = typeof args.movetime_ms === "number" ? args.movetime_ms : 1500;

  const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(id)}`);
  const g = raw as { pgnContent?: string; version?: number };
  if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");
  const file = parsePGN(g.pgnContent);
  const idIndex = buildIdIndex(file.root);
  const startPath = resolveNodeId(idIndex, startNodeId);

  // Collect eligible nodes (skip root — no move to evaluate). `onlyMissing`
  // gates on stored `ceoEval` (the raw persisted numbers), not on visible
  // NAGs — this tool never sets NAGs, so gating on NAGs would incorrectly
  // re-evaluate hand-annotated moves whose eval hasn't been stored yet.
  type Target = { nodeId: string; fen: string };
  const targets: Target[] = [];
  const walk = (node: PrepNode, isStartAndRoot: boolean) => {
    if (!isStartAndRoot) {
      if (!onlyMissing || !node.ceoEval) {
        targets.push({ nodeId: node.id, fen: node.fen });
      }
    }
    for (const child of node.children) walk(child, false);
  };
  const startNode = getNodeByPath(file.root, startPath);
  // If the caller anchored at the root, skip evaluating the root itself
  // (no move); otherwise the anchor node IS a real move and gets evaluated.
  walk(startNode, startNode.id === ROOT_ID);
  if (targets.length === 0) return { ok: true, evaluated: 0, skipped: 0, version: g.version };

  // Dispatch cloud_analyse in parallel with a 4-way cap so we don't
  // over-saturate the engine-ws connection cap (single-client per port).
  const stored: { nodeId: string; ev: StoredEval }[] = [];
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const t = targets[idx];
      try {
        const analysis = await authedRequest(
          "POST",
          "/api/agent/cloud-engines/analyse",
          { fen: t.fen, movetime_ms: movetimeMs, multipv: 1 },
        );
        const ev = analysisToStoredEval(analysis, t.fen);
        if (ev) stored.push({ nodeId: t.nodeId, ev });
      } catch {
        // best-effort — a single failed node shouldn't kill the batch
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (stored.length === 0) return { ok: true, evaluated: 0, skipped: targets.length, version: g.version };

  // Persist the raw numbers only — never touch visible NAGs. NAG glyphs
  // are the LLM's editorial call (novelty, sharp choice, real mistake),
  // not an automatic mapping from the engine number. Stamping `$10` on
  // every 0.00 position in an opening tree just clutters the board.
  // The threshold-derived NAG still lives INSIDE `ceoEval.nag` so the
  // LLM can read it back and decide whether to promote it to a visible
  // NAG on a case-by-case basis.
  const batchMutations: Array<{ op: string; node_id: string; ceoEval?: StoredEval }> = [];
  for (const s of stored) {
    batchMutations.push({ op: "set_ceo_eval", node_id: s.nodeId, ceoEval: s.ev });
  }
  const saveResult = await applyBatchMutations({ id, mutations: batchMutations, expected_version: g.version } as Args);
  const sr = saveResult as { version?: number };
  return { ok: true, evaluated: stored.length, skipped: targets.length - stored.length, version: sr.version };
}

// Walk chess.js-free: resolve a path against a tree, throw if invalid.
function pathIntoTree(root: PrepNode, path: Path): PrepNode {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    if (path[i] < 0 || path[i] >= cur.children.length) {
      throw new Error(`path segment ${i}=${path[i]} out of bounds`);
    }
    cur = cur.children[path[i]];
  }
  return cur;
}

// Read the cloud analyse response and build a StoredEval (compact form —
// no PVs, White-POV cp / mate, depth, and derived NAG). Returns null if
// there's no usable Stockfish signal (SF is the source of truth for
// the NAG per docs).
function analysisToStoredEval(analysis: unknown, fen: string): StoredEval | null {
  if (!analysis || typeof analysis !== "object") return null;
  const r = analysis as {
    stockfish?: { depth?: number; lines?: Array<{ depth?: number; scoreCp?: number; mate?: number }> };
    lc0?:       { depth?: number; lines?: Array<{ depth?: number; scoreCp?: number; mate?: number }> };
  };
  const whiteToMove = / w /.test(fen);
  const flip = (n: number) => (whiteToMove ? n : -n);

  const engineEval = (block: typeof r.stockfish): StoredEngineEval | undefined => {
    const line = block?.lines?.[0];
    if (!line) return undefined;
    const depth = line.depth ?? block?.depth;
    if (typeof line.mate === "number") return { mate: flip(line.mate), depth };
    if (typeof line.scoreCp === "number") return { cp: flip(line.scoreCp), depth };
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

function nagFromCp(cp?: number, mate?: number): string | null {
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
function storedEvalToCompact(ev: StoredEval | null, analysis: unknown): CompactEval | null {
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

// Load-mutate-save: fetch current PGN, parse, apply mutation, re-export,
// save with optimistic lock. Auto-saves so every tool call is atomic;
// the LLM never sees intermediate state. The mutator is called with
// both the parsed file and its id → path index, so the mutation can
// resolve node_ids without rebuilding the index itself.
async function applyMutation(
  args: Args,
  mutator: (file: PrepFile, idIndex: Map<string, Path>) => { file: PrepFile; id: string; results?: unknown },
): Promise<unknown> {
  const id = String(args.id);
  const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(id)}`);
  const g = raw as { pgnContent?: string; version?: number };
  if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");

  const file = parsePGN(g.pgnContent);
  const idIndex = buildIdIndex(file.root);
  let result: { file: PrepFile; id: string; results?: unknown };
  try {
    result = mutator(file, idIndex);
  } catch (err) {
    if (err instanceof MutationError || err instanceof PathError || err instanceof NodeIdError) {
      throw new Error(`mutation rejected: ${err.message}`);
    }
    throw err;
  }
  const newPgn = exportPGN(result.file);

  const expected = typeof args.expected_version === "number" ? args.expected_version : g.version;
  const saved = await authedRequest("PUT", `/api/agent/prep-files/${encodeURIComponent(id)}`, {
    pgn: newPgn,
    expected_version: expected,
  });
  const savedRow = saved as { version?: number };
  return {
    ok: true,
    node_id: result.id,
    ...(result.results !== undefined ? { line: result.results } : {}),
    version: savedRow.version,
  };
}

// Strip cruft the LLM doesn't need from the DB-position response.
// Called AFTER trimGamesMovetext so plyNumber survives long enough to
// slice each game's movetext. Also renames the `transpositions` field
// to something the LLM can parse without knowing chess-DB jargon.
function stripPositionResponse(r: unknown): void {
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
function trimGamesMovetext(response: unknown): void {
  if (!response || typeof response !== "object") return;
  const r = response as { games?: Array<{ moves?: string; plyNumber?: number; totalPly?: number; ply?: number }> };
  if (!Array.isArray(r.games)) return;
  for (const g of r.games) {
    if (typeof g.moves === "string" && typeof g.plyNumber === "number" && g.plyNumber > 0) {
      g.moves = trimMovesToPly(g.moves, g.plyNumber);
    }
  }
}

function trimMovesToPly(moves: string, plyNumber: number): string {
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
function convertAvailableMovesToSAN(raw: unknown, fen: string): unknown {
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

// Resolve a starting FEN from any combination of `fen`, `line`, and
// `moves` the tool received. Three modes, all valid:
//
//   fen alone                → use as-is
//   line/moves alone         → walk from startpos
//   fen + moves (or line)    → walk from that fen
//
// `line` is the historical field name from the backend's prep endpoint;
// `moves` is the flexible-input name we now surface for LLM ergonomics
// ("start from this FEN and play these moves next"). They're synonyms
// here — same SAN sequence, same chess.js walker. `moves` wins if both
// happen to be provided.
function resolveFenFromArgs(args: Args): string {
  const fenArg = typeof args.fen === "string" ? args.fen.trim() : "";
  const movesArg = typeof args.moves === "string" ? args.moves.trim() : "";
  const lineArg = typeof args.line === "string" ? args.line.trim() : "";
  const sequence = movesArg || lineArg;

  const board = fenArg ? new Chess(fenArg) : new Chess();
  if (sequence) {
    for (const raw of sequence.split(/\s+/)) {
      const san = raw.replace(/^\d+\.+/, "");
      if (!san) continue;
      try {
        board.move(san);
      } catch {
        throw new Error(`bad SAN token '${raw}' in moves`);
      }
    }
  }
  return board.fen();
}

// Handle to a loaded prep-file when an engine/DB tool was called with
// file_id+node_id. Carries enough state to (a) know which FEN to query,
// and (b) write ceoEval back onto the node without another parse.
type FileHandle = {
  id: string;
  version: number;
  parsedFile: PrepFile;
  idIndex: Map<string, Path>;
  nodePath: Path;
  fen: string;
};

// Async resolver used by every engine / DB tool. If the caller supplied
// file_id + node_id (preferred), load the file, resolve the node, and
// return both the FEN and a handle we can use to persist ceoEval later.
// Otherwise fall back to the raw fen/moves/line inputs.
async function resolveFromNodeOrFen(args: Args): Promise<{ fen: string; file?: FileHandle }> {
  const fileId = typeof args.file_id === "string" ? args.file_id.trim() : "";
  const nodeId = typeof args.node_id === "string" ? args.node_id.trim() : "";
  if (fileId && nodeId) {
    const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(fileId)}`);
    const g = raw as { pgnContent?: string; version?: number };
    if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");
    const parsedFile = parsePGN(g.pgnContent);
    const idIndex = buildIdIndex(parsedFile.root);
    const nodePath = resolveNodeId(idIndex, nodeId);
    const node = getNodeByPath(parsedFile.root, nodePath);
    return {
      fen: node.fen,
      file: {
        id: fileId,
        version: g.version ?? 0,
        parsedFile,
        idIndex,
        nodePath,
        fen: node.fen,
      },
    };
  }
  return { fen: resolveFenFromArgs(args) };
}

// Local wrapper — the mutation module re-exports paths.getNode so this
// import stays consistent with the rest of the file's imports.
function getNodeByPath(root: PrepNode, path: Path): PrepNode {
  let cur = root;
  for (const idx of path) {
    if (idx < 0 || idx >= cur.children.length) throw new Error(`invalid node path segment ${idx}`);
    cur = cur.children[idx];
  }
  return cur;
}

// Persist a fresh ceoEval on the node referenced by the file handle.
// Best-effort — if the file version raced (another agent saved
// between our GET and our PUT), we silently drop the store rather
// than fail the analysis the LLM actually asked for. The eval is
// still returned in the response either way.
async function storeEvalOnNode(handle: FileHandle, ev: StoredEval): Promise<void> {
  try {
    const step = setCeoEval(handle.parsedFile, handle.nodePath, ev);
    const newPgn = exportPGN(step.file);
    await authedRequest("PUT", `/api/agent/prep-files/${encodeURIComponent(handle.id)}`, {
      pgn: newPgn,
      expected_version: handle.version,
    });
  } catch {
    // Best-effort — the analysis result is what the LLM asked for.
  }
}

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

async function callTool(name: string, args: Args): Promise<unknown> {
  const started = Date.now();
  console.error(`[mcp] IN  ${name} args=${stringifyForLog(args)}`);
  try {
    const result = await callToolInner(name, args);
    const dur = Date.now() - started;
    console.error(`[mcp] OUT ${name} ok ${dur}ms result=${stringifyForLog(result)}`);
    return result;
  } catch (err) {
    const dur = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] OUT ${name} err ${dur}ms error=${JSON.stringify(msg)}`);
    throw err;
  }
}

async function callToolInner(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "search_player":
      return get("/api/chess/players/search/simple", { q: String(args.name), view: "llm" });

    case "get_player_profile":
      return get("/api/chess/players/profile", { fideId: Number(args.fide_id) });

    case "get_player_preparation": {
      // Node-first: if file_id+node_id was given, derive the FEN from the
      // tree (never trust an LLM-supplied FEN when a node reference is
      // available). Otherwise fall back to fen/moves/line.
      const resolved = await resolveFromNodeOrFen(args);
      const effectiveFen = resolved.fen;
      const params: Record<string, string | number | undefined> = {
        fideId: Number(args.fide_id),
        color: String(args.color),
        compact: "true",
        fen: effectiveFen,
      };
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const [raw, ev] = await Promise.all([
        get("/api/chess/prep/by-player", params),
        fetchCompactEval(effectiveFen),
      ]);
      const converted = convertAvailableMovesToSAN(raw, effectiveFen);
      if (converted && typeof converted === "object") {
        trimGamesMovetext(converted);
        stripPositionResponse(converted);
        if (ev) (converted as { eval?: CompactEval }).eval = ev;
      }
      return converted;
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
      return converted;
    }

    case "describe_position": {
      const resolved = await resolveFromNodeOrFen(args);
      return describePosition(resolved.fen);
    }

    case "predict_human_move": {
      const resolved = await resolveFromNodeOrFen(args);
      const fen = resolved.fen;
      const qs = new URLSearchParams();
      qs.set("fen", fen);
      if (typeof args.white_elo === "number") qs.set("white_elo", String(args.white_elo));
      if (typeof args.black_elo === "number") qs.set("black_elo", String(args.black_elo));
      if (typeof args.top === "number") qs.set("top", String(args.top));
      if (Array.isArray(args.prev_fens)) {
        for (const p of args.prev_fens as unknown[]) {
          if (typeof p === "string" && p.length > 0) qs.append("prev_fen", p);
        }
      }
      return authedRequest("GET", `/api/agent/predict-move?${qs.toString()}`);
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
      if (typeof args.multipv === "number") body.multipv = args.multipv;
      if (typeof args.contempt === "number") body.contempt = args.contempt;
      const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse", body);
      const converted = convertCloudSnapshotResponse(raw, fen);
      // Node-addressed calls: persist the result on the node's ceoEval
      // so a later quote_engine_eval can cite this measurement. This is
      // the anti-hallucination hinge — prose that says "engines say X
      // on node Y" can only trace back to a call actually made against
      // node_id=Y, because the store only fires when file_id+node_id
      // was supplied and the eval survives via the [%ceo-eval] escape.
      if (resolved.file) {
        const ev = analysisToStoredEval(converted, fen);
        if (ev) await storeEvalOnNode(resolved.file, ev);
      }
      return converted;
    }

    case "list_prep_files":
      return authedRequest("GET", "/api/agent/prep-files");

    case "search_prep_files":
      return authedRequest("GET", `/api/agent/prep-files/search?q=${encodeURIComponent(String(args.query))}`);

    case "read_prep_file": {
      const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(String(args.id))}`);
      const g = raw as { pgnContent?: string; version?: number; id?: string };
      if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");
      const file = parsePGN(g.pgnContent);
      return {
        id: g.id,
        version: g.version,
        tags: file.tags,
        tree: file.root,
      };
    }

    case "create_prep_file":
      return authedRequest("POST", "/api/agent/prep-files", {
        name: String(args.name),
      });

    case "delete_prep_file":
      return authedRequest("DELETE", `/api/agent/prep-files/${encodeURIComponent(String(args.id))}`);

    case "add_move":
      return applyMutation(args, (file, idIndex) =>
        addMove(file, resolveNodeId(idIndex, argNodeId(args, "parent_id")), String(args.san)),
      );

    case "add_line":
      return applyMutation(args, (file, idIndex) => {
        const sans = Array.isArray(args.sans) ? (args.sans as unknown[]).map(String) : [];
        const parentPath = resolveNodeId(idIndex, argNodeId(args, "parent_id"));
        const step = addLine(file, parentPath, sans);
        const lastId = step.line.length > 0 ? step.line[step.line.length - 1].id : argNodeId(args, "parent_id");
        return { file: step.file, id: lastId, results: step.line };
      });

    case "set_comment":
      return applyMutation(args, (file, idIndex) =>
        setComment(file, resolveNodeId(idIndex, argNodeId(args)), typeof args.comment === "string" ? args.comment : ""),
      );

    case "set_nags":
      return applyMutation(args, (file, idIndex) =>
        setNags(file, resolveNodeId(idIndex, argNodeId(args)), Array.isArray(args.nags) ? (args.nags as unknown[]).map(String) : []),
      );

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
      return autoEvaluate(args);

    case "quote_engine_eval": {
      const fileId = String(args.id);
      const nodeId = argNodeId(args);
      const raw = await authedRequest("GET", `/api/agent/prep-files/${encodeURIComponent(fileId)}`);
      const g = raw as { pgnContent?: string };
      if (typeof g.pgnContent !== "string") throw new Error("prep file missing pgnContent");
      const file = parsePGN(g.pgnContent);
      const idIndex = buildIdIndex(file.root);
      const path = resolveNodeId(idIndex, nodeId);
      const node = getNodeByPath(file.root, path);
      return { ceoEval: node.ceoEval ?? null };
    }

    case "read_engine_usage_guide":
      return { guide: ENGINE_USAGE_DOC };

    case "read_prep_strategy_guide":
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

// ── Prompt templates ───────────────────────────────────────────────
//
// MCP prompts are pre-baked instructions the host surfaces in a slash-menu
// (Claude Desktop, Cursor, etc.). Users pick one and the templated content
// gets injected into the conversation. Perfect for workflows the LLM
// wouldn't reliably discover from tool descriptions alone — chess prep
// especially, where "call the right tools in the right order weighted by
// recency and format" is non-obvious.

const PROMPTS: Prompt[] = [
  {
    name: "prepare_for_game",
    description:
      "Prep workflow for an upcoming chess game. Walks both players' repertoires and identifies where the opponent is weakest.",
    arguments: [
      { name: "me", description: "Your name (or FIDE ID)", required: true },
      { name: "opponent", description: "Opponent's name (or FIDE ID)", required: true },
      { name: "my_color", description: "The color you'll be playing: 'white' or 'black'. Optional — if you don't know yet, ask.", required: false },
      { name: "time_control", description: "Optional: 'classical', 'rapid', 'blitz'. Weights which of the opponent's games matter most.", required: false },
    ],
  },
  {
    name: "scout_player",
    description:
      "Deep scouting report on one player. Their style, top openings, recent form, and where they've been beaten.",
    arguments: [
      { name: "player", description: "Player name or FIDE ID", required: true },
    ],
  },
  {
    name: "head_to_head_briefing",
    description:
      "Briefing on the history between two players — who has the edge, what openings decide their meetings, style clash.",
    arguments: [
      { name: "player_a", description: "First player (name or FIDE ID)", required: true },
      { name: "player_b", description: "Second player (name or FIDE ID)", required: true },
    ],
  },
  {
    name: "engine_usage_primer",
    description:
      "Full guide on how to use the chess.ceo cloud engines — Stockfish vs Lc0 tradeoffs, when to trust which, how to read disagreements, and how to use Lc0 contempt to find practical ideas. Read before running expensive cloud_analyse calls or when the user asks WHY the engines gave certain scores.",
    arguments: [],
  },
  {
    name: "prep_strategy_primer",
    description:
      "Full guide on how to reason about opening preparation — why win% is one weight not a rule, why prep is a two-player game with symmetric information, when 'revealed weaknesses' are actionable, how to use move-order tricks, and how to calibrate surprise. Read before recommending an opening plan, especially when the user is preparing for a specific real opponent.",
    arguments: [],
  },
];

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

4. **Walk the opponent's repertoire against ${me}'s color.** Call \`get_player_preparation\` on the opponent for the color they'll have in this game. Iterate: start from move 1, pick the opponent's most-played reply, call again with \`line\` extended. Look for:
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
4. \`get_player_preparation\` for both colors from the starting position to summarise their opening choices with actual frequencies and win rates.
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
