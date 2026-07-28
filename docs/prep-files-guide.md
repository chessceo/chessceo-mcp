# Prep files guide

You can save chess prep to the user's chess.ceo account and read it back across sessions. This is the persistence layer that turns your analysis from ephemeral chat into a durable, viewable-in-app repertoire.

## The mental model

The user has **any number of PGN collections** in their chess.ceo library — you have full access to every non-encrypted one. A **prep file** is one PGN game with variations, inside a collection. Every prep file id is a composite `<collection_id>:<game_id>` — opaque to you, pass it through unchanged to any tool that takes `id` or `file_id`.

Discovery tools:

- `list_collections` — show me all the user's collections (their organizational scheme is theirs; browse before creating)
- `list_prep_files(collection_id)` — the games inside one collection
- `search_prep_files(query)` — text search across ALL of the user's collections
- `find_position_in_files(fen)` — position search across ALL of the user's collections (matched by zobrist hash so move-order variants are found automatically). Distinct from `find_position_in_courses` — that's the user's read-only reference library (Chessable etc.); this is their own editable prep

Per-file tools:

- `read_prep_file(id)` — parsed tree (every node carries a stable content-derived `id`) + tags + `version`
- `create_prep_file(collection_id, name)` — new empty file inside the given collection, `name` becomes the [Event] tag
- `delete_prep_file(id)` — soft delete (user can restore from app)

**No default landing folder.** v0.43 removed the old hidden `/mcp` collection — prep files now live wherever the user organizes them. Every `create_prep_file` call REQUIRES `collection_id`; call `list_collections` first if you don't have one. Permanent delete is not exposed on this surface — the user does that from the app.

Mutation tools (edit an existing file — you never touch raw PGN):

- `apply_mutations(id, [...])` — batch: N ops in one save. **Primary build tool.**
- `add_move`, `add_line`, `set_comment`, `set_nags`, `set_annotations`, `delete_subtree`, `promote_variation`, `set_tag` — individual ops for surgical follow-ups. See `read_pgn_authoring_guide` for the full mutation vocabulary.

Every mutation call takes a `node_id` (or `parent_id` for add-style ops) and auto-saves. Nodes are addressed by stable content-derived id, not by path — sibling insertions / deletions / promotions never shift ids. Root id is `"r"`.

## The single most important habit

**Before creating a new file, search for an existing one.** LLMs make three "Prep vs Firouzja" files in a row all the time. Always:

1. **Text search first**: `search_prep_files(query=<opponent name or opening keyword>)` — searches across every collection the user owns.
2. **Position search when the request is position-shaped** ("prep me against 6.f3 in the Najdorf"): `find_position_in_files(fen=<the specific tabiya>)` — catches files that reach the position via a different move order too. This is often more accurate than text search because file names don't always mention every position they cover.
3. Read the ones that look relevant.
4. Decide: extend an existing one or genuinely start fresh (`create_prep_file(collection_id, name)`).

Duplicate files are the #1 way to lose your user's trust in this system. Two searches (text + position) cost roughly nothing and catch nearly all overlap.

## Before writing any prose: read the examples

**Call `read_example_prep_files` early in the session, before your first `set_comment` or comment-carrying `apply_mutations` batch.** Not once per project — once per LLM session. It returns two reference PGNs by a strong human coach and is the single biggest quality lift documented in this MCP; log analysis shows <5% of sessions call it and the ones that don't produce the exact anti-patterns the authoring guide warns against. Reading the two files takes one tool call and inoculates against most commentary failure modes.

## PGN authoring — separate concern

Everything about **how to write good PGN** (structure, NAGs, arrows, coloured squares, variation discipline, common pitfalls) lives in `pgn-authoring.md` — call `read_pgn_authoring_guide` for the full doc. That guide is universal to any chess file you might write; this guide is about the prep-files *feature* on top.

Minimum you should know before calling `save_prep_file`:

- Mainline = your top recommendation. Alternative candidates go in parenthesised variations at the branching move.
- **Variations are MOVES**, not prose describing moves. `7...Be6 (7...h5 8.Nd5)` — never `{if Black plays h5 White responds with Nd5}`.
- **Plans, prep-signal, and interpretation** go in `{curly-brace comments}`. Cite tool output; don't invent chess prose.
- `Event` tag is the file's user-facing name.

Full details, NAG table, arrow/highlight syntax, and worked example: `read_pgn_authoring_guide`.

## Editing without breaking the tree

You never send raw PGN. `read_prep_file` gives you the parsed tree with stable node ids; the mutation tools accept those ids and handle the parse/edit/serialize cycle for you. SAN is validated per mutation, move numbers are automatic, parenthesised variations are impossible to leave unbalanced.

Failure modes the tool layer now blocks (that used to trip LLMs writing raw PGN):

- **Unbalanced parentheses** — no longer possible; you address nodes, not text.
- **Bad SAN** — every `add_move` / `add_line` validates against the parent's FEN. Illegal moves are rejected with the position's FEN in the error so you can call `describe_position` to see legal moves.
- **Forgotten move numbers** — the exporter reconstructs them.
- **Nested variations losing context** — `add_move(parent_id=X, san=…)` binds unambiguously to node X.

## Optimistic locking

`read_prep_file` returns a `version` integer. Pass it back as `expected_version` on any mutation. If someone else (the user in the app, or a parallel agent session) updated the file since you read it, the save returns `409 Conflict` with the current version. You should:

1. Re-read the file to see what changed (node ids are stable across the concurrent edit, so your local references may still work).
2. Decide whether to merge or override.
3. Retry with the new version.

If you don't pass `expected_version`, it's last-write-wins — you might silently overwrite the user's manual edits. Only skip it when you know the file is untouched (e.g. you just created it).

## Grounding

Same rule as everywhere else in this MCP: **cite tool output in your PGN comments, don't invent chess prose**. A prep file that reads "White has practical chances" without a tool call to back it up is worse than a file that says "TODO: run cloud_analyse here". The user can view the file; if the commentary doesn't match the actual engine output, they see it.

Concrete pattern:

```
7. Nb3 {Lc0 at movetime=2000 gives +0.14 for White in the resulting IQP structure.
Stockfish scores 0.00 — the disagreement is the long-term positional weight Lc0
sees on the c6 pawn. Verified by running cloud_analyse at move 12 and confirming
Lc0's evaluation persists.}
```

vs

```
7. Nb3 {A strong positional move that gives White good chances.}
```

The first is what earns trust; the second is what makes the file worthless.

## Naming conventions

For the [Event] tag (which is the user-visible file name):

- Opponent prep: `"Prep vs <Player> (<Color>) — <YYYY-MM-DD>"`
- Opening study: `"<Opening> — <side>"` e.g. `"Najdorf 6.Bg5 — Black side"`
- Position analysis: `"<Position description> — <date>"`

Keep it short enough to fit in a picker (30-40 chars). Long titles get truncated in the app UI.

## When to create vs extend

- User asks "prep me against X" and no file matches → create.
- User asks "check line Y for our Firouzja prep" and a file matches → extend that file with new variations, save with expected_version.
- User asks "I found a novelty in the Najdorf" and a Najdorf file exists → extend.
- Rule of thumb: if the user's request semantically overlaps with an existing file's [Event] name or main opening line, extend.

## Appearance

Prep files land in whichever collection the user picked (via `create_prep_file(collection_id, name)`). They're first-class citizens in that collection — the user can browse, edit, share, or delete them from the app exactly like manually-created games. Your only visibility signal is the [Event] tag; make it descriptive.

The `/mcp` "AI Prep" hidden folder from earlier versions no longer exists. If the user has a collection literally named "AI Prep" it's one they created themselves.
