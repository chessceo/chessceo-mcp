# @chessceo/mcp

Model Context Protocol server for [chess.ceo](https://chess.ceo) — 11.7M+ games, ~1.5M FIDE player profiles, opening preparation, live broadcasts. Lets Claude, Cursor, and any other MCP host answer chess questions directly against real data instead of hallucinating.

No API key. No auth. No state. Free to use.

## What it can do

The server exposes 8 tools that mirror the public GET API surface at `chess.ceo`:

| Tool | What it answers |
|---|---|
| `search_player` | "Find FIDE ID for Magnus Carlsen" |
| `get_player_profile` | "How strong is X, what do they play, who have they beaten" |
| `get_player_preparation` | "What does X play against 1.e4? What's their win rate with the Najdorf?" |
| `get_position_stats` | "From this position, which move scores best in the 11.7M-game database?" |
| `get_head_to_head` | "What's the record between X and Y?" |
| `list_live_tournaments` | "What's being broadcast live right now?" |
| `list_tournament_players` | "Who's playing in tournament T?" |
| `list_player_live_tournaments` | "Is X playing anywhere right now?" |

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

Same 8 tools, same data, zero-install. Useful when the host can't spawn subprocesses (e.g. Claude.ai web, Claude mobile, ChatGPT connectors).

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
