# Prep files guide

You can save chess prep to the user's chess.ceo account and read it back across sessions. This is the persistence layer that turns your analysis from ephemeral chat into a durable, viewable-in-app repertoire.

## The mental model

The user has **one** collection dedicated to your work — labelled "AI Prep" in their chess.ceo app with a 🤖 icon. Inside it, each **prep file** is one PGN game with variations. You never see the collection itself; the tools operate directly on the files inside it.

File-level tools:

- `list_prep_files` — show me all my prep files
- `search_prep_files(query)` — find by opponent name / opening keyword
- `read_prep_file(id)` — parsed tree (every node carries a stable `id`) + tags + `version`
- `create_prep_file(name)` — new empty file, `name` becomes the [Event] tag
- `delete_prep_file(id)` — soft delete (user can restore from app)

Mutation tools (edit an existing file — you never touch raw PGN):

- `apply_mutations(id, [...])` — batch: N ops in one save. **Primary build tool.**
- `add_move`, `add_line`, `set_comment`, `set_nags`, `set_annotations`, `delete_subtree`, `promote_variation`, `set_tag` — individual ops for surgical follow-ups. See `read_pgn_authoring_guide` for the full mutation vocabulary.

Every mutation call takes a `node_id` (or `parent_id` for add-style ops) and auto-saves. Nodes are addressed by stable content-derived id, not by path — sibling insertions / deletions / promotions never shift ids. Root id is `"r"`.

## The single most important habit

**Before creating a new file, search for an existing one.** LLMs make three "Prep vs Firouzja" files in a row all the time. Always:

1. `list_prep_files` (if the user has ≤20-30 files) or `search_prep_files(query=<opponent name>)` for their key term
2. Read the ones that look relevant
3. Decide: extend an existing one (save_prep_file) or genuinely start fresh (create_prep_file)

Duplicate files are the #1 way to lose your user's trust in this system.

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

## Icons and appearance

The user sees your files in a collection called "AI Prep" with a 🤖 icon under folder `/mcp` in their chess.ceo app. This is intentional — they can tell at a glance which prep came from you, and they can browse / edit / delete from the app just like their manual work. Your files are first-class citizens on their account.
