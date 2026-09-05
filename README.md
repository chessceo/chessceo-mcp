# @chessceo/mcp

Model Context Protocol server for [chess.ceo](https://chess.ceo) — 11.7M+ games, ~1.5M FIDE player profiles, opening preparation, live broadcasts, cloud engine analysis, and (signed-in) a full read/write prep-file workflow. Lets Claude, Cursor, and any other MCP host answer chess questions directly against real data instead of hallucinating.

Player/game lookups need no API key or auth. Cloud engines and prep-file tools need a `mcp_...` bearer token (see Auth below).

## What it can do

49 tools as of v0.49.0, mirroring the `chess.ceo` API surface. A few of the most-used:

| Tool | What it answers |
|---|---|
| `search_player` | "Find FIDE ID for Magnus Carlsen" |
| `get_player_profile` | "How strong is X, what do they play, who have they beaten" |
| `prepare_opponent` + `get_prep_position` | "What does X play against 1.e4? What's their win rate with the Najdorf?" |
| `get_position_stats` | "From this position, which move scores best in the 11.7M-game database?" |
| `get_head_to_head` | "What's the record between X and Y?" |
| `list_live_tournaments` / `list_tournament_players` / `list_player_live_tournaments` | "What's being broadcast live right now? Who's playing? Is X in it?" |
| `cloud_analyse` | "Run Stockfish + Lc0 on this position on my rented GPU instance" |
| `read_prep_file` / `add_line` / `add_move` / `apply_mutations` | Read and edit your own repertoire/course PGNs stored server-side |
| `auto_evaluate` / `deep_analyse` | Kick off a long-running engine-evaluation job over a whole prep file, poll it, cancel it |
| `read_docs` | Bundled guides (engine usage, opening prep, prep-file conventions, PGN authoring, summary authoring) |

Full tool inventory with categories lives in [`CLAUDE.md`](CLAUDE.md) under "Tools cheatsheet" — that's the maintained source of truth; this table is illustrative, not exhaustive.

## Install (Claude Desktop)

Add to your `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "chessceo": {
      "command": "npx",
      "args": ["-y", "@chessceo/mcp"]
    }
  }
}
```

Restart Claude Desktop. You should see the chess.ceo tools appear in the tool list at the bottom of the chat.

## Install (Cursor)

Similar `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "chessceo": {
      "command": "npx",
      "args": ["-y", "@chessceo/mcp"]
    }
  }
}
```

## Install (Claude Code)

This repo is also a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces), so you can add it directly:

```
/plugin marketplace add chessceo/chessceo-mcp
/plugin install chessceo@chessceo
```

Claude Code will pull the plugin from GitHub and wire the MCP server automatically. Enable "Sync automatically" in the marketplace UI if you want future updates fetched on push.

## Auth (for cloud engines and prep files)

Read-only chess data — player search, profiles, position stats, head-to-head, live tournaments — needs nothing. Cloud engine tools and your own prep-file tools (list/read/create/edit) need a `mcp_...` bearer token.

- **Local (`npx`/Claude Desktop/Cursor):** set `CHESSCEO_TOKEN` in the server's `env` block:
  ```json
  {
    "mcpServers": {
      "chessceo": {
        "command": "npx",
        "args": ["-y", "@chessceo/mcp"],
        "env": { "CHESSCEO_TOKEN": "mcp_..." }
      }
    }
  }
  ```
  Get a token from your chess.ceo account settings.
- **Remote (`mcp.chess.ceo/mcp`):** no config needed — calling an authed tool without a token triggers the host's normal OAuth flow (claude.ai, ChatGPT connectors) automatically.

## Try it

Ask your model:

- *"Who has the better record against Magnus Carlsen: Ding Liren or Fabiano Caruana?"*
- *"What does Alireza Firouzja play with White against the Najdorf?"*
- *"Are there any live tournaments right now with Hikaru Nakamura?"*
- *"From the position after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6, what's the top continuation across the whole database?"*

## Prep workflow (built-in prompts)

For MCP hosts that show prompts in a slash-menu (Claude Desktop, Cursor, Claude Code), three pre-baked prompts are included so users get a proper preparation workflow without prompt-engineering their own:

| Prompt | Purpose |
|---|---|
| `prepare_for_game(me, opponent, my_color?, time_control?)` | Full pre-match workflow: resolves both players, weights games by recency + format (classical OTB > rapid/blitz > online), walks the opponent's repertoire looking for lines where they score under 40%, checks head-to-head, and delivers a concrete plan with the moves to steer toward the opponent's weak points. |
| `scout_player(player)` | Deep scouting report on one player — style, top openings, recent form, biggest wins and losses, recurring weaknesses. |
| `head_to_head_briefing(player_a, player_b)` | One-paragraph read on the history between two players — who has the edge, dominant openings, style clash, current form. |

Pick one from the host's slash-menu, fill in the arguments, and the model does the rest.

## Remote MCP (chess.ceo-hosted)

You can also connect to chess.ceo's hosted instance and skip installing anything:

```
https://mcp.chess.ceo/mcp
```

In Claude Code:

```
/plugin add-mcp url https://mcp.chess.ceo/mcp
```

In Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chessceo": {
      "url": "https://mcp.chess.ceo/mcp"
    }
  }
}
```

Same tools, same data, zero-install. Bearer-authed tools (cloud engines, prep files) go through this host's OAuth flow instead of a config-file token. Useful when the host can't spawn subprocesses (e.g. Claude.ai web, Claude mobile, ChatGPT connectors).

## Self-host the HTTP transport

The same package can run as a persistent HTTP server, not just a stdio subprocess:

```bash
chessceo-mcp --transport=http --http-port=8080 --http-host=127.0.0.1
```

Flags (or the corresponding env vars):

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `--transport` | `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `--http-port` | `MCP_HTTP_PORT` | `8080` | Port to bind |
| `--http-host` | `MCP_HTTP_HOST` | `127.0.0.1` | Bind address |
| `--http-path` | `MCP_HTTP_PATH` | `/mcp` | Streamable-HTTP endpoint |

`GET /healthz` returns `200 ok\n` — wire it into your uptime monitor.

### systemd unit (example)

```ini
# /etc/systemd/system/chessceo-mcp.service
[Unit]
Description=chess.ceo MCP server (Streamable HTTP)
After=network.target

[Service]
Type=simple
User=www-data
Environment=NODE_ENV=production
Environment=MCP_TRANSPORT=http
Environment=MCP_HTTP_PORT=8127
Environment=MCP_HTTP_HOST=127.0.0.1
ExecStart=/usr/bin/npx -y @chessceo/mcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### nginx snippet (example)

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.chess.ceo;

    ssl_certificate     /etc/letsencrypt/live/mcp.chess.ceo/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.chess.ceo/privkey.pem;

    # Streamable HTTP is short JSON POSTs — no long-poll SSE required.
    location /mcp {
        proxy_pass         http://127.0.0.1:8127/mcp;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_buffering    off;   # streaming responses shouldn't be buffered
        proxy_read_timeout 300s;
    }

    location = /healthz { proxy_pass http://127.0.0.1:8127/healthz; }
}
```

## Development

```bash
git clone <this repo>
cd chessceo-mcp
npm install
npm run build   # tsc → dist/
npm start       # runs the server on stdio (for MCP hosts)

# or run the HTTP transport locally:
node dist/index.js --transport=http --http-port=8127
curl http://127.0.0.1:8127/healthz     # should print "ok"
```

Environment variable overrides:

- `CHESSCEO_BASE_URL` — override the API base (default `https://chess.ceo`). Useful for testing against staging.
- MCP transport env vars — see the self-host table above.

## What's under the hood

The chess.ceo public API is a GET-only surface documented at [`chess.ceo/llms.txt`](https://chess.ceo/llms.txt). This MCP server is a thin wrapper — one tool per endpoint, with input schemas so LLMs can call them safely. When you ask the model a chess question, it picks the right tool, calls it, and reasons over the JSON. Nothing is invented; the data is straight from the database.

## License

MIT
