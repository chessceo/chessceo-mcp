# Prep files guide

You can save chess prep to the user's chess.ceo account and read it back across sessions. This is the persistence layer that turns your analysis from ephemeral chat into a durable, viewable-in-app repertoire.

## The mental model

The user has **one** collection dedicated to your work — labelled "AI Prep" in their chess.ceo app with a 🤖 icon. Inside it, each **prep file** is one PGN game with variations. You never see the collection itself; the tools operate directly on the files inside it.

Six tools:

- `list_prep_files` — show me all my prep files
- `search_prep_files(query)` — find by opponent name / opening keyword
- `read_prep_file(id)` — full PGN + parsed mainline tree + `version`
- `create_prep_file(name, pgn?)` — new file, `name` becomes the [Event] tag
- `save_prep_file(id, pgn, expected_version)` — replace the whole PGN
- `delete_prep_file(id)` — soft delete (user can restore from app)

## The single most important habit

**Before creating a new file, search for an existing one.** LLMs make three "Prep vs Firouzja" files in a row all the time. Always:

1. `list_prep_files` (if the user has ≤20-30 files) or `search_prep_files(query=<opponent name>)` for their key term
2. Read the ones that look relevant
3. Decide: extend an existing one (save_prep_file) or genuinely start fresh (create_prep_file)

Duplicate files are the #1 way to lose your user's trust in this system.

## PGN structure

Real chess prep files are PGN with parenthesised variations. Learn the shape:

```pgn
[Event "Prep vs Firouzja (Black) — 2026-07-23"]
[White "Firouzja, Alireza"]
[Black "Van Foreest, Jorden"]
[Date "2026.07.23"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3
{Main line. Firouzja plays this in 68% of his English Attacks (32 games, 2023-2025).}
7... Be6 8. f3
(8. Qd2 Nbd7 9. f3 h5 {Sideline he tried once and lost — probably patched.})
8... Nbd7 9. Qd2 h5
{Critical position for us. Lc0 at multipv=3 gives:
 - h5: +0.12 (main line, active)
 - Be7: +0.08 (calm, more classical)
 - Rc8: 0.00 (Stockfish preferred)}

*
```

The pieces:

- **PGN tag pairs at the top** (`[Key "Value"]`) — `Event` is the name you show the user. `White` / `Black` set the game headers. `Date` is standard.
- **Mainline** = your top recommendation. Numbered SAN moves separated by whitespace.
- **Variations** in parentheses `(...)` at the branching move. Nesting is allowed but be conservative — three deep is a lot.
- **Comments** in curly braces `{...}` between moves. This is where you cite tool output:
  - `{Lc0 says +0.15 in this line vs 0.00 for the alternative}`
  - `{Firouzja plays this in 32/47 games with Black. Scores 41%.}`
  - `{Stockfish sees h4 as a tactical shot; Lc0 disagrees. Deep look needed.}`
- **NAG glyphs** for evaluations at a move (optional): `$1` (!), `$2` (?), `$3` (!!), `$4` (??), `$6` (=), `$10` (=), `$14` (+/=). Placed right after the SAN: `7. Nb3 $1`.
- **Result marker** at the end: `*` for unfinished (prep files are always unfinished), `1-0`, `0-1`, `1/2-1/2`.

## Editing without breaking the tree

You get the whole PGN back from `read_prep_file`, edit it in your head, send back via `save_prep_file`. There's no partial-patch API — small edits still resend the full text. The file is small (repertoire = maybe 5-20 KB), that's fine.

Common LLM failure modes to catch yourself doing:

- **Unbalanced parentheses.** Every `(` needs a matching `)`. Count them if you added variations. The backend parses on save; if invalid, you get 400 with the parser error and have to retry.
- **Bad SAN.** `Nfd7` where you meant `Nbd7`. Always trace the position in your head (or use the tree from read_prep_file's response) before writing a move.
- **Forgotten move numbers.** `1. e4 c5 2. Nf3` — after each White move you need `<num>.`, after each Black move the number continues implicitly until the next full move. In variations at Black's move, PGN wants `2... Nc6`.
- **Nested variations losing context.** `1.e4 e5 (1...c5 (2.Nf3 d6))` — the inner variation branches at `2.Nf3` off the c5 sideline, not off the mainline. This gets confusing fast; two levels is usually enough.
- **Blank Event tag** — the user's list_prep_files response shows the Event tag as the name. Empty tag = "Untitled" everywhere.

## Optimistic locking

`read_prep_file` returns a `version` integer. Pass it back as `expected_version` on `save_prep_file`. If someone else (the user in the app, or a parallel agent session) updated the file since you read it, save returns `409 Conflict` with the current version. You should:

1. Re-read the file to see what changed.
2. Merge your edits with theirs.
3. Retry the save with the new version.

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
