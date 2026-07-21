#!/usr/bin/env node
// chess.ceo MCP server. Exposes the public GET API as MCP tools so LLM
// hosts (Claude Desktop, Cursor, etc.) can look up players, positions,
// preparation stats, and live broadcast state directly.
//
// Everything here is a thin wrapper around https://chess.ceo/api/chess/*
// endpoints — see the public contract at https://chess.ceo/llms.txt.
// No API key, no auth, no state; the API's own rate limits apply.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
      "For a given player, colour and starting position, return both the moves the player actually chose (frequency + win rate) and the underlying games. Position is specified either as a move sequence in SAN (`line`) or a raw FEN. Use `line` iteratively to walk the opening tree: call once with empty `line`, pick a move, call again with `line` extended by that move, etc.",
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server wiring ──────────────────────────────────────────────────

const server = new Server(
  { name: "chessceo-mcp", version: process.env.npm_package_version ?? "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
