# Engine usage guide

When you call `cloud_analyse`, chess.ceo runs Stockfish and Lc0 in parallel on the user's rented combo instance and returns both engines' final read. This doc explains what each engine is good for and how to interpret the numbers you get back — the difference between "this line is a draw" and "this line is easy to draw" is central to real prep and both engines are needed.

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

## Lc0 contempt

Contempt is an Lc0 option that skews its evaluation and move choice toward one side. Passing `contempt` to `cloud_analyse` sets it on the Lc0 leg only; Stockfish always analyzes objectively.

**Range:** -100 to +100 accepted; **practical range: -20 to +20**. Beyond ±20 Lc0 starts picking objectively bad moves that only look good under an extreme bias.

- **Positive contempt** (e.g. `+15`): Lc0 assumes it's playing *from White's side* against equal or slightly weaker opposition. It picks more ambitious, complicated moves and avoids quick simplifications. The eval reads higher than pure objective. Concrete effect: with White, Lc0 will less often steer into the Exchange Slav or a symmetrical Berlin.
- **Negative contempt** (e.g. `-15`): Same but from Black's side. Lc0 will play sharper, more provocative lines with Black — more likely to pick a Sveshnikov over a Petroff, or a Grünfeld over a Slav.
- **Zero** (default): pure objective Lc0.

The eval Lc0 returns when contempt is set is **not** the objective eval — it's Lc0's assessment under the contempt bias. If you also want the objective read, look at the Stockfish leg of the same response.

### When to set contempt

- **Finding new ideas** — set contempt in the direction you're preparing to see moves the objective engine wouldn't consider "safe enough." Lines Lc0 rejects at contempt=0 but likes at contempt=±15 are candidate surprises.
- **Building a solid repertoire** — small positive contempt for your color if the user wants to take positions seriously (real, competitive games) without gambling on unclear complications.
- **Playing for a win with the "worse" side** — negative contempt if the user needs to avoid drawing lines with Black in a must-win situation.
- **Never with zero direction** — always know *why* you're skewing before you set contempt. It's a specific tool for a specific question, not a default knob.

## Worked example

User is preparing Black against a 2600 opponent who plays 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 6.Be3 e5. You want to know if 7.Nb3 or 7.Nf3 is more testing.

Two calls:
1. `cloud_analyse(fen=<position after 6...e5>, multipv=2)` — get both engines' top choices with movetime=2000.
2. If Stockfish scores them equal but Lc0 prefers one by 0.10-0.20, that's your practical answer. The user will find that line harder to face.

If the user is specifically preparing to *play* the black side in a must-win, add `contempt=-15` on a follow-up call to see which lines Lc0 finds most fighting for Black. Compare against Stockfish's objective read to make sure the fighting choice isn't just losing.

## What NOT to do

- **Don't quote Lc0's contempt-biased eval as objective.** If you tell the user "Lc0 gives Black +0.30 here" without disclosing you set contempt=-15, that's misleading.
- **Don't run cloud analysis just for casual questions.** `cloud_analyse` costs the user real money per second. If the question is "is 1.e4 or 1.d4 better?", the free `analyse` (single Stockfish, 2s) or `get_position_stats` (11.7M-game database) is enough.
- **Don't ignore the disagreement.** When Stockfish and Lc0 diverge sharply, that's exactly when you should explain *why* to the user — not paper over it.
