// Discovery + creation over the user's full PGN library. v0.43 removed
// the hidden `/mcp`-folder scoping; every function here now reaches
// across every non-encrypted collection the user owns.
//
// Extracted from index.ts in v0.44 as part of the file split.

import {
  authedRequest,
  createGame,
  makeFileId,
  PGN_BASE,
  unwrap,
} from "../http.js";
import { resolveFromNodeOrFen } from "../analysis/file_handle.js";

type Args = Record<string, unknown>;

type PgnCollection = {
  id: string;
  title: string;
  icon?: string;
  folderPath?: string;
  gameCount?: number;
  positionSearchEnabled?: boolean;
  updatedAt?: string;
};

type PgnGameListRow = {
  id: string;
  collectionId?: string;
  collectionTitle?: string;
  event?: string;
  white_player?: string;
  black_player?: string;
  eco?: string;
  opening?: string;
  updated_at?: string;
  ply?: number;
};

export async function listCollections(_args: Args): Promise<unknown> {
  const raw = await authedRequest("GET", PGN_BASE);
  const collections = unwrap<PgnCollection[]>(raw) ?? [];
  return {
    collections: collections.map(c => ({
      id: c.id,
      title: c.title,
      icon: c.icon,
      folder_path: c.folderPath,
      game_count: c.gameCount,
      position_search_enabled: c.positionSearchEnabled,
      updated_at: c.updatedAt,
    })),
  };
}

// Convert a browser-returned game list row into the LLM shape (composite
// id, cleaned field names).
function projectGameRow(row: PgnGameListRow): Record<string, unknown> {
  const collId = row.collectionId ?? "";
  return {
    id: collId ? makeFileId(collId, row.id) : row.id,
    collection_id: collId,
    collection_title: row.collectionTitle,
    event: row.event,
    white: row.white_player,
    black: row.black_player,
    eco: row.eco,
    opening: row.opening,
    updated_at: row.updated_at,
    ply: row.ply,
  };
}

export async function listPrepFiles(args: Args): Promise<unknown> {
  const collectionId = typeof args.collection_id === "string" ? args.collection_id.trim() : "";
  if (!collectionId) {
    throw new Error(
      "collection_id required — call list_collections to see your options, or search across collections with search_prep_files / find_position_in_files",
    );
  }
  // Browser handler at GET /me/pgns/{id}/games returns a paginated list.
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games?page=1&limit=200`,
  );
  const data = unwrap<{ games?: PgnGameListRow[]; pagination?: unknown }>(raw);
  const games = data?.games ?? (Array.isArray(data) ? (data as PgnGameListRow[]) : []);
  return { collection_id: collectionId, prep_files: games.map(projectGameRow) };
}

export async function searchPrepFiles(args: Args): Promise<unknown> {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (!q) throw new Error("query required");
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/games/search?q=${encodeURIComponent(q)}&limit=100`,
  );
  const data = unwrap<{ games?: PgnGameListRow[] }>(raw);
  const games = data?.games ?? [];
  return { query: q, prep_files: games.map(projectGameRow) };
}

export async function findPositionInFiles(args: Args): Promise<unknown> {
  // FEN can come from a node handle OR a direct fen/moves/line. Reuse
  // the same resolver everything else uses.
  const resolved = await resolveFromNodeOrFen(args);
  const fen = resolved.fen;
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/games/search?position=${encodeURIComponent(fen)}&limit=100`,
  );
  const data = unwrap<{ games?: PgnGameListRow[] }>(raw);
  const games = data?.games ?? [];
  return {
    fen,
    match_count: games.length,
    prep_files: games.map(projectGameRow),
  };
}

export async function createPrepFile(args: Args): Promise<unknown> {
  const collectionId = typeof args.collection_id === "string" ? args.collection_id.trim() : "";
  if (!collectionId) {
    throw new Error(
      "collection_id required — call list_collections to pick where the new file lives. There is no default landing folder any more (v0.43: the old hidden /mcp collection was removed).",
    );
  }
  const name = String(args.name || "").trim();
  if (!name) throw new Error("name is required");
  // Seed with a PGN carrying the LLM-chosen name as the Event tag so
  // subsequent list_prep_files calls display something useful.
  const seedPgn = `[Event "${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]\n\n*\n`;
  const game = await createGame(collectionId, seedPgn);
  return {
    ok: true,
    id: makeFileId(game.collectionId ?? collectionId, game.id),
    collection_id: game.collectionId ?? collectionId,
    version: game.version,
  };
}
