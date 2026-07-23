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

The mutation tool set is:

- `read_prep_file(id)` → returns `{version, tags, tree}`. Every node in `tree` has `san`, `fen`, `ply`, optional `comment`, `nags`, `annotations`, and `children`.
- `add_move(id, path, san)` — appends a new child of `path`. If `path` already has children, the new node becomes a variation. Returns the effective path of the new node.
- `set_comment(id, path, comment)` — replace comment. Empty string clears.
- `set_nags(id, path, nags)` — replace NAG list. Empty array clears.
- `set_annotations(id, path, {arrows, highlights})` — replace visual annotations. Empty arrays clear.
- `delete_subtree(id, path)` — remove node + descendants. Refuses to delete the root.
- `promote_variation(id, path)` — make the node at `path` its parent's mainline.
- `set_tag(id, key, value)` — set/clear a game-level tag.

Every mutation **auto-saves** with optimistic locking. Response is `{ok: true, path, version}`. Pass the returned `version` as `expected_version` on your next mutation to catch concurrent edits.

## Typical build order

1. `read_prep_file` — see what's there.
2. `add_move` to extend the mainline: `add_move(id, [], "e4")` then `add_move(id, [0], "c5")` etc.
3. `add_move` for a variation at some node: `add_move(id, [0, 0], "Nc3")` adds Nc3 as a sibling of the current mainline's move 2.
4. `set_comment` for plans / prep-signal, `set_nags` for evaluations, `set_annotations` for arrows and squares — always on the node the annotation belongs to.
5. `promote_variation` if a variation is more important than the current mainline.
6. `delete_subtree` to prune.

Every step returns the new `version`; carry it forward.

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

**Don't paste raw engine numbers into comments.** `{Stockfish gives +0.35}` is noise — `$14` is the signal. Same for `{Lc0 says +0.15}`.

**Don't name the engine unless it adds signal.** Naming Stockfish adds nothing to a `$14` on a routine position. Naming it makes sense when there's a mismatch worth flagging: `$14 {Human predictor gives 47% win at 2200 vs 2600 — the Elo gap does the practical work.}`

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
