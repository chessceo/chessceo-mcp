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

## Development

```bash
git clone <this repo>
cd chessceo-mcp
npm install
npm run build   # tsc → dist/
npm start       # runs the server on stdio (for MCP hosts)
```

Environment variable overrides:

- `CHESSCEO_BASE_URL` — override the API base (default `https://chess.ceo`). Useful for testing against staging.

## What's under the hood

The chess.ceo public API is a GET-only surface documented at [`chess.ceo/llms.txt`](https://chess.ceo/llms.txt). This MCP server is a thin wrapper — one tool per endpoint, with input schemas so LLMs can call them safely. When you ask the model a chess question, it picks the right tool, calls it, and reasons over the JSON. Nothing is invented; the data is straight from the database.

## License

MIT
