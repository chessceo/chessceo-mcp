# Chess.ceo MCP server

Model Context Protocol server that exposes chess.ceo to LLM hosts (Claude Desktop, claude.ai, ChatGPT). Every tool here is a thin wrapper on a chess.ceo backend endpoint; this package's job is **LLM ergonomics**, not business logic.

Repo layout:

```
src/index.ts             All tool defs + handlers + transport in one file (~1000 loc). Kept
                         monolithic on purpose — every tool is ~10 lines and one file is
                         easier to grep than fifteen tiny ones.
docs/engine-usage.md     Bundled at build time; served via read_engine_usage_guide + prompt.
docs/prep-strategy.md    Same pattern.
package.json             files: ["dist","docs","README.md"]. docs/ must ship or the two
                         read_*_guide tools return the fallback string.
Dockerfile               For Glama listing's automated safety checks (not for prod).
.claude-plugin/          Claude Code marketplace manifest, unrelated to the npm package.
CLAUDE.md                This file.
```

## Where this fits

Three surfaces call chess.ceo:

- **Web/mobile frontend** → `/api/users/*` + `/api/chess/*` + `/api/vastai/*` (cookie/JWT session)
- **This MCP** → `/api/chess/*` (anonymous read) + `/api/agent/*` (bearer `mcp_...`)
- **curl/scripts** → same as either of the above

The backend endpoints are **shared** — the frontend and the MCP hit `/api/chess/database/main`, `/api/chess/prep/by-player`, `/api/chess/database/analyse` etc. equally. Anything that's LLM-specific (UCI→SAN, doc bundling, tool descriptions, response reshaping, grounding warnings) belongs in this MCP wrapper, NOT in the backend. Backend stays generic.

Concrete examples of things that live here (and MUST NOT drift into the backend):

- **UCI→SAN conversion** on engine PV output. Done in `convertAnalyseResponse` / `convertCloudSnapshotResponse` via chess.js. Wire format stays UCI everywhere; only the LLM path sees SAN.
- **Bundled docs** (`docs/engine-usage.md`, `docs/prep-strategy.md`). Loaded at process start and served as tool output. Editing these is how you change the LLM's mindset; no backend involvement.
- **Compact-view stripping.** Some backend endpoints (`/chess/prep/by-player?compact=true`) already have LLM-oriented behavior on the server side — that's the exception, done there because the frontend needs the *full* view unstripped. Anything else stays here.
- **The grounding language** in tool descriptions ("don't invent, run the engine") — pure LLM steering; backend is silent.

## Auth model

Two paths, one credential.

- **Stdio mode** (Claude Desktop, local `npx -y @chessceo/mcp`): the host sets `CHESSCEO_TOKEN=mcp_...` in the MCP config. `resolveAuthHeader()` reads it and prepends `Bearer `.
- **Streamable-HTTP mode** (`mcp.chess.ceo/mcp`, used by claude.ai + ChatGPT): the host does the OAuth 2.1 flow against chess.ceo's AS (`/.well-known/oauth-authorization-server`), gets a `mcp_...` access token, sends it as `Authorization: Bearer ...` on every JSON-RPC POST. We forward it through to the backend via **AsyncLocalStorage** — the MCP SDK's tool handler doesn't know about HTTP so we stash the header per-request and read it inside `authedRequest`. Do not remove the `authContext.run(...)` wrap — tool handlers will lose the header.

For unauthed calls to authed tools, the streamable-HTTP transport returns **401 + `WWW-Authenticate: Bearer resource_metadata=...`** *before* handing off to the MCP SDK. That header is what triggers claude.ai / ChatGPT's automatic OAuth flow. Preserve it — without it, the client just silently 404s the tool.

## The MCP is the safety layer

Tool descriptions push the LLM to cite tool output and not hallucinate. The two doc primers (`engine-usage.md`, `prep-strategy.md`) are the authoritative long-form. Both docs get exposed **two ways** because different clients handle prompts differently:

1. As **prompts** (`engine_usage_primer`, `prep_strategy_primer`) — some clients surface these as slash commands the user picks manually. Injects the full doc into the conversation.
2. As **tools** (`read_engine_usage_guide`, `read_prep_strategy_guide`) — LLM can call these itself when the description of another tool tells it to. Necessary because many clients (including some Claude surfaces) do NOT expose prompts to the model at all.

Never remove the tool-based path. If a client won't show prompts, tool-based is the only reliable delivery.

## Tools cheatsheet

Full source in `src/index.ts` (search `const TOOLS`). Categories:

**Read-only chess data (anonymous)**
- `search_player`, `get_player_profile`, `get_head_to_head`
- `get_player_preparation` — the tree-walking prep endpoint; description embeds the compact prep-strategy guardrails
- `get_position_stats` — 11.7M-game DB
- `prep_snapshot` — one call, three parallel prep views at one FEN
- `list_live_tournaments`, `list_tournament_players`, `list_player_live_tournaments`

**Engines**
- `analyse` — free local Stockfish, ~2s, no cloud instance needed
- `cloud_analyse` — combo (SF + Lc0) on the user's rented instance; supports `contempt`; PVs converted to SAN

**Cloud engine management (bearer-authed)**
- `list_cloud_machine_options` — MUST call before start_cloud_engine, SKUs like `rtx-5090-64` are not guessable from display names
- `start_cloud_engine`, `list_cloud_engines`, `stop_cloud_engine`

**Docs (bearer NOT required)**
- `read_engine_usage_guide`, `read_prep_strategy_guide`

`AUTHED_TOOLS` in `src/index.ts` is the set that requires a bearer token — the streamable-HTTP transport gates on this to trigger OAuth via 401 + `WWW-Authenticate`. Keep this Set in sync when adding new authed tools.

## Deploy

Every deploy is: npm publish → **nuke npx cache** → systemd restart → verify tool count → have user reconnect the connector in their Claude UI.

```bash
# 1. Bump version in package.json (semver: minor for new tools, patch for tweaks).
# 2. Commit + push.
git add package.json src/index.ts docs/*.md && git commit -m "..." && git push

# 3. Publish. Uses the granular npm token with "All packages" + 2FA-bypass.
npm publish --access public

# 4. IMPORTANT: nuke the npx cache before restart. See "The npx cache trap" below.
rm -rf /home/lucas/.npm/_npx/f31e33b3b243e856

# 5. Restart the systemd unit that runs mcp.chess.ceo.
sudo systemctl restart chessceo-mcp.service

# 6. Verify. Tool count = current TOOLS[] length.
curl -sX POST 'https://mcp.chess.ceo/mcp' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["result"]["tools"]))'
```

Then reconnect the connector in claude.ai (Settings → Connectors → chessceo → disconnect / reconnect) so it re-fetches the tool list from `mcp.chess.ceo/mcp`. Without a reconnect, the client keeps caching the previous list and the LLM doesn't see new tools.

### The npx cache trap

`chessceo-mcp.service` starts via `/home/lucas/.nvm/versions/node/v22.21.1/bin/npx -y @chessceo/mcp`. npx caches installed packages under `~/.npm/_npx/<sha>/node_modules/` keyed by a hash of the install request. A `systemctl restart` re-runs the same command; **npx reuses the cached copy without re-checking the registry, so a freshly-published version is NOT picked up.** Verified symptom (2026-07-22): published a version, restarted, but `tools/list` still returned the old set.

**Every deploy MUST nuke the cache dir before restart.** The dir hash is stable (`f31e33b3b243e856` for the current install path); if it ever changes, `ls -la ~/.npm/_npx/ | sort -k 6,7` finds the freshest one.

A patched systemd unit that auto-nukes lives at `/tmp/chessceo-mcp.service` on the box:
```
ExecStartPre=/bin/rm -rf /home/lucas/.npm/_npx
ExecStart=... npx -y @chessceo/mcp@latest
```
Install with `sudo cp /tmp/chessceo-mcp.service /etc/systemd/system/ && sudo systemctl daemon-reload` and this whole class of bug goes away.

There's also a rarer trap where `npm publish` succeeds but npm's local packument cache lies about "no matching version" on the next `npx` (~30s window post-publish). If a restart hits it, the service crash-loops with `npm error notarget No matching version found`. Fix: `npm cache clean --force` (may complain "ENOTEMPTY" — safe to ignore, cache was still cleared) then wait and let systemd's retry loop pick it up.

## Runtime

- **Systemd unit:** `/etc/systemd/system/chessceo-mcp.service` (User=lucas). Runs streamable-HTTP on `127.0.0.1:8127`.
- **Nginx:** `/etc/nginx/sites-available/mcp.chess.ceo` proxies `/mcp` and `/healthz` **and** `/.well-known/oauth-protected-resource` to the backend port. If OAuth discovery ever 404s, check the well-known location block is still there — the `location / { return 404; }` catch-all will eat it otherwise.
- **Logs:** `journalctl -u chessceo-mcp.service -f`. Every tool call is logged in and out (v0.12.0+):
  ```
  [mcp] IN  cloud_analyse args={"fen":"...","movetime_ms":2000}
  [mcp] OUT cloud_analyse ok 2143ms result={"fen":"...","stockfish":{...}}
  [mcp] OUT list_cloud_engines err 402ms error="chess.ceo 401: ..."
  ```
  Result payload capped at 4KB — the two doc-reading tools would otherwise flood the log stream.

## Development

Type-check without emitting:
```bash
cd ~/dev/chessceo-mcp && npx tsc --noEmit
```

Test stdio locally without publishing:
```bash
# from a checkout with npm run build already run
CHESSCEO_TOKEN=mcp_... node dist/index.js
# then in another terminal, hit stdin with a JSON-RPC frame
```

Faster: point Claude Desktop's MCP config at your local checkout so every rebuild is picked up on restart. In `~/.config/claude/mcp.json` (or platform equivalent):
```json
{
  "mcpServers": {
    "chessceo-dev": {
      "command": "node",
      "args": ["/home/lucas/dev/chessceo-mcp/dist/index.js"],
      "env": { "CHESSCEO_TOKEN": "mcp_..." }
    }
  }
}
```

## Adding a new tool

1. Add the definition to `TOOLS` in `src/index.ts`. Description is written for the LLM — include the grounding "don't invent" reminder if the tool returns data the LLM might paraphrase.
2. Add a case to `callToolInner` (**not** `callTool` — that's the logging wrapper). Return `authedRequest(...)` for authed tools, `get(...)` for anonymous.
3. If it's authed, add its name to `AUTHED_TOOLS`. The streamable-HTTP 401 gate reads this set.
4. If the response needs LLM-side reshaping (UCI→SAN, hiding noisy fields, denormalizing something), do it in the case handler after the fetch — NOT in the backend.
5. Bump `package.json` version (minor if it's a new tool, patch for a fix).
6. Deploy per the recipe above.

## Adding a new bundled doc

1. `docs/foo.md` — write the doc.
2. `loadBundledDoc("foo.md", "Foo guide")` in `src/index.ts`.
3. Add BOTH a prompt (in `PROMPTS`) AND a tool (in `TOOLS` with `read_foo_guide` naming). Both handlers return the doc verbatim — same content, two access paths, matches how we do engine-usage and prep-strategy.
4. Cross-reference from the relevant tool descriptions ("call `read_foo_guide` before …") so the LLM knows the doc exists.

## Distribution

- **npm:** `@chessceo/mcp`. Public. Publish requires a granular access token with "All packages" scope and "Bypass 2FA when publishing" enabled — the default token flow with email 2FA rejects `npm publish` even after browser confirmation.
- **GitHub:** `github.com/chessceo/chessceo-mcp`. MIT-licensed. Public. Repo-local git config uses `admin@chess.ceo`, not the personal email.
- **Glama listing:** `glama.ai/mcp/servers/chessceo/chessceo-mcp` (id `t84xzdu39e`). Managed via web UI — the `~/.glama` API key is gateway-scoped, not admin-scoped, so DCR/Dockerfile updates need the browser.
- **Claude Code marketplace:** `.claude-plugin/marketplace.json` at repo root points at `plugins/chessceo/`. Independent surface from the npm package; users install via `/plugin marketplace add`.
