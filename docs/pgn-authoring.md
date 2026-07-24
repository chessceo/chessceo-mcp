# PGN authoring guide

You author prep files by mutating a tree, not by writing PGN text. The MCP layer holds a parser+exporter (chessops-backed) so every mutation call load-mutates-saves atomically — you only ever address nodes, never raw text. No paren-counting, no move-numbering, no SAN typos surviving your edit.

## Path addressing

Nodes are addressed by **path**: an array of child indices from the root.

- `[]` — the root position (empty board state, before any move).
- `[0]` — the first mainline move (root's first child).
- `[0, 0]` — the second ply on the mainline.
- `[0, 1]` — a variation branching after the first move (sibling of `[0, 0]`).
- `[0, 0, 0, 1]` — a variation branching at the third ply.

`children[0]` is always the mainline; `children[1..N]` are alternative variations in declaration order. `promote_variation` swaps this order.

## Workflow

Reading:

- `read_prep_file(id)` → returns `{version, tags, tree}`. Every node in `tree` has `san`, `fen`, `ply`, optional `comment`, `nags`, `annotations`, and `children`.

Building (use these — one call for many ops):

- **`apply_mutations(id, mutations[])`** — batch. This is the primary build tool. Send 100 mutations in one call → one load-parse-mutate-save cycle instead of 100. When you're writing a repertoire from scratch, EVERYTHING should go through this. Individual mutation tools are for surgical follow-up edits, not for bulk work.
- **`auto_evaluate(id, path?)`** — walk the tree from `path` and auto-assign the right NAG to every node by running cloud_analyse on each position. Standard threshold table (below). Costs real engine time but frees you from hand-annotating evals. Skip nodes that already have a NAG by default.

Per-op mutation tools (single-op calls, use for edits after the bulk build):

- `add_move(id, path, san)` — appends a new child. If `path` has children, new node becomes a variation.
- `set_comment(id, path, comment)` — replace comment (empty string clears).
- `set_nags(id, path, nags)` — replace NAGs (empty array clears).
- `set_annotations(id, path, {arrows, highlights})` — replace visual annotations.
- `delete_subtree(id, path)` — remove node + descendants.
- `promote_variation(id, path)` — make the node at `path` its parent's mainline.
- `set_tag(id, key, value)` — set/clear a game-level PGN tag.

All mutations **auto-save** with optimistic locking. Response includes the new `version`; pass it as `expected_version` on your next call to catch concurrent edits.

## Typical build order

1. `read_prep_file` — see what's there.
2. `apply_mutations([...])` — one call with your whole intended build (all `add_move` for the moves and variations, plus any `set_comment`/`set_annotations` you already know at author time). Skip `set_nags` — auto_evaluate handles that.
3. `auto_evaluate(id)` — walk the tree, get engine evals, assign NAGs. One shot.
4. Individual mutation tools ONLY for surgical follow-ups (fix one comment, add one arrow, promote a specific variation, prune a branch).

The build-cost math: a 200-move file via individual `add_move` calls is 200 saves ≈ 100+ seconds of tool overhead. The same file via one `apply_mutations` call is one save ≈ 500ms. Use batch by default.

### Path math in a batch

Paths in each mutation resolve against the tree AFTER previous ops in the batch. When you `add_move(path=[0], san='c5')`, the new c5 lands at `[0, 0]` if [0] had no children, or `[0, N]` if it had N. Your next mutation in the batch can address the new node directly. The tree is deterministic — you can compute all paths ahead of time.

For a linear mainline build from an empty file:
```
{op: "add_move", path: [],        san: "e4"}   // lands at [0]
{op: "add_move", path: [0],       san: "c5"}   // lands at [0, 0]
{op: "add_move", path: [0, 0],    san: "Nf3"}  // lands at [0, 0, 0]
{op: "add_move", path: [0, 0, 0], san: "d6"}   // lands at [0, 0, 0, 0]
...
```

For a variation at some point:
```
{op: "add_move", path: [0, 0], san: "Nc3"}   // variation branching after move 2; lands at [0, 0, 1]
{op: "add_move", path: [0, 0, 1], san: "d5"} // continue the variation; lands at [0, 0, 1, 0]
```

## Variations vs prose

**Variations are moves, not sentences.** This was the biggest failure mode of raw-PGN authoring — LLMs writing "if Black plays Be6 White responds with f3" as prose. In the tree model there's no such temptation: variations are `add_move` calls at the branching node.

Prose comments are for what MOVES cannot say:

- **Plans**: `{Plan: exchange dark-square bishops, then break with f5.}`
- **Prep-signal**: `{Firouzja plays this in 32 games since 2023, scores 41%.}`
- **Interpretation the app can't derive**: `{IQP structure; Black's plan is …Nb4.}`
- **Practical layer beyond the objective eval**: `{Objectively equal, but Black must remember 8 precise moves; White plays this blindfolded.}`

Prose is NEVER for:

- Move sequences ("then Nf3, then Bg5, ...") — use variations.
- Move recommendations ("here White should play h4") — add_move it.
- Restating the eval a NAG already conveys.
- **Describing a sibling variation you already added as a branch.** If move A has variation B added as `add_move(A, sibling)`, don't ALSO write `{if B then ...}` on A. The reader clicks B on the board — the branch is already there.

## Move-judgment symbols (NAGs)

NAGs are the compact way to attach an evaluation to a move. Pass as `$N` strings to `set_nags`.

| NAG   | Symbol  | Meaning                                                        |
|-------|---------|----------------------------------------------------------------|
| `$1`  | `!`     | Good move                                                      |
| `$2`  | `?`     | Mistake                                                        |
| `$3`  | `!!`    | Brilliant move                                                 |
| `$4`  | `??`    | Blunder                                                        |
| `$5`  | `!?`    | Interesting / speculative                                      |
| `$6`  | `?!`    | Dubious                                                        |
| `$10` | `=`     | Equal                                                          |
| `$13` | `∞`     | **Unclear** — position genuinely hard to evaluate              |
| `$14` | `⩲`     | White slightly better                                          |
| `$15` | `⩱`     | Black slightly better                                          |
| `$16` | `±`     | White clearly better                                           |
| `$17` | `∓`     | Black clearly better                                           |
| `$18` | `+−`    | Winning for White                                              |
| `$19` | `−+`    | Winning for Black                                              |
| `$36` | `↑`     | With initiative                                                |
| `$40` | `→`     | With attack                                                    |
| `$44` | `=/∞`   | **Compensation** for the material                              |
| `$132`| `⇆`     | With counterplay                                               |
| `$140`| `∆`     | With the idea …                                                |
| `$146`| `N`     | **Novelty** — this move has not been played before at this level |

### Eval → NAG thresholds (the rule)

Engine numbers go into the NAG, not into prose. Convert the eval to the correct NAG once and be done.

| Engine eval (White POV) | NAG (White ahead)       | NAG (Black ahead)       |
|-------------------------|-------------------------|-------------------------|
| `\|eval\| < 0.25`         | `$10` (=)               | `$10` (=)               |
| `0.25 ≤ \|eval\| < 0.6`   | `$14` (⩲)               | `$15` (⩱)               |
| `0.6 ≤ \|eval\| < 1.3`    | `$16` (±)               | `$17` (∓)               |
| `\|eval\| ≥ 1.3`          | `$18` (+−)              | `$19` (−+)              |
| Sharp, hard to evaluate | `$13` (∞)               | `$13` (∞)               |

**Prefer auto_evaluate for the NAG.** Don't hand-write NAGs when building — call `auto_evaluate(id)` after your build and it assigns the right glyph to every node from actual engine analysis. Manual `set_nags` is for overrides (mark a novelty with $146, flag a `$5 !?` piece sac).

**Persisted evals travel with the file.** Every node with an eval gets `ceoEval: { sf: {cp: 25, depth: 32}, lc0: {cp: 30, depth: 18}, nag: "$14" }` on subsequent `read_prep_file` calls. Stored as `[%ceo-eval sf=+0.25/32 lc0=+0.30/18 nag=$14]` inside the PGN comment (an escape tag the app hides from the board view, just like [%cal] / [%csl]). So a re-read after auto_evaluate gives you every position's number without re-running cloud_analyse. Query tools (get_position_stats, get_player_preparation, prep_snapshot) also auto-attach a live `eval` at the request position when a cloud engine is running.

**Engine numbers in prose: brief only.** If you must reference a number, keep it compact:

- Good: `{... +0.2}` — bare number at the end of a note
- Bad: `{Stockfish depth 22 shows +0.25, Lc0 depth 18 shows +0.4, both engines agree}` — verbose noise

**Don't name the engine unless it adds signal.** "SF: +0.15" for a routine position is noise. Name it when there's a mismatch worth flagging: `{Human predictor gives Black 47% win despite the -0.35 objective eval — Elo gap does the work.}`

**Only quote engine numbers for positions you actually called `cloud_analyse` on** (or that carry a `ceoEval` from an earlier auto_evaluate, or an auto-attached `.eval` from a query tool). Do NOT infer an eval for a parent position from its children and then write "both engines 0.00" on the parent — that reads as a measurement but is a guess. If the position wasn't analysed, either analyse it or omit the number: prose can say "both continuations run to 0.00, so this looks balanced" without claiming an eval that wasn't taken.

**When you set `contempt`, attribute it to Lc0 only.** Contempt affects Lc0 exclusively — Stockfish always analyses objectively. So don't write "both engines at contempt −15" — that misleads the reader into thinking SF was biased too. Correct phrasings:

- `{Lc0 (contempt −15): 0.00 — even biased toward Black, still balanced. SF objective: 0.00.}`
- `{With Lc0 nudged toward Black (contempt −15) it still picks Qg6 at 0.00; SF's objective read also 0.00.}`

If you only quote the Lc0 number, disclose the bias in the same sentence — `{Lc0 gives Black +0.30}` with an undisclosed `contempt=-15` is a false objectivity claim.

**Lc0 depth < 15 is a shallow read.** Lc0's node budget is capped per call, so on many positions it stops well before Stockfish. If the Lc0 leg comes back at depth 8–14, treat it as a hint, not a verdict — and weight Stockfish's deeper number more when the two disagree. Don't dress a shallow Lc0 number as authoritative in prose.

### Before you write any commentary: describe_position

LLMs are not reliable at reading FEN strings — you'll swap files/ranks, invent captures, miscount pieces. Before you write a comment describing what's happening in a position, call `describe_position(fen)`. It's pure computation (no engine, ~1ms) and returns the same board state a human sees:

- All piece placements per colour (SAN-style: `Nf3`, `Bg7`, `e4`)
- Material balance in pawn units (`"white +1 (39 vs 38)"`)
- Every contested piece: attackers + defenders (e.g. `{target: "e5", color: "black", attackers: ["Nf3"], defenders: ["Nc6"]}`)
- Hanging list — attacked and undefended
- Check state + checkers, castling rights, en passant

Use it whenever you're about to describe a position from memory or from your reading of a FEN. The failure mode this prevents: `{Black's queen on c7 is defended by the knight on d5.}` when actually there's no knight on d5 and the queen is on c8.

### When prose ADDS to the NAG

Prose is worth writing when the NAG *understates* something the human should know:

Good (NAG says equal, prose adds the practical wrinkle):
```
set_comment(id, path, "Lc0 still gives Black a small pull — dark-square control is long-term, engine horizon can't quite reach it.")
set_nags(id, path, ["$10"])
```

Good (NAG tells the truth, prose flags a mismatch worth noting):
```
set_comment(id, path, "Human predictor: 47% win at 2200 vs 2600 — the Elo gap does the practical work despite the small objective edge.")
set_nags(id, path, ["$14"])
```

Bad (prose duplicates the NAG, adds nothing):
```
set_comment(id, path, "Stockfish gives +0.35 for White here.")
set_nags(id, path, ["$14"])
```

## Visual annotations (arrows + coloured squares)

`set_annotations(id, path, {arrows, highlights})` sets both together (an atomic replacement — pass both current and new). Passing empty arrays clears.

Colours (both arrows and squares): `green`, `red`, `yellow`, `light-blue`, `dark-blue`, `orange`.

Usage conventions:

| Colour     | Typical use                                    |
|------------|------------------------------------------------|
| green      | Good move / plan / key square for you          |
| red        | Threat / opponent's target / danger square     |
| yellow     | Worth-noting / candidate                       |
| light-blue | Neutral pointer / diagram note                 |
| dark-blue  | Alternative / secondary idea                   |
| orange     | Attention / warning                            |

**Keep it light.** 1–3 arrows per node and 2–3 highlighted squares is plenty. Twenty arrows is noise, not signal — pick the most important ones. Highlights are labels, not decoration.

Example:
```
set_annotations(id, path, {
  arrows: [
    { color: "green", from: "f2", to: "f4" },
    { color: "green", from: "c1", to: "h6" },
  ],
  highlights: [
    { color: "green", square: "g6" },
    { color: "red",   square: "h6" },
  ],
})
```
Renders as a green f2→f4 arrow, a green c1→h6 arrow, a green square on g6, and a red square on h6 — attached to whichever node's path you specified.

## Errors and how to recover

- **Illegal SAN**: `add_move` validates against the position and rejects illegal moves with a message including the position's FEN. Re-check what position you thought you were at, then retry.
- **Path out of bounds**: happens if you call a mutation with a path from an older read that's been changed since. Re-read the tree, recompute paths, retry.
- **Version conflict (409)**: someone (the user in the app, or a parallel agent session) edited the file since your last read. Re-read, decide whether to merge or override, retry with the new version.
