# Prep strategy for chess.ceo agents

Opening prep is not a monologue with the position-stats and player-prep endpoints as sources of truth. It's a two-player adversarial game with **symmetric information** — both sides can see the same history, both know what the other has played, both have their own weaknesses and their own idea of the other's weaknesses. Everything below flows from that.

## Numbers are inputs, not verdicts

The move statistics endpoints return win %, game counts, and (in the big DB) hotness. Treat every one of these as a *weight*, not a *rule*.

- **Sample size scales trust.** 3 games at 66% is noise; 300 at 55% is signal. A great score is nice — with volume. When the opponent has only 2-4 games in a variation, the "opponent-specific" score is basically the general-DB score anyway.
- **Score doesn't automatically indicate a level gap.** A 60% variation isn't necessarily "stronger players crushing weaker ones." Look at the per-move `avgWhite` / `avgBlack` fields (returned on every move statistic) before drawing conclusions about who is playing whom.
- **Don't recommend the higher-percentage move just because it's higher.** If 1.b3 scores 60% and 1.d4 scores 50% against a given opponent, that is *not* on its own a case for playing 1.b3 — style, prep depth, transposition risk, and the practical questions below all matter more.

## Prep is symmetric — both sides know the same things

The single biggest LLM error in prep is treating it like writing a book: "here's what you should play against this opponent's weakness." A real chess opponent:

- Knows the same weakness the LLM found (or worse, has already patched it since the game where it showed).
- Knows the user's own repertoire the same way the LLM does — by looking at the user's games.
- Will prepare against the user just as hard as the LLM is preparing against them.

Every recommendation should be filtered through: "does this survive the fact that the opponent could easily anticipate it?"

## Recency > career

The opponent's last 12-24 months matter far more than a 10-year career average. Repertoires evolve — a lifelong Najdorf player might have quietly become a Petroff player last year, and their old career stats will lie to you if you skim.

**Related product note (2026-07-23):** the `get_player_preparation` endpoint (compact / LLM view) deliberately strips the per-move `hotness` field. At the individual-player level, "hotness" is trailing noise — the opponent's opening trend is already captured in game dates. Hotness stays on the general-DB endpoint, where it's genuinely useful: it means fashion (what the whole top field is playing this month).

## Prep is a tree, not a line

The opponent will deviate somewhere in the first 10 moves — earlier if you surprise them. A single 20-move line with no answer at move 4 is much worse than a shallow tree with concrete plans at each real branching point.

- Cover the 2 most likely replies at each branch, not just the modal one.
- Depth is a resource — spend it where it matters (main lines, opponent's actual repertoire).
- **Caveat:** some opponents just play their repertoire no matter what. Read the opponent's rigidity from their game history — look at move-2 variance across their last 30 games. Narrow variance = fixed repertoire; wide variance = they adapt.

## Style clash matters (but don't overdo it)

Steer toward positions where the *user* is better than the opponent. That gap is usually bigger than any objective evaluation edge you can find.

- Positional user vs sharp tactician: keep it quiet, avoid the opponent's calculation edge.
- Sharp user vs positional opponent: fight for complications.
- High draw rate opponent: unbalance early (KID, Benoni, gambit).
- Endgame-strong opponent: keep queens on, keep complications live.

Don't ride this signal so hard that you recommend an objectively bad line just because "it fits the user's style." Style is a weight, not an override.

## Novelty burns

Deep prep is a weapon you spend, not one you own. A prepared novelty against a strong opponent gets analyzed after the game and never fools them again — even against different opponents in that circle, since strong players share prep. Save deepest prep for the games that matter most (championship match, decisive round, tiebreak), not "just in case."

## Move-order tricks aren't visible in raw win rates

The `trs` (transpositions) field on move statistics tells you how much a given position folds into related structures. Move-order tricks are legitimate prep and position stats alone can't recommend them.

- Considering 1.Nf3 or 1.c4 as a duck around 1.d4? First check the opponent's repertoire *against 1.d4*. If they play the King's Indian, most 1.Nf3/1.c4 lines transpose anyway — the trick doesn't help.
- Move orders are useful when the opponent plays something that specifically depends on the move order — e.g. a Nimzo player who never gets to play the Nimzo because you go 1.Nf3-2.g3.

## Revealed weaknesses need context

If the opponent lost 3 rapid games in a specific Bg5 Najdorf line last month, that's actionable — but not for all opponents equally:

- **Weak / casual opponent:** they won't have patched it. Safe to exploit.
- **Strong / improving opponent:** they will have patched *that specific line* — but the underlying *type* of weakness (e.g. bad in Catalan pawn structures) still holds, even when the surface leak is gone. Look for structural weaknesses that survive one bugfix.
- **Symmetric information reminder:** they know you know. Assume the strong opponent has already prepared the counter. Plan for that layer too.

## Surprise is a scalpel, not a hammer

Meta-signal matters. Big changes in the user's repertoire are transparent to strong opponents — they'll see "opponent has played 1.e4 for 5 years, is playing 1.d4 this game" and immediately know you prepared something specific.

- **Wrong:** tell a 100% 1.e4 player to switch to 1.d4 as a "surprise." That signals prep, doesn't hide the intent, and puts the user in an opening they don't know as well as the opponent does.
- **Right:** stay inside the user's normal repertoire, pick a rare secondary line. Classic example: a 1.e4 player who always plays 6.Bg5 vs the Najdorf switching to 6.Bc4 for one game. The opponent recognizes the opening; they don't have prep on this specific line; the user's meta-signature ("I play 1.e4 vs Najdorf") stays intact.
- Same logic for candidate move choice: the opponent's expectation of *what the user plays* is itself a variable to be manipulated.

## How to combine these

None of these are rules; they're weights. In one game against a specific opponent one factor dominates (they clearly hate Catalan structures); in another it's a different one (they're rigid and just play their repertoire, so tree-depth matters more than surprise). Reason through them explicitly when recommending, and cite the concrete numbers (game counts, dates, win rates) so the user can trust or overrule.

Above all: **assume the opponent is doing the same reasoning**, and don't be lulled by a big number.
