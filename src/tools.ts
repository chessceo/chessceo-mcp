// Tool schemas for chessceo-mcp. Pure data — no runtime dependencies.
// Extracted from index.ts in v0.44 for readability; behaviour lives in
// the tool case handlers in index.ts (callToolInner switch).
//
// Descriptions are written for the LLM, not humans — they should hint
// at when to call the tool, what inputs mean, and what the response
// contains. Terse is fine; the LLM already reads the parameter names.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const TOOLS: Tool[] = [
  {
    name: "search_player",
    description:
      "Fuzzy name lookup for FIDE-rated chess players. Returns candidate matches with their FIDE ID, current rating, title (GM/IM/etc.), and country. Use this to resolve a plain-English name (e.g. 'Carlsen', 'Ding Liren') to the FIDE ID that every other tool needs.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Player name or partial name. Case-insensitive, fuzzy.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_player_profile",
    description:
      "Full stats for one player: identity, monthly rating history, peak / trend stats, career W/D/L by color and time control, top-10 openings as White and Black, opponent analysis by rating bracket, notable wins and worst losses, top events with performance ratings. Often enough on its own for 'how strong is X, what do they play, who have they beaten'.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id: {
          type: "integer",
          description: "FIDE ID from search_player.",
        },
      },
      required: ["fide_id"],
    },
  },
  {
    name: "prepare_opponent",
    description:
      "Create a prep SESSION combining games from one or more sources — FIDE database, Chess.com account, Lichess account — with optional filters (colour, date range, time control). Returns a session `token` you pass to `get_prep_position` to query stats at any position within that filtered corpus.\n\n" +
      "This is the main opponent-prep tool. Use it whenever a user asks 'prep me against X' — call once with the right sources+filters, then walk the tree with `get_prep_position(session_token, ...)`. Sessions are cached on the server (list existing ones with `list_prep_sessions` to avoid rebuilding).\n\n" +
      "SOURCES (1-10 per call, combined into one gameset):\n" +
      "- `fide` — needs `fideId`. Optional filters: `color`, `startMonth`/`endMonth`, `timeControl` (`classical`|`rapid`|`blitz`), `excludeOnline`.\n" +
      "- `chesscom` — needs `username`. Filters: `color`, `startMonth`/`endMonth` (**required** for chesscom/lichess), `timeControl`.\n" +
      "- `lichess` — needs `username`. Same filters as chesscom; `timeControl` also accepts `bullet` on Lichess.\n\n" +
      "Multi-source example: one player with both a FIDE ID and a Lichess account → two sources in one call, all their games combined into one session.\n\n" +
      "GROUNDING: every claim about the opponent's repertoire must trace back to a `get_prep_position` call on this session. Don't assert 'they play sharply' or 'they hate isolated queen pawn' without pointing at actual game counts / win rates in the response. Prep is a two-player game — see `read_opening_prep_guide` before recommending an opening plan.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description: "1-10 game sources, all combined into one filtered session.",
          items: {
            type: "object",
            properties: {
              type:        { type: "string", enum: ["fide", "chesscom", "lichess"], description: "Source type." },
              fide_id:     { type: "integer", description: "FIDE ID (required for type='fide')." },
              username:    { type: "string",  description: "Platform username (required for type='chesscom'/'lichess')." },
              color:       { type: "string",  enum: ["white", "black"], description: "Filter: only games where this side is played by the source player. Omit for both colours." },
              start_month: { type: "string",  pattern: "^\\d{4}/\\d{2}$", description: "Filter: games from this month onwards, format 'YYYY/MM'. **Required** for chesscom/lichess." },
              end_month:   { type: "string",  pattern: "^\\d{4}/\\d{2}$", description: "Filter: games up to this month, format 'YYYY/MM'. **Required** for chesscom/lichess." },
              time_control: { type: "string", enum: ["classical", "rapid", "blitz", "bullet"], description: "Filter: only this time control. `bullet` is Lichess-only." },
              exclude_online: { type: "boolean", description: "FIDE-only: exclude online-flagged games (default false)." },
            },
            required: ["type"],
          },
        },
      },
      required: ["sources"],
    },
  },
  {
    name: "get_prep_position",
    description:
      "Query one position within a prep session created by `prepare_opponent`. Returns move statistics (frequency + win rate + last-played date per move) plus the actual games played from that position, in one call.\n\n" +
      "Position input: prefer `file_id`+`node_id` when inside a prep file (server derives FEN from the tree). Otherwise pass `fen`.\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes `.eval` (Stockfish + Lc0 read at the position) so you don't need a separate cloud_analyse.\n\n" +
      "Reading the response — CRITICAL:\n" +
      "• Win % is one weight, not a verdict. Sample size matters (3 games at 66% is noise; 300 at 55% is signal).\n" +
      "• Prep is symmetric information — both sides see the same history. Assume the opponent knows the weakness you spotted.\n" +
      "• Recency > career. The last 12-24 months dominate — filter your session with `start_month` if the player's repertoire shifted.\n" +
      "• Opponent will deviate early. Prep is a tree — cover the 2 most likely replies at each real branching point, not one 20-move line.\n\n" +
      "For the full guide call `read_opening_prep_guide`.",
    inputSchema: {
      type: "object",
      properties: {
        session_token: { type: "string", description: "Session token from `prepare_opponent`." },
        file_id: { type: "string", description: "Prep file id — combine with `node_id` for tree-addressed position lookup." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`." },
        fen: { type: "string", description: "Position as FEN. Only used if `node_id` is not set." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Games to return (default 10)." },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["session_token"],
    },
  },
  {
    name: "list_prep_sessions",
    description:
      "List the caller's active prep sessions with their tokens and metadata. Call this BEFORE `prepare_opponent` to reuse an existing session instead of rebuilding — sessions cost real backend work for chesscom/lichess (downloading months of games), so re-using saves time. Response includes source description, game count, and creation time per session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_prep_session",
    description:
      "Delete one prep session by token. Free-form cleanup — sessions do expire automatically, but this is useful when you're done with one or when you want to force a rebuild after upstream data changed.",
    inputSchema: {
      type: "object",
      properties: {
        session_token: { type: "string", description: "Token from `list_prep_sessions` or the response of `prepare_opponent`." },
      },
      required: ["session_token"],
    },
  },
  {
    name: "get_position_stats",
    description:
      "Move statistics + example games at a position. Answers 'how often is 4.O-O vs 4.d3 played here and which scores better'.\n\n" +
      "SOURCE (default: `gm-classical`) selects a pre-aggregated database shard:\n" +
      "- `gm-classical` — GM classical games (both players ≥2500, real thinking-time). BEST for opening prep — every move is signal, avgElo ~2600 across all listed moves.\n" +
      "- `main` — the whole 11.7M-game DB. Widest coverage but noisiest (includes 1000-Elo blunder-fests in the move stats). Use as fallback when gm-classical's totalCount is too small to be informative.\n\n" +
      "Game movetext is trimmed to the moves AFTER the queried position (using each game's plyNumber). Saves ~70% of the bytes vs full movetext.\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes `.eval` with a compact Stockfish + Lc0 read and the corresponding NAG. Do NOT fire cloud_analyse separately for the same FEN. When called with `file_id`+`node_id`, the eval is also auto-stored on that node's `ceoEval` — later readable via quote_engine_eval.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Prep file id. **Prefer file_id+node_id over `fen`** when a prep file is open — the server derives the FEN from the tree.",
        },
        node_id: {
          type: "string",
          description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`/`line`.",
        },
        fen: {
          type: "string",
          description: "Starting position as FEN. Combine with `moves`. Only used if `node_id` is not set.",
        },
        moves: {
          type: "string",
          description: "Optional SAN moves on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        line: {
          type: "string",
          description: "Synonym for `moves` from startpos; kept for compatibility.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Number of example games to return (default 10).",
        },
        source: {
          type: "string",
          enum: ["gm-classical", "main"],
          description: "Which database shard to query. Default `gm-classical`. Switch to `main` only when gm-classical's totalCount is too low.",
        },
      },
    },
  },
  {
    name: "describe_position",
    description:
      "**CALL WHEN**: about to write ANY comment on a position that describes what's happening on the board — piece activity, structure, plans, weaknesses. This is the single biggest lever for prose quality in the whole system. Live audit: nodes where describe_position was called first produced comments grounded specifically in the position (correct piece squares, real pawn structure, actual weak squares); nodes where it wasn't produced generic pattern-matched prose that confidently named pieces on wrong squares. `set_comment` now emits a warning whenever a substantive comment lands on a node whose position was never grounded via describe_position this session — that warning is telling you to fix a class of hallucination that already showed up in your output. Cheap: chess-primitive analysis is instant, Stockfish leg is ~50-100 ms, no billing.\n\n" +
      "Everything you need to understand a position in one call. Pieces get misplaced when reading a FEN, hanging pieces missed, 'the knight on d5' turns out to not exist.\n\n" +
      "Returns three layers:\n\n" +
      "**Board state** — piece placements per colour, material balance in pawn units, contested pieces (attackers + defenders), hanging pieces, checkers if in check, castling rights, en passant, side to move, full LEGAL MOVES list. Use `.legalMoves` when `add_move` rejects an illegal SAN.\n\n" +
      "**Structural analysis** — chess-concept observations a human sees at a glance:\n" +
      "  • `pawnStructure.files` — each file `open`/`half_open_for_white`/`half_open_for_black`/`closed`. Half-open files are natural rook targets.\n" +
      "  • `pawnStructure.islands` — count per colour (more = weaker structure).\n" +
      "  • `pawnStructure.isolated` / `doubled` / `passed` / `backward` — structural weaknesses (and strengths, for passed).\n" +
      "  • `weakSquares` — holes in ranks 3-6 that no friendly pawn can ever attack. Prime real estate for enemy pieces.\n" +
      "  • `outposts` — friendly N/B on an enemy hole defended by own pawn. Classic strong squares.\n" +
      "  • `bishops` — per-bishop `good`/`mixed`/`bad` from own pawns on its colour. `bishops.pair` flags who has both.\n" +
      "  • `space` — squares controlled in the enemy half.\n\n" +
      "**Engine eval terms** (`engineEvalTerms`) — Stockfish's classical eval decomposed into 13 named contributing terms (Material, Imbalance, Pawns, Knights, Bishops, Rooks, Queens, Mobility, King safety, Threats, Passed, Space, Winnable), each with white / black / total values in mg + eg. Stockfish's own answer to WHY the position stands the way it does.\n" +
      "  → **Primary use: the delta pattern.** Call `describe_position` on the position BEFORE and AFTER a candidate move, compare `engineEvalTerms` — the term with the biggest shift tells you WHAT the move changed (king safety collapsed → move exposed the king; mobility jumped → move improved coordination). Kim et al. NAACL 2025 showed this named-delta pattern roughly doubles LLM chess-commentary correctness vs a bare eval number.\n" +
      "  → Omitted from the response if Stockfish isn't installed on the server.\n\n" +
      "Position input: prefer `file_id`+`node_id` if inside a prep file. Otherwise `fen`, `moves` from startpos, or `fen + moves`.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. When combined with `node_id`, describes that node's position." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'." },
        fen:     { type: "string", description: "Starting position as FEN (defaults to startpos). Only used if `node_id` is not set." },
        moves:   { type: "string", description: "Optional SAN moves to apply on top of `fen`. Only used if `node_id` is not set." },
      },
    },
  },
  {
    name: "predict_human_move",
    description:
      "Neural net (ResNet-20x256) trained on real games. Always evaluated at **2850 vs 2850** (top-level play) — the rating is fixed on purpose, so cross-position comparisons stay apples-to-apples. Returns two signals — both useful, treat as independent:\n\n" +
      "1. **Top-N most likely moves** (`moves: [{san, p}, ...]`) — what a top player will actually pick. Different question from engines: cloud_analyse says objectively best, this says what the human will play. If the human top move is a mistake, that's a real practical advantage.\n\n" +
      "2. **`wdlWhitePov: {win, draw, loss}`** — game-outcome prediction, White POV. Directly comparable across positions: call on two positions, compare `draw` to find which line is drawier / more forcing. Two-line comparisons are how you answer 'must-win with Black, which of these openings gives more play'.\n\n" +
      "Pass `prev_fens` (most recent first) when the position is mid-trade — without history the model treats it as quiet, which under-counts practical chances.\n\n" +
      "Position input: prefer `file_id`+`node_id` when inside a prep file. Otherwise `fen`, `moves` from startpos, or `fen + moves`. ~1-2s per call. **Premium (or admin/moderator) only** — anonymous calls get 402.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. Combine with `node_id` to point at a tree node's position." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'." },
        fen: { type: "string", description: "Starting position as FEN. Only used if `node_id` is not set." },
        moves: {
          type: "string",
          description: "Optional SAN moves to apply on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        top: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of top predicted moves to return (default 5).",
        },
        prev_fens: {
          type: "array",
          items: { type: "string" },
          description: "Previous FEN(s), most recent first. Optional — omit for quiet-position analysis. Useful mid-trade so the model doesn't assume the position is stable.",
        },
      },
    },
  },
  {
    name: "get_head_to_head",
    description:
      "Complete head-to-head record between two players. Includes overall and per-colour W/D/L (from player A's perspective), splits by time control, most-played openings between them, first / last meeting, average game length, and the game list.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id_a: { type: "integer", description: "FIDE ID of player A (record is from A's perspective)." },
        fide_id_b: { type: "integer", description: "FIDE ID of player B." },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["fide_id_a", "fide_id_b"],
    },
  },
  {
    name: "list_live_tournaments",
    description:
      "Tournaments currently being broadcast live on chess.ceo. Use this when the user asks 'what's on right now' / 'live tournaments today'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tournament_players",
    description: "Players participating in one live-broadcast tournament.",
    inputSchema: {
      type: "object",
      properties: {
        tour_id: { type: "string", description: "Tournament ID from list_live_tournaments." },
      },
      required: ["tour_id"],
    },
  },
  {
    name: "list_player_live_tournaments",
    description:
      "Which currently-live broadcasts a given player is competing in. Use when the user asks 'is X playing anywhere right now'.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id: { type: "integer", description: "FIDE ID from search_player." },
      },
      required: ["fide_id"],
    },
  },
  {
    name: "list_cloud_machine_options",
    description:
      "Returns the catalog of combo cloud-engine machine types the user can start (SKU, human display name, cost per hour, availability). ALWAYS call this before start_cloud_engine — SKU strings like 'rtx-5090-64' do not match the display names ('Stockfish 32 CPUs + Lc0 1× RTX 5090') and are NOT guessable. Present the user the display names + prices; pass the SKU to start_cloud_engine.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_cloud_engine",
    description:
      "Rent a combo GPU instance (Stockfish + Lc0 in the same container) on the user's chess.ceo account. Real money — billed per second while running.\n\n" +
      "CRITICAL: `machine_type` must be an exact SKU from `list_cloud_machine_options` (e.g. 'rtx-5090-64', NOT 'rtx-5090'). Guessing SKUs will fail. Call list_cloud_machine_options first, show the user the display names + prices, get their confirmation, then pass the SKU here.\n\n" +
      "Use list_cloud_engines first to check if the user already has one running; don't start a second combo unless the user asked for it. Requires an MCP token with agent access.",
    inputSchema: {
      type: "object",
      properties: {
        machine_type: {
          type: "string",
          description:
            "SKU from list_cloud_machine_options (e.g. 'rtx-5090-64', 'rtx-5090-dual-64'). MUST be the exact SKU, not the display name and not a guess.",
        },
      },
      required: ["machine_type"],
    },
  },
  {
    name: "list_cloud_engines",
    description:
      "List the user's currently running cloud engines. Use before starting a new one, or to find the contract_id for stop_cloud_engine. `cloud_analyse` auto-picks the only running combo, so listing is only necessary when the user might have zero or several.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_cloud_engine",
    description:
      "Destroy a running cloud engine. Billing stops immediately. Use the contract_id from `list_cloud_engines` — don't guess.",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: {
          type: "string",
          description: "Instance contract_id, from list_cloud_engines.",
        },
      },
      required: ["contract_id"],
    },
  },
  {
    name: "cloud_analyse",
    description:
      "Runs a synchronous ~2s analysis on the user's running combo instance and returns both Stockfish and Lc0's final read for the FEN — depth, top-N candidate moves with scores (**scoreCp is White-POV centipawns**: +20 = White is +0.20 pawns better regardless of whose turn it is; matches the sign convention used everywhere else in this MCP, including the stored ceoEval). Mate is White-POV plies-to-mate (+5 = White mates in 5). Also returns each engine's principal variation.\n\n" +
      "GROUNDING: every claim you make about a position must trace back to actual engine output from a call in THIS session. Don't invent evaluations, don't name 'best moves' you haven't seen the engine list, don't fabricate variations that 'look plausible.' Compute is cheap — call this 5-10 times while walking a tree rather than pattern-matching from your training data. When you don't have data for the position, either run the tool or say so; don't fill the gap with chess prose the user can't distinguish from measured output.\n\n" +
      "Auto-picks the caller's only running combo instance; errors clearly if there are zero (start one first with start_cloud_engine) or more than one (destroy the extras first).\n\n" +
      "How to read the response:\n" +
      "• Stockfish is objective truth — trust it for 'does this line hold?' 'is there a tactic?' 'is this endgame drawn?' A Stockfish 0.00 means 'objectively equal', NOT 'trivial draw' — one side can still be much harder to play in practice.\n" +
      "• Lc0 is practical eval — trust it for 'which side is easier?' 'which candidate is best when Stockfish shows several as equal?' Lc0 sees long-term positional factors Stockfish's fixed search can miss.\n" +
      "• When they agree → high confidence. When they disagree → look at both scores and reason WHY (Stockfish sharply higher = tactic Lc0 missed; Lc0 higher = long-term positional edge past Stockfish's horizon). Never dismiss either — the disagreement is the signal.\n\n" +
      "Contempt (`contempt`) skews Lc0 (only Lc0 — Stockfish always stays objective) toward White (positive) or Black (negative). Signed 0-100 strength — same scale as the web UI's ContemptStrength slider (the server multiplies by 8 to produce Lc0's internal cp bias). Typical values: ±15 for a light nudge, ±30-60 for real fighting play, ±80-100 for maximum steer. Use it to find non-objective 'practical' ideas or when the user needs to lean toward fighting/solid lines with a specific colour. Do NOT quote a contempt-biased eval as objective — cross-check with Stockfish.\n\n" +
      "Also useful: pass `moves` on top of `fen` to explore a variation without computing FENs yourself (e.g. fen='<tabiya>', moves='b4 a5 c3'). And the flip-side-to-move threat check documented in the guide is a great free trick.\n\n" +
      "**PVs are capped at 6 plies by default (3 full moves), and lines that got truncated are marked with `pv_truncated: true`.** This is deliberate: the tail of a PV is where the engine's confidence collapses, AND pasting a long PV into `add_line` as if it were prepared repertoire is the #1 documented anti-pattern of this MCP — a 15-move PV is one line of engine output through positions where both sides had real choices, not a repertoire. To see further, don't raise `pv_max_plies`; instead, walk the tree one branch at a time with a fresh `cloud_analyse` at each position where the opponent has real alternatives — that's what makes it prep instead of pasted output. Only raise the cap when you're verifying a forcing sequence (a mate, a forced tactical resolution), not to build lines.\n\n" +
      "For the full guide including worked examples, call the `read_engine_usage_guide` tool.\n\n" +
      "Not for casual questions — this costs real money per second. Use `get_position_stats` for anything that doesn't require deep prep.\n\n" +
      "**When called with `file_id`+`node_id` (preferred inside a prep file), the resulting eval is auto-stored on that node's `ceoEval` — you can then quote it with quote_engine_eval on any later call.** This is what makes engine attribution trustworthy: prose that says 'engines say X on node Y' can only be true if a call was actually made against node_id=Y.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. **Prefer file_id+node_id over fen** when inside a prep file — the FEN comes from the tree AND the result is stored on the node." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`." },
        fen: { type: "string", description: "Starting position as FEN. Only used if `node_id` is not set." },
        moves: {
          type: "string",
          description: "Optional SAN moves to apply on top of `fen` (or startpos). Only used if `node_id` is not set.",
        },
        movetime_ms: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          description: "Think time in milliseconds (default 2000).",
        },
        stockfish_multipv: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Stockfish candidate lines (default 2). Kept tight because each extra PV steals search bandwidth from the top choice — SF is the 'what's objectively best' leg, use a low multipv to keep it strong. Raise only when you specifically need SF's take on a wide range of candidates.",
        },
        lc0_multipv: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Lc0 candidate lines (default 8). Kept wide because multipv doesn't degrade Lc0's strength the way it does Stockfish's — Lc0 is the 'find inspiration / explore practical tries' leg, use a high multipv to get a full slate of ideas.",
        },
        contempt: {
          type: "integer",
          minimum: -100,
          maximum: 100,
          description:
            "Lc0 contempt bias. Signed 0-100 strength (same scale as the web UI's ContemptStrength slider — server multiplies by 8 to get the internal cp bias). 0 = objective (default). Positive favours White, negative favours Black. Typical: ±15 light nudge, ±30-60 real fighting play, ±80-100 maximum steer. Not applied to Stockfish. See engine_usage_primer for when to use.",
        },
        engines: {
          type: "array",
          items: { type: "string", enum: ["stockfish", "lc0"] },
          description:
            "Which engines to run. Default = both. Use `[\"lc0\"]` to skip Stockfish (e.g. while a deep_analyse job is holding the SF slot on the same combo). Use `[\"stockfish\"]` when only the objective read matters. The skipped engine's field is omitted from the response.",
        },
        pv_max_plies: {
          type: "integer",
          minimum: 1,
          maximum: 40,
          description: "Cap each returned PV to this many plies (default 6 = 3 full moves). PVs beyond ~6 plies are speculative and are the anti-pattern behind pasted-engine-line 'prep' — don't raise unless you're specifically checking a forcing tactic or verifying a mate. When a line was truncated, the response marks it with `pv_truncated: true`.",
        },
      },
    },
  },
  {
    name: "list_collections",
    description:
      "List the user's own PGN collections — every collection they've created, not just prep files. Response: `{collections: [{id, title, icon, folder_path, game_count, updated_at, position_search_enabled}]}`.\n\n" +
      "**Call this before create_prep_file** — the LLM must pick a collection to write into (no default landing folder any more; the old hidden `/mcp` collection was retired in v0.43). Also useful when the user asks a position-shaped question — LLM can then run find_position_in_files to see which of these collections already covers the position.\n\n" +
      "Encrypted collections (client-side-encrypted PGN) are excluded — the server can't read their contents, so they'd be dead weight on this surface.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_prep_files",
    description:
      "List the games (prep files) inside one of the user's collections. **Requires `collection_id`** — call `list_collections` first if you don't have one. Returns id (composite `<collection_id>:<game_id>`, opaque to the LLM — pass as-is to read_prep_file / mutation tools), PGN header fields, updated_at.\n\n" +
      "For cross-collection discovery use `search_prep_files` (text) or `find_position_in_files` (position); list_prep_files is the browse-one-collection tool.",
    inputSchema: {
      type: "object",
      properties: {
        collection_id: { type: "string", description: "Collection id from list_collections. Required." },
      },
      required: ["collection_id"],
    },
  },
  {
    name: "search_prep_files",
    description:
      "Text search over the user's prep files ACROSS ALL their collections (matches PGN headers, comments, and content). Use when you know a keyword — e.g. search_prep_files(query='Firouzja') or search_prep_files(query='Najdorf'). Cheaper than paging list_collections + list_prep_files to find one file by name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query (opponent name, opening name, event keyword)." },
      },
      required: ["query"],
    },
  },
  {
    name: "find_position_in_files",
    description:
      "Position search across every one of the user's EDITABLE prep files (all their non-encrypted collections). Given a FEN, returns which of the user's files reach that exact position (or a transposition of it — matched by zobrist hash, so move-order variants are found automatically). Recency-sorted.\n\n" +
      "Distinct from `find_position_in_courses`: courses are READ-ONLY reference material (Chessable PGNs, downloaded backups); this searches the user's OWN editable prep. Common workflow: user asks about a position → call this first to see if their existing prep covers it → if yes, extend that file; if no, consider whether to start new prep.\n\n" +
      "Position input: `file_id`+`node_id` (from an already-open prep file), or `fen`, or `moves` from startpos, or `fen`+`moves`.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. With `node_id`, derives FEN from the tree." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'." },
        fen:     { type: "string", description: "Position as FEN. Only used if `file_id`/`node_id` not set." },
        moves:   { type: "string", description: "SAN moves from startpos (or on top of fen)." },
        line:    { type: "string", description: "Alias for moves." },
      },
    },
  },
  {
    name: "read_prep_file",
    description:
      "Read one prep file. Response always includes `id`, `version`, `tags`. The tree/PGN part is controlled by `view` and `node_id`/`max_depth` — large files (500+ nodes) can otherwise blow the LLM's token limit.\n\n" +
      "**Views** (pick the smallest one that answers your question):\n" +
      "  • `compact` (default) — per-node: `id`, `san`, `ply`, `nags`, `comment`, `ceoEval`, `children`. Drops `fen` and `annotations`. Typical size: ~120 chars/node vs ~330 in `full`.\n" +
      "  • `full` — everything (`fen`, `annotations` too). Use when you actually need the FEN inline or want to inspect arrows/highlights. On a 500+-node file this can exceed token limits.\n" +
      "  • `spine` — mainline only (children[0] recursively). Great for a 'what does this repertoire cover' summary.\n" +
      "  • `pgn` — subtree as raw PGN text (comments, NAGs, [%cal] arrows all preserved). Useful for sanity-checking formatting against reference material.\n\n" +
      "**Node addressing.** Every node has a stable `id` — root is `'r'`, every other node is an 8-hex-char content hash of parent-id + SAN. Sibling insertions, deletions, variation promotions never shift ids. Pass as `node_id` (or `parent_id` for add_move / add_line) to every mutation and engine/DB tool.\n\n" +
      "**Scoping.** `node_id` starts the tree from a subtree root (default `'r'`). `max_depth` caps the tree at that many plies below the anchor (default unlimited). Use both to drill into a specific branch without dumping the whole file — the LLM never needs to see the full 800-node tree at once.\n\n" +
      "For querying the tree without reading it (\"which nodes have no ceoEval?\", \"give me the mainline spine\") call `list_nodes` — cheaper than parsing a full read.\n\n" +
      "**Every engine/DB tool accepts `file_id`+`node_id`** (get_position_stats, cloud_analyse, describe_position, predict_human_move, prep_snapshot, get_prep_position, quote_engine_eval). Use it whenever a file is open — the server derives the FEN from the tree, so you can't 'analyse the wrong position' by mis-typing a FEN.",
    inputSchema: {
      type: "object",
      properties: {
        id:        { type: "string", description: "Prep file id, from list_prep_files or search_prep_files." },
        view:      { type: "string", enum: ["compact", "full", "spine", "pgn"], description: "Response shape. Default `compact` — drops fen + annotations to keep token count sane. See tool description for when to use each." },
        node_id:   { type: "string", description: "Subtree root (default `'r'` = whole file)." },
        max_depth: { type: "integer", minimum: 0, description: "Cap the returned tree at this many plies below `node_id`. Omit for unlimited." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_nodes",
    description:
      "Cheap tree queries without reading the whole file. Returns only the node ids matching the filter (plus san, ply, and any filter-specific bits), so the LLM can find what it needs in ~KBs instead of MBs.\n\n" +
      "Filters:\n" +
      "  • `missing_eval` — nodes without a stored `ceoEval`. Use before `auto_evaluate` to know how much work is left, or to target a small batch.\n" +
      "  • `has_comment` — nodes with a text comment. Use to audit what's been annotated.\n" +
      "  • `has_annotations` — nodes with arrows or highlighted squares.\n" +
      "  • `mainline` — the spine (children[0] recursively). Use for a compact 'what does the repertoire cover' view.\n" +
      "  • `novelties` — nodes carrying the `$146` NAG.\n" +
      "  • `leaves` — nodes with no children (variation endpoints). Useful for finding lines that need continuation.\n" +
      "  • `transpositions` — nodes that share their position with at least one other node in the same file (piece placement + side to move + castling rights match). Response includes `transposes_to: [node_id, …]` per hit so you can see the partners without a second call. Use this BEFORE auto_evaluate on a large branch to see where analysis will double up, and BEFORE writing prose to know which nodes can share commentary via 'transposes to line X'.\n" +
      "  • `all` — every node id. Use only when you really need the whole list.\n\n" +
      "Response: `{ file_id, filter, count, nodes: [{node_id, san, ply, ...}] }`. `...` is filter-specific — e.g. `has_comment` includes the first 80 chars of the comment; `transpositions` includes `transposes_to`; `missing_eval` includes nothing extra (just the addressing).",
    inputSchema: {
      type: "object",
      properties: {
        id:       { type: "string", description: "Prep file id." },
        filter:   { type: "string", enum: ["missing_eval", "has_comment", "has_annotations", "mainline", "novelties", "leaves", "transpositions", "all"], description: "Which nodes to list." },
        node_id:  { type: "string", description: "Subtree root (default `'r'` = whole file)." },
        max_depth:{ type: "integer", minimum: 0, description: "Cap the walk at this many plies below `node_id`. Omit for unlimited." },
      },
      required: ["id", "filter"],
    },
  },
  {
    name: "list_transpositions",
    description:
      "Group every position in a prep file that appears more than once — the same piece placement + side-to-move + castling rights reached by different move orders. Chess move orders diverge and re-converge constantly (1.d4 Nf6 2.c4 e6 3.Nc3 vs 1.c4 e6 2.Nc3 Nf6 3.d4 land on the same position); if you analyse both branches independently or write the same commentary twice, you're wasting engine time and inviting inconsistency.\n\n" +
      "Call this BEFORE `auto_evaluate` on a big subtree to see how much work will actually be new, and BEFORE writing prose to know which nodes can share a comment or should point at each other with 'transposes to line X'.\n\n" +
      "Note: engine evals auto-propagate — when `cloud_analyse({file_id, node_id})` stores `ceoEval` on a node, it also stamps every transposition of that position in the same file (see the response's `also_stored_on`). And `auto_evaluate({only_missing: true})` naturally skips the twin because it now has an eval. So detection is cheap AND propagation is automatic; this tool is for prose planning and one-shot audits, not for gating engine work.\n\n" +
      "Response: `{ file_id, group_count, node_count, groups: [{ position_key, size, node_ids, sans }] }`. `position_key` is the 3-field FEN prefix used as the match key; `size` is how many nodes share it; `sans` are the moves that led to each occurrence (parallel with `node_ids`, DFS order — first entry is the earliest/mainline-preferred occurrence). Only groups with size ≥ 2 are returned; sorted by size descending.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prep file id." },
      },
      required: ["id"],
    },
  },
  {
    name: "create_prep_file",
    description:
      "Create a new (empty) prep file in the specified collection. `name` becomes the Event PGN tag. You then extend it with mutation tools (add_move, set_comment, …).\n\n" +
      "**collection_id is REQUIRED** — call `list_collections` first to pick where it lives. There is no default landing folder any more (v0.43: the old hidden `/mcp` collection was removed; prep files now live wherever the user organizes them).\n\n" +
      "**Duplicate-check first.** Call `search_prep_files(query=<opponent / opening keyword>)` OR `find_position_in_files(fen=...)` before creating — a second 'Prep vs Firouzja' file when one already exists is a common LLM failure mode. If a file already covers the topic, extend that one instead.\n\n" +
      "Response: `{ok, id, collection_id, version}` — `id` is a composite you pass to every other prep-file tool as `id` or `file_id`.",
    inputSchema: {
      type: "object",
      properties: {
        collection_id: {
          type: "string",
          description: "Collection id from list_collections. Required — this is where the new file lands.",
        },
        name: {
          type: "string",
          description: "User-facing name — becomes the [Event] tag. Example: 'Prep vs Firouzja (Black) 2026-07-23'.",
        },
      },
      required: ["collection_id", "name"],
    },
  },
  {
    name: "delete_prep_file",
    description:
      "Soft-delete a prep file. Fully reversible: the file lands in the user's recycle bin, from which either the user (via app UI) OR you (via `restore_prep_file`) can bring it back. Permanent delete is intentionally NOT exposed on this surface — the user has to permanent-delete from the app themselves. Rare — usually you extend or edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prep file id." },
      },
      required: ["id"],
    },
  },
  {
    name: "restore_prep_file",
    description:
      "Restore a previously soft-deleted prep file. Undo the `delete_prep_file` call — the file comes back with a fresh `game_number` (its slot in the collection is not preserved) and its full history intact. Use when you realize mid-session you shouldn't have deleted something; the LLM can fix its own mistake without asking the user to open the app.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prep file id (composite `<collection_id>:<game_id>`). Same id `delete_prep_file` was called with." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_move",
    description:
      "Append a move as a new child of the node identified by `parent_id`. If the parent already has children, the new move becomes a variation (appended at the end); use promote_variation afterwards to make it the mainline. SAN is validated against the position — illegal moves are rejected with a clear error.\n\n" +
      "Auto-saves. Returns `{node_id, version}` — the id of the new node (pass this to follow-up set_comment / set_nags / etc.) and the new file version for optimistic locking. **Node ids are content-derived and stable** — sibling insertions, deletions, and promotions do NOT change any other node's id.",
    inputSchema: {
      type: "object",
      properties: {
        id:        { type: "string", description: "Prep file id." },
        parent_id: { type: "string", description: "Node id of the parent (the position the move is played FROM). Root id is 'r'." },
        san:       { type: "string", description: "The move in SAN notation (e.g. 'Nf3', 'exd5', 'O-O', 'Qxf7+')." },
        expected_version: { type: "integer", description: "Optimistic-lock check; pass the `version` from your last read." },
      },
      required: ["id", "parent_id", "san"],
    },
  },
  {
    name: "add_line",
    description:
      "Append a linear sequence of moves under `parent_id`. Each SAN in the list becomes the mainline child of the previous — one call instead of N add_move calls for a straight variation. If the parent already has other children, this whole line is appended as a variation (promote_variation the first move if you want it as the mainline).\n\n" +
      "**Anti-pattern: pasting an engine PV as a single long `add_line`.** Real prep is a tree, not a line. Almost every position along a variation has more than one plausible move — pasting a 12+-ply engine PV without branching at those points is the #1 documented failure mode of this MCP: it produces a page that reads as prep but ignores every decision the opponent actually gets to make. Long unbranched lines get a warning field in the response starting at ~9 plies and a strong warning at 14+ plies. Rule of thumb: if you added ≥8 plies in one call, at least half of them should have branched. Genuine exceptions exist (forced mates, obligated exchange sequences) — in those cases add a comment naming what makes the sequence forced (`{Every move here is forced by the mate threat.}`), so the reader knows it's forced by chess, not by LLM laziness.\n\n" +
      "Auto-saves. Returns `{node_id, line: [{node_id, san}, ...], version}` — `node_id` is the last (leaf) node's id, `line` is every node created in order so you can address any of them next. When long-and-linear, also includes `warning: \"...\"`.",
    inputSchema: {
      type: "object",
      properties: {
        id:        { type: "string", description: "Prep file id." },
        parent_id: { type: "string", description: "Node id of the parent to build from. Root is 'r'." },
        sans:      { type: "array", items: { type: "string" }, minItems: 1, description: "SAN moves in order, e.g. ['e4','e5','Nf3','Nc6','Bb5']." },
        expected_version: { type: "integer" },
      },
      required: ["id", "parent_id", "sans"],
    },
  },
  {
    name: "set_comment",
    description:
      "Set (or clear, with empty string) the text comment on the node identified by `node_id`. Comments are for plans, prep-signal, and interpretation the app can't derive — NOT for describing moves that should be variations instead. Auto-saves.\n\n" +
      "**Two guardrails fire in the response as `warnings: [...]`:**\n" +
      "  1. **Content scan** — comments containing spread lists (`≈50, ≈42, …`), raw centipawn values (`≈−60`, `+0.35`, `at depth 24`), or roster restatement (`146 GM games — Nakamura, …`) are all restating what the app already renders. The warning names the fix (set the NAG and drop the number; label the character not the numbers; cite a specific game instead of a count).\n" +
      "  2. **Ungrounded prose** — substantive comments (≥40 chars) on a node whose position was never passed to `describe_position` this session are prone to hallucinated structural claims (piece on wrong square, invented captures, misidentified pawn structure). Call `describe_position` with `file_id`+`node_id` BEFORE writing prose about the position; the same node's warning clears once the position is described.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "Prep file id." },
        node_id: { type: "string", description: "Node id from read_prep_file / add_move." },
        comment: { type: "string", description: "New comment text. Empty string clears." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id", "comment"],
    },
  },
  {
    name: "set_nags",
    description:
      "Replace the list of NAGs on the node identified by `node_id`. Empty array clears them. NAGs are your EDITORIAL call — see read_pgn_authoring_guide for the discipline (novelty $146, sharp choice $5, decisive $18/$19, etc.). Do NOT set $10 '=' on every equal position; that's board noise. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        nags:    { type: "array", items: { type: "string", pattern: "^\\$\\d+$" }, description: "NAG list, e.g. ['$14'] or ['$146', '$44']." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id", "nags"],
    },
  },
  {
    name: "set_annotations",
    description:
      "Replace the visual annotations (arrows + coloured squares) on the node identified by `node_id`. Passing empty arrays clears them.\n\n" +
      "Colours: green, red, yellow, light-blue, dark-blue, orange. Keep it LIGHT: 1-3 arrows and 2-3 squares per move maximum. Twenty arrows is noise, not signal. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        arrows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color: { type: "string", enum: ["green", "red", "yellow", "light-blue", "dark-blue", "orange"] },
              from:  { type: "string", pattern: "^[a-h][1-8]$" },
              to:    { type: "string", pattern: "^[a-h][1-8]$" },
            },
            required: ["color", "from", "to"],
          },
        },
        highlights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color:  { type: "string", enum: ["green", "red", "yellow", "light-blue", "dark-blue", "orange"] },
              square: { type: "string", pattern: "^[a-h][1-8]$" },
            },
            required: ["color", "square"],
          },
        },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "delete_subtree",
    description:
      "Delete the node identified by `node_id` and all its descendants. Refuses to delete the root. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string" },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "promote_variation",
    description:
      "Make the node identified by `node_id` its parent's mainline (children[0]), demoting the current mainline (and any other siblings) into variation order. Silently no-op if already the mainline. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string" },
        node_id: { type: "string", description: "Node id of the variation to promote. Cannot be root." },
        expected_version: { type: "integer" },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "apply_mutations",
    description:
      "Batch: apply a list of mutations in one call. One load-parse-mutate-export-save cycle for N ops, so building a 100-move repertoire costs one HTTP round-trip and one save instead of 100. This is the RIGHT way to build a file — use single mutations only for surgical follow-up edits.\n\n" +
      "Each mutation is `{op, node_id | parent_id, ...args}` where `op` is one of: add_move, add_line, set_comment, set_nags, set_annotations, delete_subtree, promote_variation, set_tag. Same arg shape as the individual tools. Ops apply in order; because node ids are content-derived (hash of parent_id + san), a node created by an early op has a deterministic id you can reference in later ops in the same batch.\n\n" +
      "Any op error aborts the batch (nothing saved). Response is `{ok, results: [{node_id, line?}], version}` — one entry per op with the id it landed on (add_line also returns the full line array).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        expected_version: { type: "integer" },
        mutations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add_move", "add_line", "set_comment", "set_nags", "set_annotations", "delete_subtree", "promote_variation", "set_tag"] },
              node_id:   { type: "string" },
              parent_id: { type: "string" },
              san:  { type: "string" },
              sans: { type: "array", items: { type: "string" } },
              comment: { type: "string" },
              nags: { type: "array", items: { type: "string", pattern: "^\\$\\d+$" } },
              arrows: { type: "array" },
              highlights: { type: "array" },
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["op"],
          },
        },
      },
      required: ["id", "mutations"],
    },
  },
  {
    name: "auto_evaluate",
    description:
      "Walk the tree from `node_id` (default `'r'` = whole file) and populate the persistent `ceoEval` on every descendant via cloud_analyse. Requires a running cloud combo instance.\n\n" +
      "**Async job — returns immediately.** Response: `{ job_id, target_count, status: 'running', estimated_seconds }`. Then poll `auto_evaluate_status(job_id)` until `done: true`. Cancel a run with `auto_evaluate_cancel(job_id)` — partial progress is preserved. Do useful other work between polls (write more of the tree, walk the opponent's repertoire) — the engine runs in the background.\n\n" +
      "Progress is checkpointed to the prep file every 8 successfully-evaluated nodes, so a cancel / crash / MCP restart mid-run leaves the tree partially populated rather than losing everything. On MCP restart the job record disappears; re-run auto_evaluate and `only_missing=true` naturally skips what was already saved.\n\n" +
      "**Does NOT set visible NAGs.** NAG placement is your call, not the engine's — an opening tree full of 0.00 positions doesn't need a `$10` (=) glyph on every move. Use quote_engine_eval on individual nodes before writing prose that references engine numbers.\n\n" +
      "Costs real money — one cloud_analyse per node. A 200-node walk at default movetime is ~5 min of engine time (calls serialise on the per-combo semaphore in the backend).",
    inputSchema: {
      type: "object",
      properties: {
        id:            { type: "string" },
        node_id:       { type: "string", description: "Subtree root (default 'r' = whole file)." },
        only_missing:  { type: "boolean", description: "Skip nodes that already carry a stored ceoEval (default true)." },
        movetime_ms:   { type: "integer", minimum: 500, maximum: 5000, description: "Per-node cloud_analyse think time (default 1500)." },
      },
      required: ["id"],
    },
  },
  {
    name: "auto_evaluate_status",
    description:
      "Poll the status of an auto_evaluate job. Response: `{ status: 'running' | 'done' | 'cancelled' | 'error' | 'not_found', target_count, evaluated, errored, remaining, done, error?, version? }`. When `status: 'not_found'` the job either expired (kept ~15 min after completion), never existed, or the MCP restarted since it was created — re-run auto_evaluate.\n\n" +
      "Typical poll cadence: every 3-5 s for small walks, every 10-30 s for large ones. Don't hammer — status is a pure in-memory read but polling doesn't speed the engine up.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id from the `auto_evaluate` response." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "auto_evaluate_cancel",
    description:
      "Ask a running auto_evaluate job to stop as soon as its current node finishes. Whatever progress was completed before cancellation is durably saved (checkpoint on cancel). Idempotent — cancelling an already-finished job is a no-op with a clear note in the response.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id from the `auto_evaluate` response." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "deep_analyse",
    description:
      "Start a long Stockfish think on a single position (up to 5 min movetime). Returns a `job_id` immediately; poll `deep_analyse_status(job_id)` for the result, cancel with `deep_analyse_cancel(job_id)`. Runs SF only — Lc0 doesn't benefit from long thinks past a handful of seconds — and **holds only the SF engine slot on the combo, so `cloud_analyse(..., engines: [\"lc0\"])` stays available for other work in parallel**.\n\n" +
      "Use this when a specific critical position deserves depth — a novelty candidate, a hairy tactical shot, a difficult endgame — and you want Stockfish at depth 35+ rather than the ~depth 22 you get from a 2s cloud_analyse. Movetime is in ms; typical: 30_000-60_000 for 'careful check', 120_000-300_000 for 'find the truth'.\n\n" +
      "Result shape when done matches cloud_analyse's Stockfish leg (depth, top-N candidates with scoreCp/mate, best move, PV). Auto-stores the eval on `file_id`+`node_id` when both are supplied, same as cloud_analyse.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. Combine with `node_id` to derive FEN from the tree AND persist the result on the node's ceoEval." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`." },
        fen: { type: "string", description: "Position as FEN. Only used if `node_id` is not set." },
        moves: { type: "string", description: "Optional SAN moves on top of `fen`. Only used if `node_id` is not set." },
        movetime_ms: {
          type: "integer",
          minimum: 5_000,
          maximum: 300_000,
          description: "Think time in ms. Default 60_000 (1 min). Max 300_000 (5 min).",
        },
        multipv: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of candidate lines (default 2). Stockfish gets weaker as multipv grows — each extra PV steals search bandwidth from the top choice — so keep this low unless you specifically want to see several candidates ranked deep.",
        },
      },
    },
  },
  {
    name: "deep_analyse_status",
    description:
      "Poll a deep_analyse job. Response: `{ status: 'running' | 'done' | 'cancelled' | 'error' | 'not_found', elapsed_ms, movetime_ms, result?, error? }`. `result` shape when done: `{ engine, depth, timeMs, bestMove, lines: [{rank, depth, scoreCp?, mate?, pv, nodes?}] }` — the SF leg of a cloud_analyse response.\n\n" +
      "Poll cadence: every ~15-30s for long thinks; there's no penalty for polling more often but the engine progresses at its own pace.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id from `deep_analyse`." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "deep_analyse_cancel",
    description:
      "Ask a running deep_analyse job to stop early. The engine returns whatever it's found so far as the final result. Useful when a partial result at depth 25 is enough and you don't want to wait for depth 40. Idempotent for already-finished jobs.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id from `deep_analyse`." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "find_position_in_courses",
    description:
      "Look up which of the USER's own Chessable / PGN courses cover a position. This is the LLM's window into what the user has personally studied — not a general database. Two-step: `find_position_in_courses` returns metadata (course, chapter, author, updated_at, notes_chars, `course_file_id`); `read_course_at_position` fetches the actual commentary + variations from a specific hit.\n\n" +
      "**Read multiple hits, not just the top one.** A search commonly returns 3-10 courses covering the same position. Different authors recommend different moves, weight lines differently, and disagree about which sidelines matter — that disagreement is exactly the information you want. Default assumption: read the top 3-5 hits by recency, more if the position is critical (novelty candidate, main-line trunk, sharp tactical junction). Reading only the first hit gives you one author's opinion; reading five gives you the actual state of theory as your user's library sees it.\n\n" +
      "Use it as a reference library, not memory. Query patterns:\n" +
      "  • 'Does my chosen line have coverage?' → search from the position, read multiple hits, see whether the field agrees on the main response.\n" +
      "  • 'What do opposite-colour repertoires recommend against this move?' → search, then read every hit whose author/course maps to the other side.\n" +
      "  • 'Has anyone tried my novelty before?' → search the position, if hits exist read all of them (a novelty that appears in ONE 2019 course is still a novelty to serious opponents; a novelty covered by three 2025 courses is not).\n" +
      "  • 'What are the main disagreements between authors?' → read the top 3-5 hits, diff the recommended moves against each other; if two Chessable authors branch differently at move 8, that's a decision point worth annotating in your own file.\n\n" +
      "Default sort is `recency` (most-recently-updated file first — theory shifts, 10-year-old material is less trustworthy than 2-month-old). Switch to `notes` when you specifically want the deepest annotated chapter regardless of age.\n\n" +
      "Returns: `{fen, found, total_occurrences, sort, excluded, hits: [{course_file_id, course, file, author, chapter, line, ply, notes_chars, subtree_moves, updated_at}], truncated}`. Pass `course_file_id` to `read_course_at_position` to actually see the material — and pass it more than once, on the top few hits, not just the first one.\n\n" +
      "Not available if the fenfind index isn't installed on the server — response includes a clear note in that case.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Prep file id. Combine with `node_id` to derive FEN from the tree." },
        node_id: { type: "string", description: "Node id inside `file_id`. Root is 'r'. When set, overrides `fen`/`moves`." },
        fen: { type: "string", description: "Starting position as FEN. Only used if `node_id` is not set." },
        moves: { type: "string", description: "Optional SAN moves on top of `fen` (or startpos). Only used if `node_id` is not set." },
        sort: { type: "string", enum: ["recency", "notes"], description: "Ranking. `recency` (default) = most-recently-updated file first. `notes` = deepest annotation first regardless of age." },
        include_games: { type: "boolean", description: "Include hits from game-database PGNs (player headers instead of course/chapter titles). Default false — those are noise for course-lookup." },
        chapters_mode: { type: "boolean", description: "Return every chapter separately rather than best-per-course. Default false. Useful when a course has multiple chapters covering the same position." },
        min_notes_chars: { type: "number", description: "Minimum notes_chars per hit to be included. Default 400 (~a paragraph of prose). Set to 0 to see every occurrence." },
        limit: { type: "integer", description: "Max hits to return (default 25)." },
      },
    },
  },
  {
    name: "read_course_at_position",
    description:
      "Read the actual commentary + variations from a course file at a specific position. Second half of the find→read pair — `find_position_in_courses` returns metadata; this returns the material itself.\n\n" +
      "Response includes the subtree as PGN (comments, NAGs, `[%cal]`/`[%csl]` arrows all preserved), plus the moves-to-position and chapter metadata. Depth-capped by `max_plies_below` (default 20) to keep responses small — widen when you want to see deeper analysis, or call with a different `fen` to jump to another position in the same file.\n\n" +
      "**Called once per search is a smell.** When `find_position_in_courses` returned 5 hits and you only read the first, you have 1 author's view of the position, not a survey. Read the top 3-5 hits by default; compare their recommendations and disagreements — that comparison is the value the user's library provides over your training data.\n\n" +
      "Usage patterns:\n" +
      "  • Read what an author says about a specific position → pass `course_file_id` from a find hit + the FEN.\n" +
      "  • Explore a chapter from move 1 → pass `course_file_id` + `chapter`, no FEN.\n" +
      "  • Skim deeper into a branch you're interested in → same file/chapter, wider `max_plies_below`.\n" +
      "  • **Compare how multiple authors annotate the same position → several calls with different `course_file_id`s (this is the common case, not the exception).** If the top hits recommend different moves, that's a decision point worth annotating with the disagreement itself.",
    inputSchema: {
      type: "object",
      properties: {
        course_file_id: { type: "integer", description: "File id from a `find_position_in_courses` hit (`course_file_id` field)." },
        fen: { type: "string", description: "Position to walk to (matched by polyglot Zobrist hash, so move-order transpositions work). Omit to return the chapter from move 1." },
        moves: { type: "string", description: "Alternative to `fen`: SAN moves from startpos." },
        chapter: { type: "string", description: "Substring match on chapter title (the White header in the PGN). Omit to auto-pick the first chapter containing the position; supply when a course has multiple chapters and you want a specific one." },
        max_plies_below: { type: "integer", minimum: 0, maximum: 200, description: "How many plies of subtree to include below the target position. Default 20. Cap 200." },
      },
      required: ["course_file_id"],
    },
  },
  {
    name: "quote_engine_eval",
    description:
      "Return the stored engine eval for a node, or null if that node was never analysed. **Call this before writing prose or NAGs that quote engine numbers** — if it returns null, you have no measurement to cite. Do NOT infer an eval for the node from siblings or children; either analyse it (cloud_analyse with node_id) or omit the number from your prose.\n\n" +
      "Response: `{ ceoEval: { sf: {cp, depth}, lc0: {cp, depth}, nag } | null }`. `cp` is White-POV centipawns as an integer (+20 = +0.20). `nag` is the threshold-derived glyph as a SUGGESTION — promote to a visible NAG via set_nags only when a glyph on that move carries editorial signal.",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "Prep file id." },
        node_id: { type: "string", description: "Node id whose stored eval you want to quote." },
      },
      required: ["id", "node_id"],
    },
  },
  {
    name: "set_tag",
    description:
      "Set or clear a game-level PGN tag (Event, Site, Date, White, Black, Result, or any custom tag). Passing empty string removes the tag. Auto-saves.",
    inputSchema: {
      type: "object",
      properties: {
        id:    { type: "string" },
        key:   { type: "string", description: "Tag key, e.g. 'Event', 'White', 'Date'." },
        value: { type: "string", description: "Tag value. Empty string removes the tag." },
        expected_version: { type: "integer" },
      },
      required: ["id", "key", "value"],
    },
  },
  {
    name: "read_engine_usage_guide",
    description:
      "Returns the full chess.ceo engine-usage guide: when to trust Stockfish (objective truth) vs Lc0 (practical eval), how to read disagreements between them, and how to use Lc0 contempt to find non-objective 'practical' ideas. Call this ONCE per session before running expensive `cloud_analyse` calls or when the user asks WHY the engines gave certain scores. Same content is also available as the `engine_usage_primer` prompt (for clients that surface prompts as slash commands), but many clients do not expose prompts to the model — this tool works everywhere.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_opening_prep_guide",
    description:
      "**CALL WHEN**: the user asks about OPENING PREPARATION — 'prep me against X', 'what should I play vs the Najdorf', 'help me build a repertoire against 1.e4', 'walk this opponent's Sveshnikov'. This guide is chess-and-analysis philosophy, not storage semantics.\n\n" +
      "Covers: why win% is one weight not a verdict, why prep is a two-player game with symmetric information (opponent sees your history too), how sample size and recency change the reading, when 'revealed weaknesses' are actionable vs already patched, how to choose between the GM-classical DB and the main DB, when to combine chesscom/lichess sources with FIDE, the three chess.com profile shapes (consistent / eclectic / split-personality), the reversed-colours scarcity trick, how to calibrate surprise (rare secondary lines inside the existing repertoire, not big first-move switches).\n\n" +
      "Different tool: `read_prep_files_guide` covers the FILE STORAGE feature (how to list/create/save prep files) — call that only when about to manipulate files, not for opening questions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_prep_files_guide",
    description:
      "**CALL WHEN**: you're about to CREATE, LIST, SAVE, or DELETE a prep file — the persistent file storage feature. Not for opening prep philosophy (that's `read_opening_prep_guide`) and not for how to write PGN (that's `read_pgn_authoring_guide`).\n\n" +
      "Covers: the AI Prep folder, when to list vs search vs create (avoid duplicate 'Prep vs Firouzja' files), optimistic locking with `version`, naming conventions for the [Event] tag, node-id addressing basics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_pgn_authoring_guide",
    description:
      "Returns the guide on how to write correct, useful PGN — mainline discipline, variations as moves (never prose describing moves), NAG symbols including novelty ($146), unclear ($13), compensation ($44) and the standard set, ChessBase arrow/coloured-square syntax ([%cal] / [%csl]), and common pitfalls the parser will reject. Call this ONCE per session before any save_prep_file call, or any time you're producing PGN output for the user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_example_prep_files",
    description:
      "**CALL WHEN**: about to write ANY prose commentary in a prep file, ever. Even one comment. Even one variation. This is not optional and not once-per-project — call it early in the session and read the examples before your first `set_comment` or `apply_mutations` batch that includes comments. Log analysis showed <5% of sessions call this despite it being the single biggest quality lift documented in this MCP; that's the mistake this description is trying to fix.\n\n" +
      "Why: `read_pgn_authoring_guide` tells you the rules in prose. These files show you the *sound* of them applied by a strong human coach — comment density (short and load-bearing, not verbose), how citations look in-line (`WeiYi-Svidler` not `\"Svidler's choice at the FIDE World Blitz Team, June 2026\"`), when `$146` / `$3` / `$44` earn their place, when a bare `[%csl Rf7]` says everything a sentence would say. LLMs default to florid, restate-what's-visible commentary; reading these once inoculates against that.\n\n" +
      "Two files bundled with the MCP (not the user's own): one general opening overview (Italian Fried Liver, both sides, 1600+ audience) and one one-sided repertoire (Najdorf 6.f4 for White, 2200+ audience). Response: `{ overview: <pgn>, repertoire: <pgn> }` — raw PGN with comments, arrows, NAGs, stored evals intact.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prep_snapshot",
    description:
      "One call, three parallel fetches at the same position: opponent's stats on their side, your stats on your side, and the 11.7M-game general database at that position. Use this while walking the opening tree — one round trip instead of three separate calls, and you can compare the three views directly (e.g. opponent has 2 games here but the general DB has 8k → prep candidate).\n\n" +
      "AUTO-EVAL: if a cloud combo instance is running, the response includes a top-level `.eval` (Stockfish + Lc0 read at the shared position) so you get four signals in one call. Do NOT fire cloud_analyse separately for the same FEN.",
    inputSchema: {
      type: "object",
      properties: {
        fide_id_me: { type: "integer", description: "Your FIDE ID." },
        fide_id_opponent: { type: "integer", description: "Opponent's FIDE ID." },
        my_color: { type: "string", enum: ["white", "black"], description: "The colour YOU will play." },
        file_id: { type: "string", description: "Prep file id. **Prefer file_id+node_id** when inside a prep file." },
        node_id: { type: "string", description: "Node id inside `file_id`. When set, overrides `line`/`fen`." },
        line: {
          type: "string",
          description:
            "Move sequence in SAN, space-separated. Empty = starting position. Only used if `node_id` is not set.",
        },
        fen: {
          type: "string",
          description: "Alternative to line — raw FEN of the target position. Only used if `node_id` is not set.",
        },
      },
      required: ["fide_id_me", "fide_id_opponent", "my_color"],
    },
  },
];
