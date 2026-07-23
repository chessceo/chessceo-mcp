# PGN authoring guide

How to write a chess PGN that renders correctly and doesn't waste tokens or the user's time. Applies to any file you write through `save_prep_file` (or any tool that produces PGN).

## The shape of a PGN

```pgn
[Event "..."]
[White "..."]
[Black "..."]
[Date "YYYY.MM.DD"]

1. e4 c5 2. Nf3 d6 (2... e6 3. d4) 3. d4 cxd4 4. Nxd4 Nf6

*
```

Pieces:

- **Tag pairs** at the top: `[Key "Value"]`, one per line. Standard tags: `Event`, `Site`, `Date` (`YYYY.MM.DD`), `Round`, `White`, `Black`, `Result`. For prep, `Event` is the file's user-facing name — pick this carefully.
- **Movetext**: numbered SAN moves. Full move number before White's move (`1.`), and again with `...` before Black's move only when Black's move follows a comment or a variation (`{...}` `1... e5`).
- **Variations** in `( ... )` at the branching move. Nesting allowed.
- **Comments** in `{ ... }`. Attach after the move they discuss.
- **NAGs** as `$N` right after the SAN.
- **Result marker** at the end: `*` for unfinished (prep files always), `1-0`, `0-1`, `1/2-1/2`.

## Variations belong in parentheses, not prose

**This is the single biggest discipline point.** LLMs love to write "if Black plays Be6 White continues with 8. f3 and after Nbd7 9. Qd2 h5 White plays g4." That is prose *describing* moves — worse than useless: the app cannot step through it on a board, the engine cannot analyse it, the user cannot click.

Wrong:
```
7. Nb3 {If Black plays Be6 White continues with 8. f3 and after Nbd7
9. Qd2 h5, White should play g4 to blunt the kingside attack.}
```

Right:
```
7. Nb3 Be6 (7... h5 {Aggressive but concedes tempo.} 8. Nd5 $14)
8. f3 Nbd7 9. Qd2 h5 10. g4 {Blunting the h5-pawn's support.}
```

**The rule: if it can be encoded as moves, encode it as moves.**

What IS fine in prose:
- **Plans**: `{Plan: exchange dark-square bishops, then break with f5.}`
- **Prep-signal**: `{Firouzja plays this in 32 games since 2023, scores 41%.}`
- **Interpretation the app can't derive**: `{IQP structure. Black's plan is …Nb4 to trade the c3-knight.}`
- **Engine citations**: `{Lc0 +0.15 here; Stockfish sees 0.00 — probably a long-term factor.}`

What is NEVER fine in prose:
- Move sequences ("then Nf3, then Bg5, ...")
- Move recommendations ("here White should play h4")
- Anything that would render as a legal move on the board

## Move-judgment symbols (NAGs)

PGN NAG codes render as the standard chess symbols in the chess.ceo app. One or two per key move is normal — don't annotate every move.

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

Attach the NAG to the move it applies to:
```
14. Nd5 $5 {Speculative — concrete lines are messy but Black must know them.}
14... Nxd5 $146 {New. Previous games saw 14...exd5 15. Nxd5 with an edge.}
15. exd5 $44 {Black has piece activity + two bishops for the pawn.}
```

## Visual annotations (arrows, coloured squares)

The chess.ceo app renders arrows and highlighted squares directly on the board. Use the ChessBase / Lichess convention inside a move's `{...}` comment.

- **Arrows**: `[%cal <colour><from><to>,<colour><from><to>,...]`
  - Example: `[%cal Gd2d4,Rf3g5]` — green arrow d2→d4, red arrow f3→g5
- **Coloured squares**: `[%csl <colour><square>,...]`
  - Example: `[%csl Rf7,Ge5]` — red square on f7, green on e5

**Colour codes** (single letters):

| Code | Colour     | Typical use                                    |
|------|------------|------------------------------------------------|
| `G`  | Green      | Good move / plan / key square for you          |
| `R`  | Red        | Threat / opponent's target / danger square     |
| `Y`  | Yellow     | Worth-noting / candidate                       |
| `C`  | Light blue | Neutral pointer / diagram note                 |
| `B`  | Dark blue  | Alternative / secondary idea                   |
| `O`  | Orange     | Attention / warning                            |

Example move combining plan + arrows + square:
```
10. O-O {Plan: aim for f4-f5, exchange the dark-square bishop, then attack g6.
[%cal Gf2f4,Gc1h6,Yh2h4] [%csl Gg6,Rh6]}
```

**Discipline for visual annotations:**

- **Keep them light.** 1–3 arrows per move and 2–3 highlighted squares is plenty. Twenty arrows is noise, not signal.
- **Highlights are labels, not decoration.** Every coloured square should point at something specific in the plan you're writing. Don't paint the board rainbow.
- **Arrows show intent, not calculation.** A green arrow d2→d4 says "the plan is to push d4" — for concrete sequences, use variations.

## Common pitfalls to check yourself against

1. **Unbalanced parentheses.** Every `(` needs a matching `)`. If you added variations, count them.
2. **Bad SAN.** `Nfd7` when you meant `Nbd7`. Always trace the position in your head (or use the tree from `read_prep_file`'s response) before writing a move.
3. **Forgotten move numbers.** `1. e4 c5 2. Nf3` — after each White move you need `<num>.`, Black's move continues implicitly. In variations that start at Black's move, PGN wants `2... Nc6`.
4. **Nested variations losing context.** `1.e4 e5 (1...c5 (2.Nf3 d6))` — the inner variation branches at `2.Nf3` off the c5 sideline, not off the mainline. Two levels of nesting is usually enough; three is confusing; four is unreadable.
5. **Blank Event tag.** The prep-files list shows the Event as the file's name — empty = "Untitled" everywhere.
6. **Comment-inside-comment.** PGN doesn't nest braces. If your comment needs to reference a variation, use a variation, not a nested comment.

## Backend validates on save

If your PGN is malformed, `save_prep_file` returns 400 with the parser error. Read it, fix it, retry. Compute is cheap — don't be shy about the retry loop when you're not sure your syntax is right.
