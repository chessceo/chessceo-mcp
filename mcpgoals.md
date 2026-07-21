# chess.ceo MCP — goals

Living design doc for where the MCP server + surrounding infra needs to go.
Written 2026-07-22 by Lucas and Claude. Update as we build.

## The vision (one sentence)

A user opens Claude, says *"prep me against Magnus, build me a full file"*,
walks away for two hours, comes back to a complete, annotated PGN
repertoire file — with variations, evaluations, side notes on what to play
and where — saved to their chess.ceo account and openable in the app.

## Where we are today (v0.3.1)

Read-only, single-turn tools:

- Player search / profile / preparation walk (`search_player`, `get_player_profile`, `get_player_preparation`)
- Position stats over 11.7M-game DB (`get_position_stats`)
- Head-to-head (`get_head_to_head`)
- Live tournaments (`list_live_tournaments` etc.)
- Composed one-call snapshot (`prep_snapshot` — opponent + you + general DB in one round-trip)
- Stockfish analysis (`analyse` via `/chess/database/analyse` — 1 CPU, 2s, MultiPV 3)
- Prompt templates (`prepare_for_game`, `scout_player`, `head_to_head_briefing`)

The LLM can reason over any position, but it can't *write anything back*.
Everything it produces is chat-ephemeral. That's the gap.

## What's missing

### 1. A place to write

The LLM needs a persistent object it can create, edit, and hand back to
the user. In chess terms that's a **prep file** — really a tree of
positions with moves, comments, and evaluations hanging off each node.

Requirements:

- **Server-side storage** (not local filesystem) so the remote MCP
  (`mcp.chess.ceo/mcp`) works. Local-only breaks users on web/mobile hosts.
- **Per-user scope** — the LLM operates on behalf of a specific chess.ceo
  account. Needs auth: OAuth flow, or a scoped "MCP token" the user
  generates in their chess.ceo settings and pastes into their MCP host
  config.
- **Openable in the app** — the prep file format must be exactly what
  `pgn_collections` / `encrypted_pgn_collections` already store, so the
  user can open the finished file on the web / iOS / Android without
  conversion. Reuse the existing model, don't invent a parallel one.

### 2. A PGN representation the LLM can actually work with

Standard PGN's parenthesised variations (`1.e4 e5 (1...c5 2.Nf3) 2.Nf3`)
are readable by LLMs but nested variations get miscounted. LLMs are much
better at structured JSON.

Ship **two views** for every read tool:

- **`pgn`** — canonical text form, for round-trip and user-facing output.
- **`tree`** — JSON: `{ move, san, fen, comment?, nag?, eval?, children: [...] }`.

The LLM reasons over `tree`. It only touches `pgn` when handing the final
file back. Write tools accept structured input, not raw PGN text — no
paren-counting bugs.

### 3. Mutation tools

Non-negotiable minimum, all against a specific `file_id` the LLM owns:

- `list_my_prep_files` — inventory (name, opening, size, last edited)
- `read_prep_file(file_id, view: "pgn" | "tree")` — retrieve
- `create_prep_file(name, root_fen?, opening?)` — new empty file
- `add_moves(file_id, at_fen, moves: san[])` — extend a line. Idempotent:
  if the moves already exist at that position, no-op.
- `add_variation(file_id, at_fen, moves: san[])` — same as above but
  explicitly a new branch at a node with existing moves.
- `annotate(file_id, at_fen, comment?, nag?, eval?)` — attach notes to
  a specific node.
- `delete_line(file_id, at_fen)` — prune a subtree.
- `export_pgn(file_id)` — final PGN text for the user to download / import.

Optional but valuable:

- `search_my_prep(query)` — full-text search over the user's own comments
  and move lists. Lets the LLM notice "you already have a file on the
  Najdorf against Firouzja" and extend it instead of starting fresh.
- `import_pgn(pgn_text, name)` — upload an existing PGN so the LLM can
  work on it.
- `snapshot(file_id) / restore(file_id, snapshot_id)` — undo. Long
  autonomous runs will occasionally take a wrong turn.

### 4. Long-running autonomy

Two hours of Claude working with tools is a real load on the model host.
Constraints to design around:

- **Context window**. A repertoire with 200 nodes × 20 tool calls per node
  is well past any single-context reasonable window. The LLM needs to
  work in **phases** — build phase, review phase, finalise phase — with
  intermediate summaries checkpointed to the file itself (comments on
  key nodes) so context can be dropped between phases without losing
  work.
- **Cost**. Rough shape: at ~2M tokens/hour for continuous tool-heavy
  work with Sonnet, a full 2-hour build is ~4-5M tokens ≈ $15-25. Fine
  as a Premium feature, not fine as free-tier.
- **Failure recovery**. If the API blips mid-run, the file already has
  what's been written so far. The LLM should be able to resume from
  "what have I done" (read the file, note progress, continue).
- **Termination**. The LLM should know when the file is "done enough" —
  probably per-line depth targets ("cover the main line 15 moves deep,
  every sideline the opponent plays >5% of the time to move 10").

The MCP server itself doesn't need to know about long-running behaviour —
that's a host-side concern (Claude Code's `/loop`, or a scheduled agent).
The MCP just needs to expose tools that are safe to call thousands of
times in a session.

### 5. Discovery — how do users find their file

- **In the app**: the prep file the LLM built shows up in the user's
  normal `pgn_collections` list. No new UI needed.
- **Response from the LLM**: at the end, "your prep is saved as
  *'Prep vs Magnus, 2026-07-22'* — open it at
  `chess.ceo/collections/<id>`".

## What needs building — ranked by dependency

Each numbered item unlocks the next. Skip nothing without a plan.

1. **Auth for MCP → user account.** Design decision: OAuth (complex, good
   UX) vs "generate an MCP token in settings" (simple, ugly). Probably
   start with the token — one field in the user settings page,
   `Authorization: Bearer <token>` header on MCP tool calls that need it.
   Backend: new `mcp_tokens` table, generation endpoint, middleware to
   resolve token → user_id.
2. **Backend endpoints for prep-file CRUD** — mostly wraps the existing
   `pgn_collections` / `pgn_games` model, plus the JSON `tree` view for
   agent consumers. `GET /api/agent/prep-files`,
   `POST /api/agent/prep-files`, `PATCH /api/agent/prep-files/{id}/moves`, etc.
3. **PGN tree serializer/deserializer** in the backend that emits both
   `pgn` and `tree` views from the same internal representation. Reuse
   the parser that already exists for `pgn_games` — extend to output tree.
4. **MCP write tools** — thin wrappers around the new backend endpoints.
   Structured input, no PGN text on the write path.
5. **Prompt templates for autonomous runs** — `build_repertoire_vs_opponent`,
   `extend_repertoire`, `stress_test_prep`. These are the composed
   workflows that turn the tools into a program.

Steps 1-4 are one PR each, roughly a day of work per PR. Step 5 is a
week of iteration once the tools work.

## Non-goals (for the first pass)

- **Multi-user shared prep files** — one user, one file. Team prep can
  come later.
- **Real-time collaboration** — no live-cursor / OT / CRDT. Files are
  edited by exactly one agent at a time.
- **Engine on every node** — engine analysis is opt-in per node. The
  full-repertoire flow calls it selectively at branch points, not on
  every leaf. Cost / latency reasons.
- **Novelty ranking against theory** — the *idea* is great, but requires
  a novelty index we don't have yet. Later.
- **Voice / video** — text tools only.

## Open questions

- **PGN write conflicts.** If the user has the app open and the LLM edits
  the same file, what happens? Optimistic locking on `updated_at`, LLM
  gets a 409 and re-reads.
- **How chatty should the `tree` view be?** Full FEN on every node is
  huge. Move-only is compact but the LLM has to walk from root every
  time. Probably compact by default, expand on request.
- **Encrypted collections** (`encrypted_pgn_collections`): the LLM can't
  see the plaintext. Either the MCP tools skip encrypted files, or the
  user opts in per-file to "let the AI see this file" and the client
  provides the key. Punt for now.
- **Rate limits per user for autonomous runs.** How many
  `add_moves` / minute is reasonable? Related: the engine endpoint's
  concurrency semaphore (4 concurrent) will bottleneck a full-file
  build. Might need to raise, or accept the runtime cost.

## References

- Existing PGN model — `internal/chess/models/`
- Encrypted PGN model — `internal/auth/services/pgn_encrypted.go` and
  friends
- Current MCP tool surface — `src/index.ts`
- Public GET contract — `chess.ceo/llms.txt`
- Growth moonshot list (this is bet #1 leveled up) —
  `~/.claude/projects/-home-lucas-dev-api/memory/growth-moonshot-bets.md`
