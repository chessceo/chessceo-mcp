// Subprocess wrappers for two Python-backed helpers:
//   - fenfind / readpgn — polyglot Zobrist search over the user's
//     Chessable / PGN course library (the `find_position_in_courses`
//     and `read_course_at_position` tools).
//   - sf_eval — spawns local stockfish, parses its `eval` verbose
//     output (the eval-terms leg of `describe_position`).
//
// Both live outside the pure-TS MCP because they reuse Python code
// (python-chess for polyglot hashing / PGN parsing; the local
// stockfish binary for eval terms) that porting to TS would just
// duplicate.
//
// Extracted from index.ts in v0.44 as part of the file split.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFromNodeOrFen } from "./analysis/file_handle.js";

type Args = Record<string, unknown>;

// Path to sf_eval helper (spawns local stockfish, parses its `eval`
// verbose output). SF_EVAL_PATH env overrides the bundled tools/sf_eval/
// directory.
const SF_EVAL_SCRIPT: string | null = (() => {
  const envPath = process.env.SF_EVAL_PATH?.trim();
  if (envPath && existsSync(join(envPath, "sf_eval"))) return join(envPath, "sf_eval");
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "tools", "sf_eval", "sf_eval");
  return existsSync(bundled) ? bundled : null;
})();

const SF_EVAL_TIMEOUT_MS = 12_000;

export async function runSfEval(fen: string): Promise<unknown> {
  if (!SF_EVAL_SCRIPT) {
    return {
      found: false,
      error: "sf_eval script not bundled; set SF_EVAL_PATH or install tools/sf_eval/",
    };
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    const p = spawn(SF_EVAL_SCRIPT!, ["--fen", fen], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => { out += d.toString("utf8"); });
    p.stderr.on("data", d => { err += d.toString("utf8"); });
    const to = setTimeout(() => {
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error(`sf_eval timed out after ${SF_EVAL_TIMEOUT_MS}ms`));
    }, SF_EVAL_TIMEOUT_MS);
    p.on("error", e => { clearTimeout(to); reject(e); });
    p.on("close", code => {
      clearTimeout(to);
      if (code !== 0) reject(new Error(`sf_eval exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
  });
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`sf_eval returned non-JSON output (${e instanceof Error ? e.message : String(e)}): ${stdout.slice(0, 300)}`);
  }
}

// Path resolution order (`FENFIND_PATH` env var overrides):
//   1. $FENFIND_PATH/fenfind
//   2. <package-root>/tools/fenfind/fenfind (ships with the npm package)
// The bash wrapper picks a python interpreter with python-chess
// available (venv at $here/.venv/bin/python preferred, then falls back
// to system python3). DB path is resolved inside fenfind.py itself
// (FENFIND_DB env, then ~/positions.db).
const FENFIND_DIR: string | null = (() => {
  const envPath = process.env.FENFIND_PATH?.trim();
  if (envPath && existsSync(join(envPath, "fenfind"))) return envPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "tools", "fenfind");
  return existsSync(join(bundled, "fenfind")) ? bundled : null;
})();

// Cap on how long we let the subprocess run. SQLite hash lookup returns
// sub-second; PGN read from a course file is O(chapter size) and rarely
// exceeds a second. 15s is a stuck-process backstop, not a real limit.
const FENFIND_TIMEOUT_MS = 15_000;

async function runFenfindScript(scriptName: "fenfind" | "readpgn", args: string[]): Promise<string> {
  if (!FENFIND_DIR) {
    throw new Error("fenfind index not installed — set FENFIND_PATH or install the tools/fenfind bundle");
  }
  const script = join(FENFIND_DIR, scriptName);
  return new Promise<string>((resolve, reject) => {
    const p = spawn(script, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => { out += d.toString("utf8"); });
    p.stderr.on("data", d => { err += d.toString("utf8"); });
    const to = setTimeout(() => {
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error(`${scriptName} timed out after ${FENFIND_TIMEOUT_MS}ms`));
    }, FENFIND_TIMEOUT_MS);
    p.on("error", e => { clearTimeout(to); reject(e); });
    p.on("close", code => {
      clearTimeout(to);
      if (code !== 0) reject(new Error(`${scriptName} exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
  });
}

function parseFenfindJson(scriptName: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`${scriptName} returned non-JSON output (${e instanceof Error ? e.message : String(e)}): ${stdout.slice(0, 300)}`);
  }
}

export async function findPositionInCourses(args: Args): Promise<unknown> {
  if (!FENFIND_DIR) {
    return {
      status: "not_available",
      note: "fenfind index not installed on this server. Set FENFIND_PATH env var to the directory containing the `fenfind` script and positions.db, or install the tools/fenfind bundle shipped in the npm package.",
    };
  }

  const resolved = await resolveFromNodeOrFen(args);
  const cliArgs: string[] = [resolved.fen, "--json"];
  if (typeof args.sort === "string" && (args.sort === "recency" || args.sort === "notes")) {
    cliArgs.push("--sort", args.sort);
  }
  if (args.include_games) cliArgs.push("--games");
  if (args.chapters_mode) cliArgs.push("--chapters");
  if (typeof args.min_notes_chars === "number") cliArgs.push("--min", String(args.min_notes_chars));
  if (typeof args.limit === "number") cliArgs.push("-n", String(args.limit));

  const stdout = await runFenfindScript("fenfind", cliArgs);
  return parseFenfindJson("fenfind", stdout);
}

export async function readCourseAtPosition(args: Args): Promise<unknown> {
  if (!FENFIND_DIR) {
    return {
      status: "not_available",
      note: "fenfind index not installed on this server. Set FENFIND_PATH env var to the directory containing the `fenfind`/`readpgn` scripts and positions.db.",
    };
  }
  const fileId = typeof args.course_file_id === "number" ? args.course_file_id : Number(args.course_file_id);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    throw new Error("`course_file_id` is required — pass the value from a find_position_in_courses hit");
  }
  const cliArgs: string[] = ["--file-id", String(fileId)];
  if (typeof args.fen === "string" && args.fen.trim() !== "") cliArgs.push("--fen", args.fen.trim());
  if (typeof args.moves === "string" && args.moves.trim() !== "") cliArgs.push("--moves", args.moves.trim());
  if (typeof args.chapter === "string" && args.chapter.trim() !== "") cliArgs.push("--chapter", args.chapter.trim());
  if (typeof args.max_plies_below === "number") cliArgs.push("--max-plies-below", String(args.max_plies_below));

  const stdout = await runFenfindScript("readpgn", cliArgs);
  return parseFenfindJson("readpgn", stdout);
}
