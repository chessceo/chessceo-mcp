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
  method: "GET" | "POST" | "DELETE",
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
      "Reading the response — CRITICAL:\n" +
      "• Win % is one weight, not a verdict. Recommend 1.b3 over 1.d4 because 60% > 50% is wrong. Sample size matters (3 games at 66% is noise; 300 at 55% is signal); avgWhite / avgBlack per move show the rating context (a big score often means a rating gap, not repertoire truth).\n" +
      "• Prep is symmetric information — both sides see the same history. Assume the opponent knows the weakness you spotted; a weak opponent won't patch it, a strong or improving one already has (but structural weaknesses like 'bad in Catalan structures' hold anyway).\n" +
      "• Recency > career. The last 12-24 months dominate. This endpoint's compact/LLM view deliberately omits per-move `hotness` — at the individual level it's trailing noise. The general DB endpoint keeps it (there it's fashion signal).\n" +
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
        line: {
          type: "string",
          description:
            "Move sequence in SAN, space-separated, no move numbers required. Example: 'e4 e5 Nf3'. Leave empty for the starting position.",
        },
        fen: {
          type: "string",
          description: "Alternative to `line` — raw FEN of the target position.",
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
      "Move statistics from all 11.7M+ indexed games at a given position — game counts, win percentages, top continuations. Answers 'from position P, how often does White play 4. O-O vs 4. d3, and which scores better'.",
    inputSchema: {
      type: "object",
      properties: {
        fen: {
          type: "string",
          description: "FEN of the position to look up.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Number of top continuations to return.",
        },
      },
      required: ["fen"],
    },
  },
  {
    name: "analyse",
    description:
      "Short Stockfish evaluation at a position. Returns the top-N candidate moves with score (centipawns from side-to-move POV, positive = advantage; or mate distance) and the principal variation for each. Defaults: 2s think time, top-3 lines. PV moves come back in SAN (e4, Nf3, Bxc4 — not UCI). Free (no cloud instance needed) — use liberally.\n\n" +
      "GROUNDING: cite this tool's actual output when you claim things about positions. Don't invent evaluations from general principles or training data — if you don't have engine output for a FEN, call this. Compute is cheap.\n\n" +
      "Use this to sanity-check candidate lines from get_position_stats or get_player_preparation — human game frequency tells you what people play, engine evaluation tells you what's actually good.",
    inputSchema: {
      type: "object",
      properties: {
        fen: { type: "string", description: "FEN of the position to analyse." },
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
          description: "Number of candidate lines to return (default 3).",
        },
      },
      required: ["fen"],
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
      "Contempt (`contempt`) skews Lc0 (only Lc0 — Stockfish always stays objective) toward White (positive) or Black (negative). Practical range -20..+20. Use it to find non-objective 'practical' ideas or when the user needs to steer toward fighting/solid lines with a specific colour. Do NOT quote a contempt-biased eval as objective — cross-check with Stockfish.\n\n" +
      "For the full guide including worked examples, call the `read_engine_usage_guide` tool.\n\n" +
      "Not for casual questions — this costs real money per second. Use the free `analyse` tool (single Stockfish, 2s) or `get_position_stats` for anything that doesn't require deep prep.",
    inputSchema: {
      type: "object",
      properties: {
        fen: { type: "string", description: "FEN of the position to analyse." },
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
            "Lc0 contempt bias. 0 = objective (default). Positive favours White, negative favours Black; stay within -20..+20 in practice. Not applied to Stockfish. See engine_usage_primer prompt for when to use.",
        },
      },
      required: ["fen"],
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
    name: "prep_snapshot",
    description:
      "One call, three parallel fetches at the same position: opponent's stats on their side, your stats on your side, and the 11.7M-game general database at that position. Use this while walking the opening tree — one round trip instead of three separate calls, and you can compare the three views directly (e.g. opponent has 2 games here but the general DB has 8k → prep candidate).",
    inputSchema: {
      type: "object",
      properties: {
        fide_id_me: { type: "integer", description: "Your FIDE ID." },
        fide_id_opponent: { type: "integer", description: "Opponent's FIDE ID." },
        my_color: { type: "string", enum: ["white", "black"], description: "The colour YOU will play." },
        line: {
          type: "string",
          description:
            "Move sequence in SAN, space-separated. Empty = starting position. Example: 'e4 c5 Nf3'. Either line or fen (or neither for the starting position).",
        },
        fen: {
          type: "string",
          description: "Alternative to line — raw FEN of the target position.",
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

// Rewrite the local /chess/database/analyse response (single engine)
// so PVs come back in SAN.
function convertAnalyseResponse(raw: unknown, startFen: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { lines?: Array<{ pv?: string[] }> };
  if (Array.isArray(r.lines)) {
    for (const line of r.lines) {
      if (Array.isArray(line.pv)) line.pv = uciLineToSAN(startFen, line.pv);
    }
  }
  return raw;
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

// Resolve a starting FEN from either the `fen` or `line` argument the tool
// received. Same logic prep_snapshot already had inline — extracted so we
// can reuse it wherever we need to walk a SAN line to a concrete FEN
// (e.g. for UCI→SAN conversion of availableMoves).
function resolveFenFromArgs(args: Args): string {
  const fenArg = typeof args.fen === "string" ? args.fen.trim() : "";
  if (fenArg) return fenArg;
  const lineArg = typeof args.line === "string" ? args.line.trim() : "";
  const board = new Chess();
  if (lineArg) {
    for (const raw of lineArg.split(/\s+/)) {
      const san = raw.replace(/^\d+\.+/, "");
      if (!san) continue;
      try {
        board.move(san);
      } catch {
        throw new Error(`bad SAN token '${raw}' in line`);
      }
    }
  }
  return board.fen();
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
      const params: Record<string, string | number | undefined> = {
        fideId: Number(args.fide_id),
        color: String(args.color),
        compact: "true",
      };
      if (typeof args.line === "string" && args.line.length > 0) params.line = args.line;
      if (typeof args.fen === "string" && args.fen.length > 0) params.fen = args.fen;
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const raw = await get("/api/chess/prep/by-player", params);
      return convertAvailableMovesToSAN(raw, resolveFenFromArgs(args));
    }

    case "get_position_stats": {
      const fen = String(args.fen);
      const raw = await get("/api/chess/database/main", {
        fen,
        limit: typeof args.limit === "number" ? args.limit : 20,
        sort: "relevance",
      });
      return convertAvailableMovesToSAN(raw, fen);
    }

    case "analyse": {
      const fen = String(args.fen);
      const params: Record<string, string | number | undefined> = { fen };
      if (typeof args.movetime_ms === "number") params.movetime_ms = args.movetime_ms;
      if (typeof args.multipv === "number") params.multipv = args.multipv;
      const raw = await get("/api/chess/database/analyse", params);
      return convertAnalyseResponse(raw, fen);
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
      const fen = String(args.fen);
      const body: Record<string, unknown> = { fen };
      if (typeof args.movetime_ms === "number") body.movetime_ms = args.movetime_ms;
      if (typeof args.multipv === "number") body.multipv = args.multipv;
      if (typeof args.contempt === "number") body.contempt = args.contempt;
      const raw = await authedRequest("POST", "/api/agent/cloud-engines/analyse", body);
      return convertCloudSnapshotResponse(raw, fen);
    }

    case "read_engine_usage_guide":
      return { guide: ENGINE_USAGE_DOC };

    case "read_prep_strategy_guide":
      return { guide: PREP_STRATEGY_DOC };

    case "prep_snapshot": {
      const me = Number(args.fide_id_me);
      const opp = Number(args.fide_id_opponent);
      const myColor = String(args.my_color);
      const oppColor = myColor === "white" ? "black" : "white";
      const line = typeof args.line === "string" ? args.line.trim() : "";
      let fen = typeof args.fen === "string" ? args.fen.trim() : "";

      // General DB lookup needs a FEN. If we only have a line, compute it
      // locally with chess.js — one dep, keeps the three data-fetches truly
      // parallel instead of doing a preliminary round-trip.
      if (!fen) {
        const board = new Chess();
        if (line.length > 0) {
          for (const raw of line.split(/\s+/)) {
            // Tolerant of move-number tokens like "1." / "12..." that some
            // clients include; chess.js rejects those outright.
            const san = raw.replace(/^\d+\.+/, "");
            if (!san) continue;
            try {
              board.move(san);
            } catch {
              throw new Error(`bad SAN token '${raw}' in line`);
            }
          }
        }
        fen = board.fen();
      }

      const prepParams = (fideId: number, color: string) => ({
        fideId,
        color,
        compact: "true",
        ...(line.length > 0 ? { line } : { fen }),
      });

      const [opponent, you, general] = await Promise.all([
        get("/api/chess/prep/by-player", prepParams(opp, oppColor)),
        get("/api/chess/prep/by-player", prepParams(me, myColor)),
        get("/api/chess/database/main", { fen, limit: 20, sort: "relevance" }),
      ]);

      return {
        position: { line, fen, my_color: myColor },
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
