# Prep strategy for chess.ceo agents

Opening prep is not a monologue with the position-stats and player-prep endpoints as sources of truth. It's a two-player adversarial game with **symmetric information** — both sides can see the same history, both know what the other has played, both have their own weaknesses and their own idea of the other's weaknesses. Everything below flows from that.

## Grounding: cite tools, don't fill gaps with chess prose

Every recommendation you make must trace back to an actual tool call in this session — engine output from `cloud_analyse` for evaluations and lines, `prepare_opponent` + `get_prep_position` for opponent statistics, `get_position_stats` for the general database, `get_player_profile` / `get_head_to_head` for style and history. **Compute is cheap.** When you don't have the data to justify a claim, run the tool — do not paper over the gap with generic chess wisdom you didn't verify.

**Concrete failure modes to catch yourself doing:**

- "This is a good line because Black gets the two bishops." → Did Lc0 or Stockfish score it that way? If not, drop the claim.
- "Your opponent hates isolated queen pawn positions." → Did you actually look at their IQP games via a `prepare_opponent` session? Or is this a training-data pattern?
- "The Petroff is a solid choice here." → Did you check the opponent's score as White vs the Petroff, or against Black openings in general? If not, drop it.
- "Aim for a Catalan setup, they historically struggle there." → Point at concrete games where they lost in Catalan structures. If you can't, don't say it.
- Inventing move sequences that "look like typical prep" without walking the actual tree via `get_prep_position` / `prep_snapshot`.
- Asserting an opponent's style ("sharp tactician", "endgame grinder") without pointing at their profile data or specific games.

The failure mode is *authoritative-sounding recipe = 30% real tool output + 70% chess-book filler*. The user cannot tell which is which; from their side it all looks like analysis. That's worse than saying "I don't have data on this yet — should I run X?"

**Do this instead:** cite the specific numbers ("opponent scores 32% as White vs the Sveshnikov over 47 games, 2023-2025"), the tool that produced them ("via a `prepare_opponent` session filtered to classical since 2024"), and reason from there. If the reasoning wants to extend beyond what the data supports, either run more tools or flag it as your read, not the data's.

## Numbers are inputs, not verdicts

The move statistics endpoints return win %, game counts, and (in the big DB) a `fashionScore` (0–100, how in-fashion the move is right now at the top level — recent + played often). Treat every one of these as a *weight*, not a *rule*.

- **Sample size scales trust.** 3 games at 66% is noise; 300 at 55% is signal. A great score is nice — with volume. When the opponent has only 2-4 games in a variation, the "opponent-specific" score is basically the general-DB score anyway.
- **Score doesn't automatically indicate a level gap.** A 60% variation isn't necessarily "stronger players crushing weaker ones." Look at the per-move `avgWhite` / `avgBlack` fields (returned on every move statistic) before drawing conclusions about who is playing whom.
- **Don't recommend the higher-percentage move just because it's higher.** If 1.b3 scores 60% and 1.d4 scores 50% against a given opponent, that is *not* on its own a case for playing 1.b3 — style, prep depth, transposition risk, and the practical questions below all matter more.
- **Count is popular, avgRating is critical.** When you're choosing which branches deserve prep depth, the highest-avgRating move often matters more than the highest-count one. Top players play the moves they know work, sometimes ignoring the herd. Example: 5...Bb4 has 180 games at avg 2350; 5...d5 has 7 games at avg 2526. d5 is the sharper test even though Bb4 is "main". Skim the rating column before the count column when picking branches to cover.

## Which DB source: signal vs population

Two shards on `get_position_stats`, answering different questions:

- **`gm-classical`** (default): pre-aggregated GM classical games (both players ~2500+, real thinking time). Every move is signal, no noise. Sample sizes are smaller. Answers: *what do good players actually play here, and how well does each option score at that level?*
- **`main`**: the full 11.7M-game database. Wider coverage, cheaper positions included (blitz, weak opponents, blunder-fests). Noisier. Answers: *has this position/move been reached at all, and by whom?*

They're not either-or. Reasonable to hit both on the same position for different questions:

- **What GMs play here** → `gm-classical`. Even a small count (5-10 games at avgRating 2600) is often the honest answer for a specific tabiya — that's just how many GMs have gone there. Don't dismiss small numbers if the rating context supports them.
- **Does anyone play this at all** → `main`. Especially useful for a move you're considering that hasn't appeared in `gm-classical`. Zero in the GM DB doesn't automatically mean bad — it might just mean unfashionable. Check `main`: if it has some volume at reasonable avgRating (~2200+), the move has real support even without top-level play; if it's only 1400-rated games or bots, it doesn't.
- **Sanity-checking a candidate** → both. If a move you're considering shows 3 games in `gm-classical` but 800 in `main` at avgRating 2100, that's a coherent picture (unfashionable at the very top but played by strong players); if `main` shows the same 3 games and nothing else, the move is genuinely rare and you're pioneering.

When you do read a `main` result, always eyeball `avgRating` per move before quoting the win%. A 60% score across 200 games at avgRating 1400 is not a recommendation — it's a trap that catches beginners. The same 60% across 200 games at avgRating 2400 is a real finding.

Cross-reference tip: if `main` shows a specific move dominating that `gm-classical` doesn't touch, look at *who* — correspondence engines, blitz-only players, and bot accounts skew the `main` totals. A move with 5000 games in `main` at avgRating 1900 and zero in `gm-classical` is probably not something to recommend as GM prep.

## Which prep source: match data density to what you're preparing

`prepare_opponent` accepts fide, chesscom, lichess sources — each with per-source colour, date-range, time-control filters. Which sources to combine depends on how much data the opponent actually has and what specific question you're answering:

- **Well-known player, well-known question** ("what does Firouzja play against 1.e4?"): FIDE, `time_control: "classical"`, `start_month` = 12–24 months ago. Cleanest signal, big enough sample. Don't dilute with online.
- **Well-known player, sideline question** ("what would he play in this obscure 20-ply position?"): FIDE all-time-controls first — classical is unlikely to have games in a rare position. If still nothing, add rapid; add online only if you must.
- **Junior / sub-2400 / comeback player**: FIDE classical alone might give you 5 games. Add FIDE rapid + chesscom + lichess (all filtered to the last 12 months). Signal density improves, but recognize online games are a mixed signal — see next section.
- **Multiple accounts / handles**: pass them all as sources in one call — `[{type:"fide",fide_id:X}, {type:"chesscom",username:"..."}, {type:"lichess",username:"..."}]`. Same session, more games, no rebuild, all combined into one filtered corpus.

The trade-off is always the same: signal quality vs data density. When density is high, prefer quality; when density is low, take what you can get and lower your confidence in the read explicitly ("only 12 games at this branch — the 66% is noisier than the 55% we saw at move 2").

## Reading a chess.com / lichess profile: three shapes

Online games are a *mixed* signal. Before treating chesscom/lichess data the same weight as FIDE, spot which of these three profiles the opponent fits — misclassifying is worse than not using online data at all.

1. **Consistent** — plays roughly the same repertoire online and OTB. Gold. Suddenly you have thousands of extra games to see reactions against sidelines and to see where he makes mistakes in the early middlegame under time pressure. Weight online data almost the same as classical FIDE.

2. **Eclectic** — online they play everything under the sun; OTB they have a real narrow repertoire. Still usable, but for a *different* question. Online tells you: (a) which openings he has *seen* and roughly *knows*, (b) which moves he *actually recalls under pressure*, (c) where he makes early mistakes. Online does NOT reliably tell you what he'll play in the game.

3. **Split personality** — online repertoire genuinely differs from OTB. Classic example: a 1.e4 Ruy Lopez player over the board who plays only the King's Gambit on lichess blitz because it's fun. Online is the playground; OTB is serious. **Recognize this and discount the online games entirely** for opening-choice prediction — he's not playing his lichess repertoire in a rated classical game. Online may still surface middlegame tendencies, but "what will he play" belongs to FIDE only.

How to distinguish, quickly: compare the top openings from `get_player_profile` (FIDE-based) against the moves he plays from the starting position in an online-only `prepare_opponent` session. High overlap → shape 1. Modest overlap with FIDE openings as a subset of online → shape 2. Different openings entirely → shape 3.

Write the profile-shape into the prep file's overview comment as soon as you decide it — future re-reads (and the user) benefit from knowing you already made the call.

## Reversed colours as a scarcity trick

For a rare position where the opponent has 0–2 games as their side, it's often worth also checking what they've done in the same position from the OTHER colour. This doesn't tell you what they'd play — it tells you what they've SEEN. Useful when you have no direct data:

- **Surprise calculus**: "he's had this position from the White side against people playing it against him — so seeing it from the Black side isn't a real surprise, he knows the ideas."
- **Structural familiarity**: "he's played this pawn structure before, just from the other colour — his over-the-board understanding will carry over."
- **Cuts both ways**: if the opponent has played it a lot with the OTHER colour AND had good results, assume he knows both sides thoroughly.

Do this by dropping the `color` filter on `prepare_opponent`, or making a second session with the opposite colour — then compare game counts. When density is scarce, information from the "wrong" colour is worth more than no information at all. Just be honest about what it is: knowledge, not prediction.

## Using the user's course library (`find_position_in_courses` + `read_course_at_position`)

The user has a private index of their own Chessable / PGN files (dozens of GB of prep material). This is a **reference library, not memory** — nobody remembers what's in it, but the LLM can query on demand and cite specific chapters.

Two-tool workflow:

1. **`find_position_in_courses(fen)`** → metadata: which courses cover this position, ranked most-recently-updated first (10-year-old material is less trustworthy than 2-month-old). Each hit has a `course_file_id`.
2. **`read_course_at_position({course_file_id, fen})`** → the actual commentary, variations, arrows from that specific chapter. Depth-bounded (`max_plies_below`); widen or call again with a different `fen` to explore further.

Query patterns worth reaching for:

- **"Does my chosen line have coverage?"** — search from the target position. If several recent courses cover it, read the top hit for background before writing prep.
- **"What do opposite-colour repertoires recommend against this move?"** — same position, look at hits authored for the OTHER side. That's the LLM's window into "what will opponents have been told to play here".
- **"Has anyone tried my novelty before?"** — search the post-novelty position. Zero hits = genuine novelty (good). Hits = it's been tried; read what happened.
- **"Compare how two authors annotate the same critical position"** — two `read_course_at_position` calls with different `course_file_id`s.

Discipline:

- Course material is a signal, not truth. A course written 2019 may be objectively refuted by current engine analysis; cross-check with `cloud_analyse` before adopting a course's recommendation wholesale.
- Recency ranking matters most in fast-moving lines (Najdorf, KID, Grünfeld) and less in stable structures (Caro-Kann, Slav mainlines). Weight accordingly.
- Cite the source when you use it: `{Ganguly (Reinventing the Ragozin, 2025) covers this exact position — recommends 12.Rd1.}` The reader can then go read the chapter themselves. Don't dump the course prose into your comment; point them at it.

Not available if fenfind isn't installed on the server; both tools respond with `status: "not_available"` in that case.

## Prep is symmetric — both sides know the same things

The single biggest LLM error in prep is treating it like writing a book: "here's what you should play against this opponent's weakness." A real chess opponent:

- Knows the same weakness the LLM found (or worse, has already patched it since the game where it showed).
- Knows the user's own repertoire the same way the LLM does — by looking at the user's games.
- Will prepare against the user just as hard as the LLM is preparing against them.

Every recommendation should be filtered through: "does this survive the fact that the opponent could easily anticipate it?"

## Recency > career

The opponent's last 12-24 months matter far more than a 10-year career average. Repertoires evolve — a lifelong Najdorf player might have quietly become a Petroff player last year, and their old career stats will lie to you if you skim.

**Related product note:** `get_prep_position` (from a `prepare_opponent` session) deliberately strips the per-move `fashionScore` field. At the individual-player level, fashion is trailing noise — the opponent's opening trend is already captured in game dates. `fashionScore` stays on the general-DB endpoint (`get_position_stats`), where it's genuinely useful: it's what the whole top field is playing this month.

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

The `reachedViaTransposition` field on move statistics tells you how many of the games at that position arrived via a different move order — a hint at how much the line folds into related structures. Move-order tricks are legitimate prep and position stats alone can't recommend them.

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

## Practical, not correspondence

The reader is a human at the board, not a computer consuming a PGN.

- **Don't paste long engine PVs into prose.** A 15-move variation in a comment is unreadable and unmemorable. Cite the eval, name the key move or two, stop. If the line matters as a variation, add it as a branch with `add_line` — the reader walks it interactively there — not as prose.
- **Compress for human memory.** If the opponent has 6 plausible replies that all share one strategic theme, describe the theme once; add the two structurally different branches, not all 6. Long non-forcing lines are unmemorable regardless of eval; recommend depth only when the line is actually forced or the reader has a clear reason to remember it.

## When the database runs thin, judge the position

Sparse data (few games, low ratings, or literally zero) means no "what does the field play here" signal. The LLM has to actually judge the position — and it has two tools that stand in for the missing signal.

- **Call `describe_position` before commenting on a position without concrete game data.** You cannot reliably read a FEN — pieces get swapped, hanging pieces missed, "the knight on d5" turns out to not exist. `describe_position` gives you the same board a human sees: piece placements, contested pieces with attackers/defenders, hanging list, check state, legal moves. Cheap (~1 ms, no engine). Mandatory when the DB is thin, since you no longer have "what won here historically" to anchor the reasoning.
- **Call `predict_human_move` when past theory.** Once out of book, humans play *human* moves — natural, principled, sometimes objectively second-best. The engine's top choice is often not what the opponent actually picks. Rating-condition the prediction on the opponent's level.
- **Think in plans, not lines.** With no games to anchor you, one 12-move engine line is nearly worthless as prep. Two plans described in a sentence each ("break with f4 and pile on the h-file" vs "consolidate with Nc4/Bd2 and play for a3-b4") give the reader something they can actually execute.

## Prune obviously worse branches

Not every legal move deserves a variation. Skip a move when it is **both** significantly worse AND barely played. Either condition alone isn't enough:

- Rare-but-equal sideline → cover it (surprise value).
- Bad move that top players still occasionally try → cover it (you'll face it).
- Rare AND worse → skip. A covered-for-thoroughness branch dilutes the tree and wastes reader attention.

Concrete: after 1.e4 e5 2.d4 from White's side, only 2...exd4 is worth analysing — every alternative is worse AND rare. Cross-check with `get_prep_position` (opponent's actual choices) and `get_position_stats` (population + objective eval) before spending depth on a branch.

## When to stop, when to keep going

Depth calibrates to the *character* of the position, not to whether the DB has games or how deep in the tree you are.

- **Forcing → keep going.** Concrete tactics, only-moves, sharp sequences — analyse until the position calms (real endgame, stable middlegame structure). No game data doesn't matter; the moves are forced, so there's nothing to look up anyway. `describe_position` + engine is enough.
- **Quiet → stop early.** Once the position is strategic — many reasonable moves, no immediate threats — one sentence of plans is worth more than another 6 plies of tree. Stop and describe.
- **Novelties still need coverage — but the position tells you HOW.** If you're introducing a move nobody's played, "the DB has no games" is not a reason to stop; the reader will reach this position over the board and needs an answer. The shape of that coverage follows the same forcing/quiet rule above: if the novelty forces a single reply, cover just that line; if it opens several plausible replies, branch on them. Predict the opponent with `predict_human_move` (rating-conditioned), sanity-check with Stockfish (objective) and Lc0 (practical alternatives). All three signals matter *most* here precisely because no game-database answer exists. See also "Novelty burns" — that's a separate rule about WHEN to spend a novelty.

## How to combine these

None of these are rules; they're weights. In one game against a specific opponent one factor dominates (they clearly hate Catalan structures); in another it's a different one (they're rigid and just play their repertoire, so tree-depth matters more than surprise). Reason through them explicitly when recommending, and cite the concrete numbers (game counts, dates, win rates) so the user can trust or overrule.

Above all: **assume the opponent is doing the same reasoning**, and don't be lulled by a big number.
