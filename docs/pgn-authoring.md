# PGN authoring guide

You author prep files by mutating a tree, not by writing PGN text. The MCP layer holds a parser+exporter (chessops-backed) so every mutation call load-mutates-saves atomically — you only ever address nodes by id, never raw text or paths. No paren-counting, no move-numbering, no SAN typos surviving your edit, no index drift when a sibling is inserted.

## Node id addressing

Every node has a stable **`id`** — the LLM's handle on that node across mutation calls.

- Root id is `"r"`.
- Every other node id is an 8-hex-char content hash derived from `(parent.id, san)`.
- **IDs never change when other nodes are added, deleted or promoted.** Sibling insertions do not shift ids. Variation promotion does not shift ids. A node's id is a pure function of its position in the tree's SAN structure.
- **IDs are self-checking.** If you send a node_id the tree doesn't know, resolution fails immediately with a clear error — the LLM can't "make up" ids and have them silently work.

Every read gives you the id on every node. Every mutation call takes `node_id` (or `parent_id` for add_move / add_line) and returns the id it landed on. You chain ids from one call to the next.

## Workflow

Reading:

- `read_prep_file(id)` → returns `{version, tags, tree}`. Every node has `id`, `san`, `fen`, `ply`, optional `comment`, `nags`, `annotations`, `ceoEval`, and `children`.

Building (use these — one call for many ops):

- **`apply_mutations(id, mutations[])`** — batch. This is the primary build tool. Send 100 mutations in one call → one load-parse-mutate-save cycle instead of 100. When you're writing a repertoire from scratch, EVERYTHING should go through this. Individual mutation tools are for surgical follow-up edits, not for bulk work.
- **`add_line(id, parent_id, sans[])`** — a whole linear variation in one op. Cleaner than N `add_move` ops for straight lines. Overlapping prefixes with an existing branch **join** (same SAN from the same position IS the same move) — see below.
- **`auto_evaluate(id, node_id?)`** — walk from a node and populate the persistent `ceoEval` (Stockfish + Lc0 numbers) on every descendant via cloud_analyse. **Async job**: returns `{job_id, target_count, estimated_seconds}` immediately, does the work in the background. Poll with `auto_evaluate_status(job_id)` until `done:true`; cancel with `auto_evaluate_cancel(job_id)` if you change your mind (partial progress is checkpointed every 8 nodes so a cancel never loses more than a handful of evaluations). **Does NOT set visible NAGs** — the numbers land in a hidden `[%ceo-eval]` tag so you can read them back later. NAG placement (`$1` `!`, `$14` `⩲`, `$16` `±`, `$18` `+−`, etc.) is your editorial call. Skip nodes that already have a stored eval by default.

Per-op mutation tools (single-op calls, use for edits after the bulk build):

- `add_move(id, parent_id, san)` — appends a new child. If the parent has children, new node becomes a variation.
- `add_line(id, parent_id, sans[])` — appends a whole linear continuation as a sequence of children.
- `set_comment(id, node_id, comment)` — replace comment (empty string clears).
- `set_nags(id, node_id, nags)` — replace NAGs (empty array clears).
- `set_annotations(id, node_id, {arrows, highlights})` — replace visual annotations.
- `delete_subtree(id, node_id)` — remove node + descendants.
- `promote_variation(id, node_id)` — make the referenced node its parent's mainline.
- `set_tag(id, key, value)` — set/clear a game-level PGN tag.

All mutations **auto-save** with optimistic locking. Response includes the new `version`; pass it as `expected_version` on your next call to catch concurrent edits.

## Typical build order

1. `read_prep_file` — see what's there. Every node has an `id` you'll pass to the mutation and engine/DB tools.
2. `apply_mutations([...])` — one call with your whole intended build (a mix of `add_move` / `add_line` for structure, plus any `set_comment`/`set_annotations` you already know at author time, plus any `set_nags` where you already have a clear judgment — novelty `$146`, `!?` speculative sac, obvious `?` blunder in a sideline you're rejecting).
3. `auto_evaluate(id)` — spawns a background job that PERSISTS engine numbers on every node. Does not touch visible NAGs. Cheap way to get every position's Stockfish + Lc0 read baked into the file for later reference. Grab the returned `job_id` and either (a) poll `auto_evaluate_status(job_id)` every ~10-30s until done, or (b) fire and do useful work meanwhile (write more of the tree, walk the opponent's repertoire) and check back later — engine walk-time serialises on the per-combo semaphore, so it takes roughly `target_count × movetime_ms` in wall time.
4. Once the job reports `done:true`, re-read the file and add NAGs where they carry real signal (see NAG discipline below). Use individual mutation tools for surgical follow-ups (fix one comment, add one arrow, promote a specific variation, prune a branch).

The build-cost math: a 200-move file via individual `add_move` calls is 200 saves ≈ 100+ seconds of tool overhead. The same file via one `apply_mutations` call is one save ≈ 500ms. Use batch by default.

### Chaining node_ids across a batch

Node ids are content-derived, so when you `add_move` inside a batch, the id of the new node is a deterministic function of the parent's id + the SAN. In practice: **use the id the previous op returned as the `parent_id` of the next op** (the batch response gives you each `node_id` in order, and `add_line` gives you the full `line: [{node_id, san}, …]`).

Concretely, the response to a batch is:
```
{ ok: true, results: [{node_id: "3c7f592e"}, {node_id: "22012be0"}, ...], version: 42 }
```

If you know the tree ahead of time (writing from scratch), the deterministic recipe means you don't have to guess. But by far the easiest pattern is **`add_line` for straight lines, `add_move` for branch points** — you don't need to compute ids yourself.

### Two clean batch patterns

**Straight mainline:**
```
{op: "add_line", parent_id: "r", sans: ["e4","c5","Nf3","Nc6","Bb5"]}
// → returns { node_id: "<id-of-Bb5>", line: [{node_id, san}, ...] }
```

**Mainline + variation at a branch point:**
```
// First, the mainline:
{op: "add_line", parent_id: "r", sans: ["e4","c5","Nf3","d6"]}
// → line[2] is the Nf3 node — grab its node_id, call it NF3.

// Then the variation branching after Nf3:
{op: "add_line", parent_id: NF3, sans: ["Nc6","Bb5","Bd7"]}
```

### add_move / add_line join on existing SAN

`add_move` and `add_line` are **idempotent on SAN**: if a child with that SAN already exists under the parent, they return the existing child's id rather than creating a duplicate. In chess, same SAN from the same position IS the same move — two sibling children with SAN "d5" would be nonsensical.

This means you can freely send `add_line` batches that share a prefix — they build a clean Y-shape at the divergence point, not duplicate spines.

```
// Two Ruy Lopez lines that share the first 5 plies, diverging at Black's 3rd move:
{op: "add_line", parent_id: "r", sans: ["e4","e5","Nf3","Nc6","Bb5","Nf6","O-O"]}   // Berlin
{op: "add_line", parent_id: "r", sans: ["e4","e5","Nf3","Nc6","Bb5","a6","Ba4"]}     // Steinitz

// Result: single spine e4→e5→Nf3→Nc6→Bb5, then Bb5 has TWO children (Nf6, a6).
// Both add_line responses report every id on the resulting line, including
// the joined-prefix nodes, so you can address any of them next.
```

**Consequence for building repertoires**: you don't have to hand-decompose overlapping variations into a mainline + variation pair. Just send each variation as its own `add_line` from the same starting `parent_id`; the tree will de-dup the shared prefix automatically. Use `promote_variation` afterwards to pick which continuation is the mainline at the branch.

## What good looks like

Before writing your first substantial file, call `read_example_prep_files` — it returns two reference PGNs by a strong human coach. Read the full files; the rhythm and comment density are hard to convey in isolated snippets. What follows is a taste, not a substitute.

**From an Italian Fried Liver overview (both sides, 1600+ audience):**

```
5. Nxf7 {Most principled. Interesting is that not long ago computers were saying this
is winning for white. But modern strong engines almost immediately proclaim 0.00}
  Bxf2+ 6. Kf1 Qe7 7. Nxh8 d5 8. exd5 Nd4
9. d6 $1
  (9. c3 {Most played, and weak engines still like this move, but fail to spot}
    Bg4 10. Qa4+ Nd7 $1 {And black is winning} 11. Kxf2 Qh4+)
9... Qxd6 (9... cxd6 $2 10. Kxf2 Ng4+ 11. Kg1 $18 {and the d6 pawn blocks Qc5})
```

Note the register: *"weak engines still like this move, but fail to spot"* — one sentence orients the reader and cites the failure mode. `$1` marks the resource, `$2` marks the trap, `$18` marks the resulting winning position — every glyph earns its place. No `{Stockfish gives 0.00 depth 22}` verbose engine chatter.

**From a Najdorf 6.f4 White repertoire (2200+ audience):**

```
6... e6 {a common continuation, but usually in the Najdorf, e6 setups give white
enough time to put their pieces in good positions, and here its no exception.}
7. Qf3 {And black is already in danger. White just plans to finish development with
Be3, long castle and g4.}
  (7. g4 {is too early:} e5 $1 8. Nf5 Nc6 {[%cal Gg7g6]})
7... Qc7
8. g4 {White has easy play}
  Nc6 9. Nxc6 bxc6 10. g5 Nd7 11. Bd2 $16 {[%cal Ge1c1,Gh2h4]}
```

Two `[%cal]` arrows on the last move show the whole plan (castle long, push h4). *"White has easy play"* is a five-word verdict that beats three sentences of hedged eval prose. The parenthesised sideline shows exactly WHY 7.g4 is premature — one variation, one point.

**What both files share:**

- Named citations: Karpov–Beliavsky, Nepomniachtchi, Mamedov–Volokitin, John Ludvig Hammer 2024. Concrete anchors the reader can look up.
- Practical framing: *"objectively black has no compensation for the pawn, it does seem black still has some practical chances"* — separates objective from practical explicitly.
- Move-order guidance in the reader's voice: *"Here it's easy for white to mess up the move order. If black wants to go exd4, you should be ready — d3 is a way to remember that white should castle first."*
- Terse verdicts at line ends: *"White is a clean pawn up."* *"black is cooked"* *"All correspondence games here ended in a draw."* *"With a very unclear position."*
- Zero decorative annotation: `[%csl Rf7]` on the Fried Liver f7 attack is one square, one colour, all signal.

Study `read_example_prep_files` before writing at scale. The gap between "correct" prep and "prep worth reading" is entirely commentary discipline, and these two files are the target.

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
- **Restating what the app already renders.** The reader opens the file in the app and sees: every sibling move (with count / avg rating / top players from the DB), each node's stored `ceoEval`, the NAG glyphs, the tree structure. Duplicating any of that in prose is pure noise.

  - ❌ `{5...Bb4 (180/247), 5...d6 (26), 5...Be7 (18), 5...d5 (7), 5...g6 (2)}` — those are the sibling variations, already visible.
  - ❌ `{Main move, 180 of 247 games (So, Giri, Karjakin, Duda). Eval −0.20/−0.27.}` — count, top players, eval all shown by the app.
  - ✅ `{Main move; the sharpest test is actually 5...d5 (only 7 games but avg 2526) — see the variation.}`
  - ✅ `{Popular, but leads to the endgame Black draws — 6.Bd2 is where prep depth matters.}`

  Test: if the reader can see it by looking at the position or clicking a branch, don't write it. Prose is only for plans, prep-signal, or WHY — the layer the app can't derive.

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

**NAGs are editorial, not automatic.** `auto_evaluate` (and its `auto_evaluate_status` poll) persists engine numbers on every node but does NOT set visible NAGs — because a repertoire full of 0.00 opening theory does not want a `$10` (=) glyph plastered on every move. That's noise, not signal. NAGs are your call: mark moves that carry a judgment a reader can't derive by looking at the board.

Where NAGs actually earn their place:

- **`$146` (novelty)** — a move that hasn't appeared at this level. Only set if you actually know this (e.g. saw 0 games via `get_position_stats`).
- **`$5 !?` (interesting/speculative)** — a committal move you're recommending anyway (a piece sac, a positional pawn concession).
- **`$1 !` / `$3 !!`** — objectively good moves the reader might miss.
- **`$2 ?` / `$4 ??` / `$6 ?!`** — mistakes in a sideline you're showing to reject.
- **`$14/$15` (⩲/⩱)** and **`$16/$17` (±/∓)** — assessments on positions where the direction of pressure matters for the plan you're teaching. Skip these on 0.00 theory nodes.
- **`$18/$19` (+−/−+)** — decisive advantages, use where the reader should recognise the position is winning.
- **`$44` (compensation)** on a genuine gambit; **`$13` (∞)** on a genuinely sharp/unclear position that engines don't resolve.

Where NAGs are noise: every `$10` "=" glyph on every equal position. If the whole tree is 0.00, that's the *default state* — leave it unmarked and the reader understands.

When reading back a file, `node.ceoEval.nag` carries the threshold-derived NAG (`$10` / `$14` / `$16` / `$18` etc.) — treat it as a *suggestion*, not an automatic write. Promote it to a visible NAG only when a glyph on that move actually helps the reader.

**Persisted evals travel with the file.** Every node with an eval gets `ceoEval: { sf: {cp: 25, depth: 32}, lc0: {cp: 30, depth: 18}, nag: "$14" }` on subsequent `read_prep_file` calls. Stored as `[%ceo-eval sf=+0.25/32 lc0=+0.30/18 nag=$14]` inside the PGN comment (an escape tag the app hides from the board view, just like [%cal] / [%csl]). So a re-read after auto_evaluate gives you every position's number without re-running cloud_analyse. Query tools (get_position_stats, get_prep_position, prep_snapshot) also auto-attach a live `eval` at the request position when a cloud engine is running.

**Engine numbers in prose: brief only.** If you must reference a number, keep it compact:

- Good: `{... +0.2}` — bare number at the end of a note
- Bad: `{Stockfish depth 22 shows +0.25, Lc0 depth 18 shows +0.4, both engines agree}` — verbose noise

**Don't name the engine unless it adds signal.** "SF: +0.15" for a routine position is noise. Name it when there's a mismatch worth flagging: `{Human predictor gives Black 47% win despite the -0.35 objective eval — Elo gap does the work.}`

**Only quote engine numbers for positions you actually called `cloud_analyse` on** (or that carry a `ceoEval` from an earlier auto_evaluate, or an auto-attached `.eval` from a query tool). Do NOT infer an eval for a parent position from its children and then write "both engines 0.00" on the parent — that reads as a measurement but is a guess. If the position wasn't analysed, either analyse it or omit the number: prose can say "both continuations run to 0.00, so this looks balanced" without claiming an eval that wasn't taken.

**When you set `contempt`, attribute it to Lc0 only.** Contempt affects Lc0 exclusively — Stockfish always analyses objectively. So don't write "both engines at contempt −30" — that misleads the reader into thinking SF was biased too. Correct phrasings:

- `{Lc0 (contempt −30): 0.00 — even biased toward Black, still balanced. SF objective: 0.00.}`
- `{With Lc0 nudged toward Black (contempt −30) it still picks Qg6 at 0.00; SF's objective read also 0.00.}`

If you only quote the Lc0 number, disclose the bias in the same sentence — `{Lc0 gives Black +0.30}` with an undisclosed `contempt=-30` is a false objectivity claim.

Contempt scale is signed 0-100 (same as the web UI's ContemptStrength slider). Typical: `±10-20` a light nudge, `±30-60` real fighting play, `±80-100` maximum steer.

### Before you write any commentary: describe_position

LLMs are not reliable at reading FEN strings — you'll swap files/ranks, invent captures, miscount pieces. Before you write a comment describing what's happening in a position, call `describe_position(fen)`. Pure computation (~1 ms, no engine), returns two layers:

**Board state** — piece placements, material, contested pieces (attackers + defenders), hanging list, check state, castling, en passant, legal moves. Fixes the *"Black's queen on c7 is defended by the knight on d5"* failure when actually there's no knight on d5 and the queen is on c8.

**Structural analysis** — the concepts a strong player reads at a glance but the LLM can't derive from a FEN:

- `pawnStructure.files` — open / half-open / closed per column (rook targets).
- `pawnStructure.isolated`, `doubled`, `passed`, `backward` — structural weaknesses (and strengths, for passed).
- `weakSquares` — holes no friendly pawn can ever attack.
- `outposts` — friendly N/B on an enemy hole defended by own pawn.
- `bishops` — good / mixed / bad per bishop, based on own pawns on its colour. `bishops.pair` flags who has both.
- `space` — squares in the enemy half controlled by each side.

Use these instead of inventing structural claims. Commentary that says *"Black has the bad light-squared bishop"* should trace to `bishops.black[0].quality === "bad"`, not to a memory of similar Carlsbad positions.

The same call also returns `engineEvalTerms` — Stockfish's classical-eval breakdown into 13 named terms per colour (mg/eg). Compare it before/after a candidate move: the term that shifts most tells you WHAT the move changed. See the engine-usage guide for the delta pattern.

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

**Use them.** An arrow says what a sentence would. If a comment mentions a move, a plan, a square, a target — draw it. The reader sees the board; a green f2→f4 arrow replaces "White's plan is to break with f4"; a red square on h6 replaces "Black's weak point is h6". Annotations are the fastest LLM→reader channel we have.

**When to reach for one (any of these triggers → add):**

- Naming a pawn break in prose → arrow from the pawn to its target square (`green` for your break, `red` for the opponent's).
- Naming a plan involving specific moves (castle long, Nc4-a5, Bxh6) → arrow(s) for the piece routes.
- Naming a key square / weak square / target → highlight (`green` = key square for you, `red` = weak square you exploit or that Black attacks).
- Naming a piece under pressure or a piece that will become the target → highlight the square it's on.
- Showing multiple candidate moves in one comment → arrow per candidate, different colours.

If the comment could be *replaced* by two arrows and a highlighted square, then the arrows + squares alone are better and the prose is redundant. Try that direction first.

`set_annotations(id, node_id, {arrows, highlights})` sets both together — atomic replacement, pass both current and new. Empty arrays clear.

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

**Keep it light.** 1–3 arrows per node and 2–3 highlighted squares is plenty. Twenty arrows is noise. Highlights are labels, not decoration. **But zero arrows on a strategic branch-point comment is usually a miss** — if the comment names a plan, a break, a square, or a piece, the corresponding annotation almost certainly exists and is worth adding.

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
