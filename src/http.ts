// HTTP + PGN I/O layer for chessceo-mcp. Auth resolution, raw
// `authedRequest` / `get`, response envelope helpers, and the
// small typed wrappers every prep-file tool composes over
// (`fetchGame` / `saveGame` / `createGame` / `deleteGame` /
// `restoreGame`).
//
// Two auth flavours coexist:
//   - Anonymous GETs (players, positions, prep, live) — no auth.
//   - Authed tools (cloud engines, prep files) — `Authorization: Bearer mcp_...`.
//
// The token comes from one of two sources:
//   - stdio: `CHESSCEO_TOKEN` env var, set by the MCP host config. Bare
//     `mcp_...` — we prepend the `Bearer ` scheme when building the header.
//   - streamable-http: the caller's `Authorization` header, forwarded
//     per-request via AsyncLocalStorage so tool handlers can see it even
//     though the MCP SDK's request handler doesn't know about HTTP.
//
// LLM-facing "prep file id" is always "<collection_id>:<game_id>" —
// `makeFileId` to compose from a listing, `splitFileId` at the HTTP edge.
// This is what makes every prep-file tool keep taking a single `id`
// argument despite the backend paths needing both pieces.

import { AsyncLocalStorage } from "node:async_hooks";

const BASE = process.env.CHESSCEO_BASE_URL ?? "https://chess.ceo";
const UA = `chessceo-mcp/${process.env.npm_package_version ?? "0.1.0"} (+https://chess.ceo)`;

export const PGN_BASE = "/api/agent/pgns";

// Streamable-HTTP transport binds the caller's Authorization header
// into this context so per-request tool handlers can pick it up.
// Stdio callers don't set this — they hit the env-var branch below.
export const authContext = new AsyncLocalStorage<{ authHeader: string | undefined }>();

export function resolveAuthHeader(): string | undefined {
  const store = authContext.getStore();
  if (store?.authHeader) return store.authHeader;
  const env = process.env.CHESSCEO_TOKEN?.trim();
  if (!env) return undefined;
  return env.toLowerCase().startsWith("bearer ") ? env : `Bearer ${env}`;
}

export async function get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) {
    // Bubble up the ProblemDetail body when the API returns one — LLM can
    // then correct the query (e.g. wrong fideId) rather than retry blind.
    let body: string;
    try { body = await res.text(); } catch { body = ""; }
    throw new Error(`chess.ceo ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// authedRequest is the shared code path for POST/GET/DELETE calls that need
// an MCP token. Missing-token errors are surfaced early with a message the
// LLM can act on (either configure CHESSCEO_TOKEN or generate a token in
// user settings) rather than a generic 401 from the backend.
export async function authedRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = resolveAuthHeader();
  if (!auth) {
    throw new Error(
      "No MCP token available. Set CHESSCEO_TOKEN env (stdio mode) or pass an " +
        "Authorization: Bearer mcp_... header (streamable-http mode). Generate " +
        "a token at chess.ceo → user settings → MCP tokens.",
    );
  }
  const url = new URL(path, BASE);
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Authorization": auth,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`chess.ceo ${res.status}: ${text.slice(0, 500)}`);
  }
  return text.length ? JSON.parse(text) : null;
}

// Browser handlers wrap successful responses as
//   { success: true, message: "...", data: <actual thing> }
// via handlers.RespondSuccess. Peel that off; leave anything without
// the envelope unchanged (some endpoints return raw bodies).
export function unwrap<T = unknown>(raw: unknown): T {
  if (
    raw &&
    typeof raw === "object" &&
    "data" in raw &&
    (raw as { success?: boolean }).success === true
  ) {
    return (raw as { data: T }).data;
  }
  return raw as T;
}

export function makeFileId(collectionId: string, gameId: string): string {
  return `${collectionId}:${gameId}`;
}
export function splitFileId(id: string): { collectionId: string; gameId: string } {
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) {
    throw new Error(
      `invalid prep file id "${id}" — expected "<collection_id>:<game_id>" ` +
        `(get one from list_prep_files, search_prep_files, find_position_in_files, ` +
        `or the create_prep_file return value)`,
    );
  }
  return { collectionId: id.slice(0, idx), gameId: id.slice(idx + 1) };
}

// Minimal shape of a PGN game as the browser handler returns it. The
// backend model has more fields; we only care about the ones the MCP
// wrapper touches.
export type PgnGame = {
  id: string;
  collectionId: string;
  pgnContent: string;
  version: number;
  event?: string;
  white_player?: string;
  black_player?: string;
  tags?: Record<string, unknown>;
  updated_at?: string;
};

// GET one game by composite id. Throws on 404.
export async function fetchGame(id: string): Promise<PgnGame> {
  const { collectionId, gameId } = splitFileId(id);
  const raw = await authedRequest(
    "GET",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games/${encodeURIComponent(gameId)}`,
  );
  const g = unwrap<PgnGame>(raw);
  if (!g || typeof g.pgnContent !== "string") {
    throw new Error("prep file missing pgnContent");
  }
  return g;
}

// PUT the game body. Returns the saved game (new version).
export async function saveGame(
  id: string,
  pgn: string,
  expectedVersion: number | undefined,
): Promise<PgnGame> {
  const { collectionId, gameId } = splitFileId(id);
  const body: Record<string, unknown> = { pgnContent: pgn };
  if (typeof expectedVersion === "number") body.baseVersion = expectedVersion;
  const raw = await authedRequest(
    "PUT",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games/${encodeURIComponent(gameId)}`,
    body,
  );
  return unwrap<PgnGame>(raw);
}

// POST a new game into the given collection. Returns the created game.
export async function createGame(collectionId: string, pgn: string): Promise<PgnGame> {
  const raw = await authedRequest(
    "POST",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games`,
    { pgnContent: pgn },
  );
  return unwrap<PgnGame>(raw);
}

// DELETE (soft) a game by composite id.
export async function deleteGame(id: string): Promise<void> {
  const { collectionId, gameId } = splitFileId(id);
  await authedRequest(
    "DELETE",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games/${encodeURIComponent(gameId)}`,
  );
}

// Restore a previously soft-deleted game. Symmetric with deleteGame.
export async function restoreGame(id: string): Promise<PgnGame> {
  const { collectionId, gameId } = splitFileId(id);
  const raw = await authedRequest(
    "POST",
    `${PGN_BASE}/${encodeURIComponent(collectionId)}/games/${encodeURIComponent(gameId)}/restore`,
  );
  return unwrap<PgnGame>(raw);
}
