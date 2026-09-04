# Chess.ceo MCP server

Model Context Protocol server that exposes chess.ceo to LLM hosts (Claude Desktop, claude.ai, ChatGPT). Every tool here is a thin wrapper on a chess.ceo backend endpoint; this package's job is **LLM ergonomics**, not business logic.

Repo layout (tool defs split out of index.ts in v0.44 — it's no longer a
single monolithic file):

```
src/index.ts             Handlers + transport (stdio + streamable-HTTP) + auth. callToolInner's
                         switch is the source of truth for what each tool actually does.
src/tools.ts             All tool schemas (TOOLS[] — pure data, name/description/inputSchema).
src/prompts.ts           The three prep-workflow prompts (PROMPTS[]).
src/pgn/                 PGN parse/export/describe, node-id ↔ path resolution (paths.ts),
                         and the mutation primitives (mutations.ts: addLine, addMove,
                         deleteSubtree, promoteVariation, setAnnotations/Comment/Nags/Tag,
                         setCeoEval[Many]).
src/prep/                Prep-file library (list/search/read), and mutation orchestration
                         separate from raw pgn/mutations.ts primitives.
src/analysis/            auto_evaluate / deep_analyse job lifecycle (auto.ts, deep.ts),
                         file_handle.ts, response shaping.
src/courses.ts           find_position_in_courses / read_course_at_position — read-only
                         reference courses, distinct from the user's own prep files.
src/http.ts              Streamable-HTTP transport plumbing.
src/response_transforms.ts  UCI→SAN and other LLM-facing reshaping (see "Where this fits").
src/warnings.ts          Grounding/guardrail text injected into tool responses.
docs/*.md                Bundled at build time, served via read_*_guide tools + matching
                         prompts: engine-usage.md, prep-strategy.md, prep-files-guide.md,
                         pgn-authoring.md, summary-authoring.md.
docs/examples/*.pgn      Worked PGN examples (italian-fried-liver, najdorf-6-f4-white),
                         bundled the same way, referenced from pgn-authoring.md.
tools/fenfind/           Python side-tool (polyglot Zobrist index) that find_position_in_courses
                         shells out to. tools/sf_eval/ — local Stockfish eval helper.
package.json             files: ["dist","docs","README.md","tools"]. docs/ and tools/ must
                         ship or the doc tools and find_position_in_courses degrade/fallback.
Dockerfile               For Glama listing's automated safety checks (not for prod).
.claude-plugin/          Claude Code marketplace manifest, unrelated to the npm package.
CLAUDE.md                This file.
```

## Experimental — tear down, don't build up

**No backwards compatibility.** This whole surface is experimental and I am the only real caller (via my own Claude/Codex MCP hosts). When something needs to change:

- **Rename the thing.** Don't keep the old name as an alias. Delete it.
- **Change the shape.** Don't add a new field alongside the old one with precedence rules. Kill the old field.
- **Cut features.** Don't leave dead code paths marked "kept for compatibility". If nothing calls it after the change, delete it.
- **No compat shims in commits.** Don't write `// legacy shape, kept for callers still passing X`. There are no such callers — I control both ends.
- **Bump the minor version freely.** v0.31 → v0.32 → v0.33 is cheap. Semver-wise every commit is potentially breaking; that's fine.

The one exception is **data at rest** — a prep file on disk with `[%ceo-eval …]` escape tags shouldn't stop parsing because I renamed a field. Migrations for stored data are OK; API compat shims are not.

Concrete anti-patterns I've fallen into and shouldn't repeat:
- Adding `stockfish_multipv` alongside a shared `multipv` with precedence rules — should have just replaced.
- Keeping `read_prep_strategy_guide` alive as an alias when renaming to `read_opening_prep_guide` — should have just renamed hard.
- "kept for signature stability" comments on parameters no other caller passes — just change the signature.

If a rewrite churns the LLM's muscle memory for a session, that's a fair cost — the LLM re-reads the tool list on every session start anyway.

## Where this fits

Three surfaces call chess.ceo:

- **Web/mobile frontend** → `/api/users/*` + `/api/chess/*` + `/api/vastai/*` (cookie/JWT session)
- **This MCP** → `/api/chess/*` (anonymous read) + `/api/agent/*` (bearer `mcp_...`)
- **curl/scripts** → same as either of the above

The backend endpoints are **shared** — the frontend and the MCP hit `/api/chess/database/main`, `/api/chess/prep/by-player`, `/api/chess/database/analyse` etc. equally. Anything that's LLM-specific (UCI→SAN, doc bundling, tool descriptions, response reshaping, grounding warnings) belongs in this MCP wrapper, NOT in the backend. Backend stays generic.

Concrete examples of things that live here (and MUST NOT drift into the backend):

- **UCI→SAN conversion** on engine PV output. Done in `convertCloudSnapshotResponse` (`src/analysis/response.ts`) via chess.js. Wire format stays UCI everywhere; only the LLM path sees SAN.
- **Bundled docs** (`docs/engine-usage.md`, `docs/prep-strategy.md`). Loaded at process start and served as tool output. Editing these is how you change the LLM's mindset; no backend involvement.
- **Compact-view stripping.** Some backend endpoints (`/chess/prep/by-player?compact=true`) already have LLM-oriented behavior on the server side — that's the exception, done there because the frontend needs the *full* view unstripped. Anything else stays here.
- **The grounding language** in tool descriptions ("don't invent, run the engine") — pure LLM steering; backend is silent.

## Auth model

Two paths, one credential.

- **Stdio mode** (Claude Desktop, local `npx -y @chessceo/mcp`): the host sets `CHESSCEO_TOKEN=mcp_...` in the MCP config. `resolveAuthHeader()` reads it and prepends `Bearer `.
- **Streamable-HTTP mode** (`mcp.chess.ceo/mcp`, used by claude.ai + ChatGPT): the host does the OAuth 2.1 flow against chess.ceo's AS (`/.well-known/oauth-authorization-server`), gets a `mcp_...` access token, sends it as `Authorization: Bearer ...` on every JSON-RPC POST. We forward it through to the backend via **AsyncLocalStorage** — the MCP SDK's tool handler doesn't know about HTTP so we stash the header per-request and read it inside `authedRequest`. Do not remove the `authContext.run(...)` wrap — tool handlers will lose the header.

For unauthed calls to authed tools, the streamable-HTTP transport returns **401 + `WWW-Authenticate: Bearer resource_metadata=...`** *before* handing off to the MCP SDK. That header is what triggers claude.ai / ChatGPT's automatic OAuth flow. Preserve it — without it, the client just silently 404s the tool.

## The MCP is the safety layer

Tool descriptions push the LLM to cite tool output and not hallucinate. The five bundled docs
(`docs/*.md`) are the authoritative long-form. The two original docs (`engine-usage.md`,
`prep-strategy.md`) are exposed **two ways** because different clients handle prompts differently:

1. As **prompts** (`engine_usage_primer`, `prep_strategy_primer`) — some clients surface these as slash commands the user picks manually. Injects the full doc into the conversation.
2. As a **tool** (`read_docs`, batched — see Tools cheatsheet) — LLM can call this itself when the description of another tool tells it to. Necessary because many clients (including some Claude surfaces) do NOT expose prompts to the model at all.

Never remove the tool-based path. If a client won't show prompts, tool-based is the only reliable delivery.
The three newer docs (`prep-files`, `pgn-authoring`, `summary-authoring`) currently only have the
tool-based path — see the gap noted under "Docs" in the Tools cheatsheet.

## Tools cheatsheet

47 tools as of v0.48.2. Full source in `src/tools.ts` (schemas) + `src/index.ts`
`callToolInner` switch (behavior). Categories:

**Player data (anonymous)**
- `search_player`, `get_player_profile`, `get_head_to_head`
- `get_position_stats` — 11.7M-game DB
- `describe_position`

**Prediction (bearer-authed)**
- `predict_human_move`

**Live tournaments (anonymous)**
- `list_live_tournaments`, `list_tournament_players`, `list_player_live_tournaments`

**Opponent prep sessions (bearer-authed)** — game-history based, not the user's own files
- `prepare_opponent` — build a filtered session (FIDE/Chess.com/Lichess sources); returns a `token`
- `get_prep_position`, `list_prep_sessions`, `delete_prep_session`
- `prep_snapshot` — one call, three parallel prep views at one FEN (anonymous)

**Cloud engines (bearer-authed)**
- `list_cloud_machine_options` — MUST call before start_cloud_engine, SKUs like `rtx-5090-64` are not guessable from display names
- `start_cloud_engine`, `list_cloud_engines`, `stop_cloud_engine`
- `cloud_analyse` — combo (SF + Lc0) on the user's rented instance; supports `contempt`; PVs converted to SAN

**Prep files (bearer-authed)** — the user's own repertoire/course PGNs, stored server-side
- Browse/read: `list_collections`, `list_prep_files`, `search_prep_files`, `find_position_in_files`, `read_prep_file`, `list_nodes`, `list_transpositions`
- Lifecycle: `create_prep_file`, `delete_prep_file`, `restore_prep_file`
- Mutate: `add_move`, `add_line`, `set_comment`, `set_nags`, `set_annotations`, `set_tag`, `delete_subtree`, `promote_variation`, `apply_mutations` (batch)

**Engine evaluation jobs (bearer-authed)** — long-running, poll-and-cancel shape
- `auto_evaluate` / `auto_evaluate_status` / `auto_evaluate_cancel`
- `deep_analyse` / `deep_analyse_status` / `deep_analyse_cancel`
- `quote_engine_eval`

**Reference courses (bearer-authed)** — read-only, distinct from the user's own prep files
- `find_position_in_courses` (shells out to `tools/fenfind`), `read_course_at_position`

**Docs (anonymous)**
- `read_docs` — single batched tool, `docs: ["engine-usage", "pgn-authoring", ...]`. Replaced the old
  per-doc `read_engine_usage_guide`/`read_prep_strategy_guide` tools (v0.44ish, hard rename per the
  no-compat-shims rule above). `DOC_LIBRARY` in `src/index.ts` is the name → doc map: `engine-usage`,
  `opening-prep`, `prep-files`, `pgn-authoring`, `summary-authoring`, plus two bundled example PGNs.
- Prompts: only `engine_usage_primer` and `prep_strategy_primer` exist (`src/prompts.ts`) — the three
  newer docs (`prep-files`, `pgn-authoring`, `summary-authoring`) have no prompt equivalent, only
  `read_docs`. That's a gap against the "two access paths" rule below, not a deliberate design.

`AUTHED_TOOLS` in `src/index.ts` is the set that requires a bearer token — the streamable-HTTP transport gates on this to trigger OAuth via 401 + `WWW-Authenticate`. Keep this Set in sync when adding new authed tools.

## Deploy

**Use `bash ~/dev/chessceo-mcp/deploy-mcp.sh`.** It's the canonical path (added
v0.29ish) and already does everything the old manual recipe below used to
require by hand: publish (tolerant of "already published"), `npm cache clean
--force`, nuke the npx cache dir, wait 20s for CDN propagation, `sudo
systemctl restart`, then verify both the running version (reads
`package.json` out of the freshly-populated npx cache dir) and the live tool
count via `tools/list` against `https://mcp.chess.ceo/mcp`. Idempotent — safe
to re-run if a step fails partway.

```bash
# 1. Bump version in package.json (semver: minor for new tools, patch for tweaks).
# 2. Commit + push.
git add package.json src/*.ts src/**/*.ts docs/*.md && git commit -m "..." && git push

# 3. Deploy (prompts for sudo once, for the systemctl restart).
bash ~/dev/chessceo-mcp/deploy-mcp.sh
```

Then reconnect the connector in claude.ai (Settings → Connectors → chessceo → disconnect / reconnect) so it re-fetches the tool list from `mcp.chess.ceo/mcp`. Without a reconnect, the client keeps caching the previous list and the LLM doesn't see new tools. `deploy-mcp.sh` cannot do this step — it's a per-user client action.

### The npx cache trap (defense in depth beyond deploy-mcp.sh)

`chessceo-mcp.service` starts via `/home/lucas/.nvm/versions/node/v22.21.1/bin/npx -y @chessceo/mcp`. npx caches installed packages under `~/.npm/_npx/<sha>/node_modules/` keyed by a hash of the install request. A **bare** `sudo systemctl restart chessceo-mcp.service` (not through `deploy-mcp.sh`) re-runs the same command, and **npx reuses the cached copy without re-checking the registry, so a freshly-published version is NOT picked up.** Verified symptom (2026-07-22): published a version, restarted, but `tools/list` still returned the old set.

`deploy-mcp.sh` nukes `~/.npm/_npx` itself before every restart, so this trap is closed for the normal deploy flow. It's still live for anyone (including future-Claude) who restarts the unit directly without going through the script — e.g. after an unrelated `.env` edit. Fixed 2026-09-05 with `ExecStartPre=/bin/rm -rf /home/lucas/.npm/_npx` added to the live unit (see Runtime below) so *any* restart self-heals, not just deploys.

There's also a rarer trap where `npm publish` succeeds but npm's local packument cache lies about "no matching version" on the next `npx` (~30s window post-publish). `deploy-mcp.sh`'s cache-clean + 20s wait covers this in the normal case. If a restart still hits it, the service crash-loops with `npm error notarget No matching version found`. Fix: `npm cache clean --force` (may complain "ENOTEMPTY" — safe to ignore, cache was still cleared) then wait and let systemd's retry loop pick it up.

## Runtime

- **Systemd unit:** `/etc/systemd/system/chessceo-mcp.service` (User=lucas). Runs streamable-HTTP on `127.0.0.1:8127`. Has `ExecStartPre=/bin/rm -rf /home/lucas/.npm/_npx` (added 2026-09-05) so any restart — not just `deploy-mcp.sh` — picks up the latest published version.
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

1. Add the definition to `TOOLS` in `src/tools.ts` (schemas live here now, not `index.ts`). Description is written for the LLM — include the grounding "don't invent" reminder if the tool returns data the LLM might paraphrase.
2. Add a case to `callToolInner` in `src/index.ts` (**not** `callTool` — that's the logging wrapper). Return `authedRequest(...)` for authed tools, `get(...)` for anonymous.
3. If it's authed, add its name to `AUTHED_TOOLS` (also in `src/index.ts`). The streamable-HTTP 401 gate reads this set.
4. If the response needs LLM-side reshaping (UCI→SAN, hiding noisy fields, denormalizing something), do it in the case handler after the fetch — NOT in the backend. `src/response_transforms.ts` is where existing reshaping logic lives.
5. Bump `package.json` version (minor if it's a new tool, patch for a fix).
6. Deploy per the recipe above.

## Adding a new bundled doc

1. `docs/foo.md` — write the doc.
2. `loadBundledDoc("foo.md", "Foo guide")` in `src/index.ts`, then add it to `DOC_LIBRARY` under whatever
   short name callers should pass to `read_docs` (e.g. `"foo"`).
3. That alone makes it reachable via `read_docs({ docs: ["foo"] })` — there's no more per-doc tool to add.
   Current policy (since `read_docs` unified the old `read_engine_usage_guide`/`read_prep_strategy_guide`
   split) is tool-only for new docs; only add a prompt in `PROMPTS` if you specifically want it in a
   host's slash-menu too (most new docs skip this — see the prompt/tool-path gap noted under "Docs" in
   the Tools cheatsheet, which is real but not something to blindly replicate).
4. Cross-reference from the relevant tool descriptions ("call `read_docs` with `foo` before …") so the LLM knows the doc exists.

## Distribution

- **npm:** `@chessceo/mcp`. Public. Publish requires a granular access token with "All packages" scope and "Bypass 2FA when publishing" enabled — the default token flow with email 2FA rejects `npm publish` even after browser confirmation.
- **GitHub:** `github.com/chessceo/chessceo-mcp`. MIT-licensed. Public. Repo-local git config uses `admin@chess.ceo`, not the personal email.
- **Glama listing:** `glama.ai/mcp/servers/chessceo/chessceo-mcp` (id `t84xzdu39e`). Managed via web UI — the `~/.glama` API key is gateway-scoped, not admin-scoped, so DCR/Dockerfile updates need the browser.
- **Claude Code marketplace:** `.claude-plugin/marketplace.json` at repo root points at `plugins/chessceo/`. Independent surface from the npm package; users install via `/plugin marketplace add`.
