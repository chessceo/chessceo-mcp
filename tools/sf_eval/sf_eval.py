#!/usr/bin/env python3
"""Stockfish `eval` verbose output → structured JSON.

Wraps the Stockfish classical-eval breakdown (13 named contributing
terms per colour, mg/eg values, plus the total) so the LLM can reason
about WHY a position is what it is instead of just the final number.

Recipe from Kim et al. NAACL 2025 "Concept-guided Chess Commentary"
(arxiv 2410.20811): feeding these named term values to an LLM roughly
doubles chess-commentary correctness. The comparison-across-moves
delta (which term shifted most) is the primary signal — the LLM can
compute it by calling twice.

Uses only stdlib (subprocess + regex parsing of the ASCII table
Stockfish prints for `eval`). No python-chess dependency; system
python3 is enough.

  sf_eval.py --fen "<FEN>"
  sf_eval.py --fen "<FEN>" --stockfish-bin /usr/games/stockfish
"""
import argparse, json, os, re, subprocess, sys


DEFAULT_BIN = os.environ.get('SF_EVAL_BIN') or '/usr/games/stockfish'

# Rows look like:  |   Material |  ----  ---- |  ----  ---- |  0.30  0.17 |
# with "----" for the material / imbalance rows (NNUE substitutes for
# per-colour, only the totals are printed).
ROW_RE = re.compile(r'^\|\s*([A-Za-z][A-Za-z ]*?)\s*\|(.*?)\|(.*?)\|(.*?)\|$')


def parse_pair(s: str):
    """Parse '0.13 -0.02' → (0.13, -0.02); '---- ----' → (None, None)."""
    parts = s.strip().split()
    if len(parts) < 2 or parts[0].startswith('-'*3):
        return None, None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None, None


def parse_eval(text: str) -> dict:
    """Extract the "Contributing terms for the classical eval" table.
    Returns {terms: {term_name: {white_mg, white_eg, black_mg, black_eg,
    total_mg, total_eg}}, total: {mg, eg}}."""
    terms = {}
    total = None
    in_table = False
    for raw in text.splitlines():
        if 'Contributing terms' in raw:
            in_table = True
            continue
        if not in_table:
            continue
        if '+---' in raw:
            continue
        m = ROW_RE.match(raw)
        if not m:
            # Blank line after the closing +---+ ends the section.
            if raw.strip() == '':
                break
            continue
        name = m.group(1).strip()
        # Header row "|    Term    |..." isn't a data row; parse_pair returns None.
        w_mg, w_eg = parse_pair(m.group(2))
        b_mg, b_eg = parse_pair(m.group(3))
        t_mg, t_eg = parse_pair(m.group(4))
        if name.lower() == 'term':
            continue
        if name.lower() == 'total':
            total = {'mg': t_mg, 'eg': t_eg}
            continue
        terms[name.lower().replace(' ', '_')] = {
            'white_mg': w_mg, 'white_eg': w_eg,
            'black_mg': b_mg, 'black_eg': b_eg,
            'total_mg': t_mg, 'total_eg': t_eg,
        }
    return {'terms': terms, 'total': total}


def run_stockfish(bin_path: str, fen: str) -> str:
    """Send position + eval + quit; return combined stdout."""
    cmds = f"position fen {fen}\neval\nquit\n"
    p = subprocess.run(
        [bin_path],
        input=cmds,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if p.returncode != 0:
        raise RuntimeError(f"stockfish exited {p.returncode}: {p.stderr.strip() or p.stdout[-200:]}")
    return p.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fen', required=True)
    ap.add_argument('--stockfish-bin', default=DEFAULT_BIN,
                    help=f'path to stockfish binary (default: $SF_EVAL_BIN or {DEFAULT_BIN})')
    a = ap.parse_args()

    if not os.path.exists(a.stockfish_bin):
        json.dump({
            "found": False,
            "error": f"stockfish binary not at {a.stockfish_bin} — install stockfish or set SF_EVAL_BIN",
        }, sys.stdout); print()
        return

    try:
        text = run_stockfish(a.stockfish_bin, a.fen)
    except subprocess.TimeoutExpired:
        json.dump({"found": False, "error": "stockfish eval timed out (10s)"}, sys.stdout); print()
        return
    except Exception as e:
        json.dump({"found": False, "error": f"stockfish invocation failed: {e}"}, sys.stdout); print()
        return

    payload = parse_eval(text)
    if not payload['terms']:
        json.dump({
            "found": False,
            "fen": a.fen,
            "error": "no eval terms parsed — stockfish output may have changed format",
            "raw_head": text[:400],
        }, sys.stdout); print()
        return

    payload['found'] = True
    payload['fen'] = a.fen
    payload['stockfish_bin'] = a.stockfish_bin
    json.dump(payload, sys.stdout, ensure_ascii=False); print()


main()
