#!/usr/bin/env node
// chess.ceo MCP server. Exposes the public GET API as MCP tools so LLM
// hosts (Claude Desktop, Cursor, etc.) can look up players, positions,
// preparation stats, and live broadcast state directly.
//
// Everything here is a thin wrapper around https://chess.ceo/api/chess/*
// endpoints — see the public contract at https://chess.ceo/llms.txt.
// No API key, no auth, no state; the API's own rate limits apply.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
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

// ── HTTP ────────────────────────────────────────────────────────────

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
      "For a given player, colour and starting position, return both the moves the player actually chose (frequency + win rate) and the underlying games. Position is specified either as a move sequence in SAN (`line`) or a raw FEN. Use `line` iteratively to walk the opening tree: call once with empty `line`, pick a move, call again with `line` extended by that move, etc. When preparing for a real game, weight recent games (last 12-24 months) more heavily than old ones, classical over-the-board > rapid/blitz > online, and look for variations the player scores poorly in (below ~40%) or plays with less variety (shallower prep).",
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
      "Short Stockfish evaluation at a position. Returns the top-N candidate moves with score (centipawns from side-to-move POV, positive = advantage; or mate distance) and the principal variation for each. Defaults: 2s think time, top-3 lines. PV moves come back in UCI notation (e2e4, not e4). Use this to sanity-check candidate lines from get_position_stats or get_player_preparation — human game frequency tells you what people play, engine evaluation tells you what's actually good.",
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

async function callTool(name: string, args: Args): Promise<unknown> {
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
      return get("/api/chess/prep/by-player", params);
    }

    case "get_position_stats":
      return get("/api/chess/database/main", {
        fen: String(args.fen),
        limit: typeof args.limit === "number" ? args.limit : 20,
        sort: "relevance",
      });

    case "analyse": {
      const params: Record<string, string | number | undefined> = { fen: String(args.fen) };
      if (typeof args.movetime_ms === "number") params.movetime_ms = args.movetime_ms;
      if (typeof args.multipv === "number") params.multipv = args.multipv;
      return get("/api/chess/database/analyse", params);
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
        opponent,
        you,
        general,
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

    // Everything else must hit the MCP path.
    const urlPath = (req.url ?? "").split("?")[0];
    if (urlPath !== path) {
      res.statusCode = 404;
      res.end();
      return;
    }

    try {
      // Stateless: one transport per request, no session store. Simpler,
      // scales trivially, matches how claude.ai / ChatGPT connectors call.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
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
