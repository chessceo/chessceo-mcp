# Engine usage guide

When you call `cloud_analyse`, chess.ceo runs Stockfish and Lc0 in parallel on the user's rented combo instance and returns both engines' final read. This doc explains what each engine is good for and how to interpret the numbers you get back — the difference between "this line is a draw" and "this line is easy to draw" is central to real prep and both engines are needed.

## Grounding: don't invent, run the engine

**Every claim you make about a position must trace back to actual engine output from this session.** Not from a book you were trained on, not from generic chess principles, not from a plausible-sounding pattern. If you don't have a Stockfish or Lc0 line for the exact FEN you're discussing, run one. Compute is cheap — `cloud_analyse` at ~2s each is fine to call 5-10 times while walking a tree; you can burn 20-30 seconds of billable time and it's still cents.

### The node-id + quote_engine_eval protocol

**When you're inside a prep file, call `cloud_analyse` with `file_id`+`node_id` — never with a hand-typed FEN.** The server derives the FEN from the tree node and, critically, **auto-stores the resulting eval on that node's `ceoEval`**. This is what makes engine attribution trustworthy end-to-end:

1. `cloud_analyse({ id, node_id })` — runs analysis on the node's exact position, stores `{sf, lc0, nag}` on the node.
2. Later, before you write "engines say X on this position" in a comment, call `quote_engine_eval({ id, node_id })` — it returns the stored eval or `null`.
3. If `quote_engine_eval` returns `null`, you have no measurement to cite. **Do NOT infer an eval for a node from siblings, from children, or from a "position that looks similar."** Either analyse the node (`cloud_analyse`) or omit the number from your prose entirely.

Concrete failure this rule blocks: the LLM says *"9...Bb7: both engines 0.00"* after only calling `cloud_analyse` on the child positions (post-1.d4, post-castling). Both continuations really returned 0.00, but the Bb7 node was never analysed, and the claim reads to the user as a measurement. With this protocol, `quote_engine_eval(node_id=Bb7)` would return null and the LLM would either analyse it or reword to *"both continuations run to 0.00, so this position looks balanced"* (soft inference, honestly labelled).

**Transposition propagation.** `cloud_analyse({file_id, node_id})` also stamps the resulting `ceoEval` on every OTHER node in the same file that reaches the same position by a different move order (3-field FEN match: pieces + side-to-move + castling). The response includes `also_stored_on: [id, id]` when this happens, and a follow-up `quote_engine_eval` on any of those twin nodes returns the same measurement — no second analysis needed. `auto_evaluate` also dedupes candidates by the same key and returns `skipped_transpositions` so you can see how much engine time it saved. See `list_transpositions` / `list_nodes({filter: "transpositions"})` for auditing where duplication exists before you start.

**Concrete failure modes to avoid:**

- Inventing an evaluation. If you say "this is +0.4 for White", that number must come from an engine call. Not a guess, not a vibe.
- Naming a "best move" you never saw in engine output. If Stockfish's response listed `[Nf3, Nc3, d4]` and the user asks about `e4`, don't claim `e4` is anywhere in the ranking without checking.
- Fabricating a variation. "1.e4 e5 2.Nf3 Nc6 3.Bb5 gives White a big edge" is not a valid claim unless you actually ran the engine on that position. Walking the tree with generic pattern-matching is hallucination, however well-formed the moves look.
- Falling back to trained-in book judgments ("the Ruy Lopez is objectively best") when the user is asking about a specific position with specific stats.
- Dressing measured data up in generic chess prose that reads like analysis. If you cite that Lc0 shows +0.15, don't extend that into three sentences of positional narration you didn't verify.

**When the engine disagrees with your intuition**, trust the engine first and *then* try to explain the disagreement — look at the PV, look at both engines' scores, don't wave off the tool because a general principle "should" apply.

**When you don't have data**, don't fill the gap with prose. Either run the tool or say "I don't have engine data for that position — should I check?" The user cannot tell which parts of your output came from a tool call and which parts came from pattern-matching; the whole point of running an engine is that its judgment beats yours here, so cite it.

## Two engines, two truths

### Stockfish — objective source of truth

Stockfish is calculation. Its evaluation is objective: *"is this position a draw, a win, or a loss with best play from both sides?"*

Trust Stockfish for questions like:
- Does this defensive line actually hold?
- Is there a concrete tactic here that the human would find?
- Is this endgame drawn?
- Is White's initiative worth a piece?

**Watch out for:** Stockfish gives 0.00 to a *lot* of positions in the opening and early middlegame. 0.00 does not mean "trivial draw" — it means "objectively drawn with best play." Practically, one side can still be much harder to defend for a human. Every top-level classical game past move 8 typically shows 0.00 in Stockfish's eyes, yet real players win and lose those games all the time.

### Lc0 — practical eval, human-like feel

Lc0 is a neural net trained on self-play games. Its evaluation is closer to how a strong human sees the position — it weighs long-term positional factors, piece activity, space, and initiative in a way Stockfish's fixed search often can't reach.

Where Stockfish says 0.00, Lc0 might say +0.15 — meaning *"White still has a small but real practical edge over the board."* That's exactly the signal you want for opening prep, where 95% of positions are within the objective drawing margin and the real question is *"which side is easier to play?"*

Trust Lc0 for:
- Which side has practical chances in an opening structure
- Which pawn structure will be easier to handle
- Whether a slow positional idea has long-term venom
- Ranking candidate moves when Stockfish sees several as equal

**Watch out for:** Lc0 can miss very deep tactical shots — its search is guided by intuition, not depth. If Lc0 loves a line but Stockfish doesn't, look for a concrete tactical justification (or a refutation).

### Rule of thumb

- Objective truth ("does this hold?", "is this a mate?") → **trust Stockfish**
- Practical prep ("which side is easier?", "which candidate is best?") → **trust Lc0**
- Both agree → high confidence, ship the recommendation
- They disagree → look at both scores together and reason about *why*:
  - Stockfish sharply higher: probably a tactic Lc0 didn't calculate
  - Lc0 higher: probably a long-term positional factor beyond Stockfish's horizon
  - Never dismiss either engine — the disagreement itself is the signal

## 0.00 is not "dead draw"

The single most common misread of an engine number. **0.00 means "objectively balanced with optimal play from both sides".** It says nothing about how often the position actually draws over the board — a sharp middlegame with imbalances and only-moves can sit at 0.00 for 40 plies and be a lively fighting game.

An eval quantifies WHO STANDS BETTER, not HOW LIKELY A DRAW IS. The two questions are independent.

- **A wrong reasoning pattern** (documented failure): the LLM sees `SF 0.00, depth 58, 6.6B nodes` on a Bg5 sideline, concludes "actually a dead draw", and marks the line `?!` as a dead end. Wrong. All that eval says is neither side is objectively better with optimal play — the practical drawing chance is a separate question the SF number doesn't answer.

Signals that actually correlate with high drawing chance:

- **Forced repetition visible in the PV** (`Nf3 Nf6 Ng1 Ng8 …`) — that's a draw, not the eval.
- **Reduced material + 0.00** — opposite-coloured bishops, queen + rook endgames with balanced pawns, king-and-pawn structures with no breakthrough. The material context makes the draw likely, not the eval.
- **Symmetrical structures with no imbalances and no plan for either side** — engine says 0.00, humans agree by move 25.

If you actually want to estimate PRACTICAL drawing chance, ask the tools that answer that question:

- **`predict_human_move.wdlWhitePov`** — game-outcome prediction from the neural net, rating-conditioned. The `draw` component IS the answer to "how often does this position draw at this level".
- **Lc0's practical eval** — often diverges from SF at 0.00 to say "still slightly better for White in a real game". That divergence is where the practical winning chance hides.

**Never conflate the objective eval with the practical outcome.** A 0.00 middlegame with a piece imbalance, opposite-side attacks, or a rating gap is a fighting game; the number just told you nobody has a forced win.

## Lc0 contempt

Contempt is an Lc0 option that skews its evaluation and move choice toward one side. Passing `contempt` to `cloud_analyse` sets it on the Lc0 leg only; Stockfish always analyzes objectively.

**Scale:** signed 0-100 strength — the same value the user's web UI shows on its ContemptStrength slider. The server multiplies by 8 to produce Lc0's internal centipawn bias, so `contempt=25` sends 200 cp, `contempt=50` sends 400 cp, `contempt=100` sends 800 cp. Positive favours White, negative favours Black, zero is objective.

**Practical magnitudes:**
- `±10-20` — a light nudge. Small preference shift, mostly for tie-breaking between candidates Lc0 already sees as near-equal.
- `±30-60` — real fighting play. Lc0 avoids simplifications, prefers keeping tension, favours the more ambitious side of a choice.
- `±80-100` — maximum steer. Use when the user needs Lc0 to surface *only* fighting ideas for a must-win, at the cost of ignoring objectively safer choices.
- **Zero** (default): pure objective Lc0.

- **Positive contempt** (e.g. `+30`): Lc0 assumes it's playing *from White's side* against equal or slightly weaker opposition. It picks more ambitious, complicated moves and avoids quick simplifications. The eval reads higher than pure objective. Concrete effect: with White, Lc0 will less often steer into the Exchange Slav or a symmetrical Berlin.
- **Negative contempt** (e.g. `-30`): Same but from Black's side. Lc0 will play sharper, more provocative lines with Black — more likely to pick a Sveshnikov over a Petroff, or a Grünfeld over a Slav.

The eval Lc0 returns when contempt is set is **not** the objective eval — it's Lc0's assessment under the contempt bias. If you also want the objective read, look at the Stockfish leg of the same response.

### When to set contempt

- **Finding new ideas** — set contempt in the direction you're preparing to see moves the objective engine wouldn't consider "safe enough." Lines Lc0 rejects at contempt=0 but likes at contempt=±30 are candidate surprises.
- **Building a solid repertoire** — small positive contempt (`+10` to `+20`) for your color if the user wants to take positions seriously (real, competitive games) without gambling on unclear complications.
- **Playing for a win with the "worse" side** — negative contempt (`-30` to `-60`) if the user needs to avoid drawing lines with Black in a must-win situation.
- **Never with zero direction** — always know *why* you're skewing before you set contempt. It's a specific tool for a specific question, not a default knob.

## Tricks worth knowing

### Flip side-to-move to see threats

If it's Black to move and you want to know what threats *White* has (i.e. "if Black passes, what does White do?"), take the FEN and flip the side-to-move field from `b` to `w` (or vice versa), then run analysis. This is the engine equivalent of the "null move" idea humans use to check for prophylaxis.

- Real position: `... b KQkq -` — analyse says +0.2 for Black
- Flipped:     `... w KQkq -` — analyse says +1.4 for White

The gap (1.4 - 0.2 = 1.2) is roughly the value of the tempo Black has to spend defending. If it's huge, Black is under real pressure even if the current eval looks calm. If it's tiny, White has no immediate threats and Black can improve at leisure.

**Gotcha:** flipping side-to-move invalidates the en passant target field (if the last move was a two-square pawn push, the ep square is now stale). Also, both sides are counted as still having whichever castling rights are in the FEN — don't do this in the middle of a castling sequence. For opening / middlegame threat-checking it's a very useful idiom.

## Why the position is what it is: `describe_position.engineEvalTerms`

`describe_position` returns Stockfish's classical eval decomposed into 13 named terms (Material, Imbalance, Pawns, Knights, Bishops, Rooks, Queens, Mobility, King safety, Threats, Passed, Space, Winnable) alongside the chess-primitive observations. Each term carries white / black / total values in middlegame + endgame. This is how you answer "WHY is Black better here" beyond pointing at `-0.35`.

Primary pattern — **the delta**. Call `describe_position` on the position BEFORE and AFTER a candidate move, compare `engineEvalTerms`; the term with the biggest shift tells you what the move CHANGED. Kim et al. NAACL 2025 showed feeding these named deltas to an LLM roughly doubles chess-commentary correctness vs a bare eval number. Example:

```
before 12.Nd5:  king_safety = +0.10, mobility = -0.05, threats = 0.00
after  12.Nd5:  king_safety = +0.40, mobility = +0.30, threats = +0.55
→ the delta is dominated by threats + king safety
→ commentary: "12.Nd5 lands an outpost that both eyes the kingside (threats) and improves piece coordination (mobility)"
```

Absolute values are useful on their own too — a large "King safety" term flags an exposed king regardless of what caused it.

Complements `cloud_analyse` (best move + PV): different questions, two angles on the same position.

## Deep Stockfish thinks: `deep_analyse`

`cloud_analyse` runs both engines with a movetime cap of 10 s — deliberately fast because most opening-tree questions are answered in 2–3 s. For **one specific critical position** where you want depth 35+ instead of the usual depth 22, use `deep_analyse`:

- SF-only (Lc0 saturates in a handful of seconds — no benefit past ~5 s of movetime).
- Movetime up to 5 min.
- Async: returns a `job_id` immediately, poll `deep_analyse_status(job_id)`, cancel with `deep_analyse_cancel(job_id)` if you decide partial depth is enough.
- **Holds only the Stockfish slot on the combo.** Lc0 remains callable for other positions via `cloud_analyse({ engines: ["lc0"], … })` while the deep think runs. Use that during the wait — walk other branches, sanity-check candidates.

Typical movetimes:
- `30_000 – 60_000` (30–60 s) — careful check on a candidate move
- `120_000 – 300_000` (2–5 min) — "find the truth" on a novelty, tactical shot, or difficult endgame

Only use it when you actually need the depth. Regular `cloud_analyse` handles the ~5–10 branches of a typical prep walk perfectly well.

## Per-engine `multipv` defaults

`cloud_analyse` defaults to different candidate-line counts per engine because the two engines behave differently:

- **Stockfish: `stockfish_multipv=2`** — SF gets weaker as multipv grows. Each extra PV steals search bandwidth from the top choice, so the "objective best move" leg is at its strongest with a tight list. Raise only when you specifically need SF's read on a wide range of candidates (e.g. sanity-checking an unusual sideline).
- **Lc0: `lc0_multipv=8`** — Lc0 doesn't degrade the same way with multipv. Use it wide by default: 8 candidates give the LLM a real slate of practical ideas to inspect ("what does Lc0 think of the fun moves here?"). Lower it only when you don't need that breadth.

Mental model:
- **Stockfish = the checker.** "Is this line objectively good? What's actually best?" Narrow, deep, one answer.
- **Lc0 = the explorer.** "What's practically interesting? What alternatives are worth a look?" Wide, breadth-first, several answers.

Override the defaults with `stockfish_multipv` / `lc0_multipv` when a specific position warrants a different shape.

## Splitting engines on `cloud_analyse`

`cloud_analyse` accepts an `engines` list to run only one leg:

- `engines: ["lc0"]` — Lc0 only, useful while a `deep_analyse` is holding the Stockfish slot.
- `engines: ["stockfish"]` — SF only, when only the objective read matters and you want to skip the Lc0 latency.
- Default (omitted) — both engines. This is what you want for real prep decisions.

The skipped engine's field is omitted from the response (not present as an empty object).

## Worked example

User is preparing Black against a 2600 opponent who plays 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 6.Be3 e5. You want to know if 7.Nb3 or 7.Nf3 is more testing.

Two calls:
1. `cloud_analyse(fen=<position after 6...e5>, multipv=2)` — get both engines' top choices with movetime=2000.
2. If Stockfish scores them equal but Lc0 prefers one by 0.10-0.20, that's your practical answer. The user will find that line harder to face.

If the user is specifically preparing to *play* the black side in a must-win, add `contempt=-30` (or up to `-60` for a harder steer) on a follow-up call to see which lines Lc0 finds most fighting for Black. Compare against Stockfish's objective read to make sure the fighting choice isn't just losing.

## The PV is not a line to paste

`cloud_analyse` caps each PV at 6 plies (3 full moves) by default and marks longer ones `pv_truncated: true`. This is deliberate — the tail of a PV is where the engine's confidence collapses (SF at depth 24 has resolved the first few plies solidly and hedged everything after), and pasting long PVs into `add_line` as prep is the biggest documented anti-pattern of this whole system.

**A PV tells you what the engine sees, not what will be played.** A 15-ply PV pasted as a variation is one line of engine output through positions where the opponent had 2-3 real alternatives at almost every ply. That's not prep — that's the engine's preferred game, and no opponent plays the engine's preferred game.

**To see further into a line, walk the tree.** Take the position at the tail of your truncated PV, run a fresh `cloud_analyse` on it. That call gives you the multipv candidate set at THAT position — the opponent's actual options — which is what you need to decide whether to branch. Don't raise `pv_max_plies` unless you're verifying a forcing sequence (a mate, an obligated recapture chain).

Practical: raise `lc0_multipv` (default 8) to see the candidate spread on the current position, NOT to see further down one PV. If Lc0 shows moves 1-3 within 0.15 of each other, that's a branching point — three responses need coverage, not one PV.

## What NOT to do

- **Don't paste PVs as `add_line` variations.** See the section above and `pgn-authoring.md`'s "Prep is a TREE, not a line" section. This is not a stylistic preference — the tool warns you starting at 9 plies and warns hard at 14+, and the truncated `pv_truncated: true` marker is telling you the engine itself doesn't stand behind the tail.
- **Don't quote Lc0's contempt-biased eval as objective.** If you tell the user "Lc0 gives Black +0.30 here" without disclosing you set contempt=-30, that's misleading.
- **Don't run cloud analysis just for casual questions.** `cloud_analyse` costs the user real money per second. If the question is "is 1.e4 or 1.d4 better?", the free `analyse` (single Stockfish, 2s) or `get_position_stats` (11.7M-game database) is enough.
- **Don't ignore the disagreement.** When Stockfish and Lc0 diverge sharply, that's exactly when you should explain *why* to the user — not paper over it.
