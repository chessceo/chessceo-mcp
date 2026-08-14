# Summary prep files — the 15-minute-read shape

**Read this before writing any prep file the user calls a "summary" — or when they want prep they'll actually READ, not just consult.**

## What a summary file is

A summary file is a prep artifact optimized for one thing: **the reader can walk through it in ~15 minutes and come out knowing why the mainline is the mainline, where the novelty is, and what the plan is against each of the top few responses.**

The reference is Peter Heine Nielsen's two-file convention from Magnus Carlsen's World Championship prep. Same repertoire, two files:

- **Big / reference file** — exhaustive; every branch, engine PVs pasted at key tabiyas, minimal prose. Purpose: the coach can OPEN it at any position and see everything the engines said. Sometimes 200+ nodes deep.
- **Summary file** — mainline + top branches only, dense prose at every decision, NAGs at endpoints, novelty and move-order tricks called out explicitly. Purpose: **the player can INTERNALIZE it in 15 minutes before the round.**

You may or may not have a "big" version to work from — sometimes prep just is what it is. Don't reference a source file or add a `SourceFile` tag; the summary stands alone. It's defined by its SHAPE, not by having a companion.

## The shape

A summary has five properties. Miss any of them and it's not a summary — it's a lightweight big-file.

**1. Mainline + top branches only, not comprehensive.** If the big-file version covers all 13 replies at move 13, the summary covers the mainline plus the 2-3 the opponent actually plays. Sidelines that don't change the mainline decision get cut. The reader trusts you did the work; the summary is the *distillation*.

**2. Dense prose at every meaningful decision point.** Every branching node should have a comment. Silence in a summary is a failure — if you left a node uncommented, either you had nothing to say (drop the node) or you had something to say (write it). The coach's voice is judgment, not exhaustive analysis.

**3. NAGs at variation endpoints.** Every terminal leaf gets a positional NAG signalling how the line LANDS: `$14` ⩲ (slight white edge), `$16` ± (clear white edge), `$10` = (equal), `$15`/`$17` (same for Black), `$18`/`$19` (winning). The reader plays through the moves, hits the leaf, sees the assessment. Do NOT put `$14` on every intermediate move — that turns the movetext into a wall of ⩲ symbols and the endpoint no longer stands out. See `pgn-authoring` for the full rule.

**4. Novelties and move-order tricks called out explicitly.** If there's a `$146` (novelty) in the file, it gets `$5` + a prose sentence naming the IDEA (not the analysis — the idea): `{novelty, for now threatening Qxb7 and getting out of ...Nb4 stuff.}`. If a move order matters (choosing a-then-b over b-then-a preempts a defensive resource), name that: `{This move order is critical — 12.Nc3 first avoids ...Bg4 pinning ideas after 12.Nbd2.}`

**5. Arrows and highlights as thinking-aids.** `[%csl Re4]` (red highlight on e4) to mark the target square. `[%cal Gh4g2,Gc1f4]` (green arrows) to mark a planning sequence. These load into the reader's spatial memory in a way SANs don't. Use them at critical positions — the tabiya where the plan crystallizes, the mating attack, the endgame breakthrough. Don't decorate: one arrow that shows the plan beats three that show every idea you considered.

## The coach's voice (what to write in comments)

Summary prose is decisions in a coach's voice. Not analysis. Not restating moves. Judgment + plan + character.

Real examples from a Peter Heine / jvanf summary (Petroff 6.Bd3 Bd6, 2021 WC prep):

- `{In general this seems to be leading to positions which are just more pleasant for White. Black has only two reasonable moves and both will be met by Qb3.}` — Frames the whole file's thesis in two sentences.
- `{Stopping Nb4. Black has several attempts, but White play remains simple. Be3-Rac1 and then we see.}` — Names the concrete threat + the plan.
- `{This seems to be Blacks best bet at forcing this to a draw.}` — Signals objective assessment.
- `{Kinda forcing up to here, now comes the new idea.}` — Marks transition to novelty.
- `{quite nasty for black.}` — Endpoint verdict.
- `{Black has run out of tricks and has to either weaken with f5 or give us a small advantage.}` — Squeezing the reader into the right mental model of the position.

Patterns to notice:
- **Short.** Most comments are one sentence. Two if the plan needs naming after the assessment.
- **Concrete.** "Be3-Rac1 and then we see" beats "White continues developing" every time.
- **Judgmental.** "This seems to be Blacks best bet" tells the reader something they can't derive from the moves.
- **Framing.** The FIRST comment in the file often frames the whole argument ("positions which are just more pleasant for White"). The last comment on each variation is the verdict ("quite nasty for black", "lasting iniative").

## What NOT to do

- **Don't paste engine PVs.** No `{Stockfish 050821: 10.Bxf5 Nxf5 11.Nf1 ...}` 30-move-long variations. That's the big file's job. If the summary NEEDS a 15-move engine line to justify a claim, the claim probably belongs in the big file.
- **Don't cover every alternative.** If your `add_line` warning fires because the DB shows 4 tries and you covered only 2 — that's fine here IF you named which 2 you dropped and why. But typically the summary picks the ~3 the opponent actually plays.
- **Don't leave nodes uncommented.** A node with no comment in a summary is a node that shouldn't exist. Either it's important enough to comment or it's noise.
- **Don't restate what moves show.** `{After 10.Bxf5 Black plays Nxf5}` — the reader can see that. Say WHY: `{Bxf5 forces the trade; recapturing with the knight rather than the pawn keeps c6 flexible for later ...Nc7.}`
- **Don't spam NAGs.** Positional NAGs (`$10`-`$19`) at endpoints ONLY. Move-quality NAGs (`$1` ! / `$2` ? / `$5` !? / `$6` ?! / `$146` novelty) at any depth, but sparingly — one per branch on average.

## The "does this pass" test

Before saving the summary, ask: **could Magnus (or your user) play through this in 15 minutes and come out knowing what to do at the board?**

Three concrete checks:
1. **Frame the file** — does the first comment explain what this repertoire is trying to achieve?
2. **Every decision has a voice** — walk the mainline. At each branching node, is there a comment explaining the choice or the character?
3. **Every leaf has a verdict** — walk to every terminal position. Is there a NAG (or prose) telling the reader how the line ends?

If yes to all three, ship it. If no, either add what's missing or CUT the branch until the file is what a summary should be — shorter and denser, not longer.

## Build order for a summary file

The same tools as any prep file, but different order and different density.

1. `create_prep_file(collection_id, name)` — name it with "Summary" in the Event tag (`"Modern Defence — Tiger ...a6/...b5 (Summary)"`) so the reader recognizes the artifact.
2. `set_comment(root, "framing")` — the file's thesis, first thing.
3. Build the mainline top-down with `apply_mutations` batches — each move gets its comment in the same batch that adds it. Don't come back to write comments later; the density is the point.
4. At each branching decision, add ONLY the branches the opponent might actually play. Skip the ones you'd cover in a big file.
5. At every leaf, set an endpoint NAG.
6. `set_annotations` on the 3-5 most important positions — the tabiya, the novelty, the critical junction. Not every position.

Total build: dozens of nodes, not hundreds. If your summary is 200+ nodes, it's probably a big file wearing a summary hat — cut ruthlessly.
