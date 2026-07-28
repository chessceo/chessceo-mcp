// MCP prompt schemas. Pre-baked slash-menu entries that LLM hosts surface;
// users pick one and templated content lands in the conversation. Content
// rendering (PREP_WORKFLOW etc.) still lives in index.ts.
//
// Extracted from index.ts in v0.44.

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

export const PROMPTS: Prompt[] = [
  {
    name: "prepare_for_game",
    description:
      "Prep workflow for an upcoming chess game. Walks both players' repertoires and identifies where the opponent is weakest.",
    arguments: [
      { name: "me", description: "Your name (or FIDE ID)", required: true },
      { name: "opponent", description: "Opponent's name (or FIDE ID)", required: true },
      { name: "my_color", description: "The color you'll be playing: 'white' or 'black'. Optional — if you don't know yet, ask.", required: false },
      { name: "time_control", description: "Optional: 'classical', 'rapid', 'blitz'. Weights which of the opponent's games matter most.", required: false },
    ],
  },
  {
    name: "scout_player",
    description:
      "Deep scouting report on one player. Their style, top openings, recent form, and where they've been beaten.",
    arguments: [
      { name: "player", description: "Player name or FIDE ID", required: true },
    ],
  },
  {
    name: "head_to_head_briefing",
    description:
      "Briefing on the history between two players — who has the edge, what openings decide their meetings, style clash.",
    arguments: [
      { name: "player_a", description: "First player (name or FIDE ID)", required: true },
      { name: "player_b", description: "Second player (name or FIDE ID)", required: true },
    ],
  },
  {
    name: "engine_usage_primer",
    description:
      "Full guide on how to use the chess.ceo cloud engines — Stockfish vs Lc0 tradeoffs, when to trust which, how to read disagreements, and how to use Lc0 contempt to find practical ideas. Read before running expensive cloud_analyse calls or when the user asks WHY the engines gave certain scores.",
    arguments: [],
  },
  {
    name: "prep_strategy_primer",
    description:
      "Full guide on how to reason about opening preparation — why win% is one weight not a rule, why prep is a two-player game with symmetric information, when 'revealed weaknesses' are actionable, how to use move-order tricks, and how to calibrate surprise. Read before recommending an opening plan, especially when the user is preparing for a specific real opponent.",
    arguments: [],
  },
];
