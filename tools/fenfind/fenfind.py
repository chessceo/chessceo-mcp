#!/usr/bin/env python3
"""Find which courses/chapters cover a position.

  fenfind.py "<FEN>"                        look up a position
  fenfind.py -m "1.e4 c5 2.Nf3 d6"          give moves instead of a FEN
  fenfind.py -m "..." --courses             only files mapped to a known course
  fenfind.py -m "..." --all                 don't hide thin entries
  fenfind.py -m "..." --chapters            list every chapter, not best-per-file
  fenfind.py -m "..." --min 500             custom "worth reading" threshold (note chars)

Ranking: entries are sorted by how much ANNOTATED material sits below the
position at that point -- i.e. words of explanation first, moves second.  A
chapter that merely passes through the position on its way somewhere else
ranks last, which is the whole point.
"""
import chess, chess.polyglot as zbl, sqlite3, argparse, re, os, json, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('FENFIND_DB') or next(
    (p for p in (os.path.join(HERE, 'positions.db'),
                 os.path.expanduser('~/chess/positions.db'),
                 os.path.expanduser('~/positions.db')) if os.path.exists(p)),
    os.path.join(HERE, 'positions.db'))

def board_from_moves(s):
    b = chess.Board()
    for tok in re.sub(r'\d+\.(\.\.)?', ' ', s).split():
        if tok in ('*', '1-0', '0-1', '1/2-1/2'):
            continue
        try:
            b.push_san(tok)
        except Exception:
            raise SystemExit(f"illegal/unparsable move: {tok}")
    return b

def looks_like_gamedb(chapter, line):
    """Game collections put player names in the header; courses put chapter titles.
    'Surname, Firstname' in both slots is the giveaway."""
    return bool(re.match(r'^[A-Z][\w.\'-]+,\s*[A-Z]', chapter or '')) and \
           bool(re.match(r'^[A-Z][\w.\'-]+,\s*[A-Z]', line or ''))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pos')
    ap.add_argument('-m', '--moves', action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--courses', action='store_true')
    ap.add_argument('--chapters', action='store_true')
    ap.add_argument('--games', action='store_true', help='include game-database hits')
    ap.add_argument('--min', type=float, default=400)
    ap.add_argument('-n', type=int, default=25)
    ap.add_argument('--sort', choices=['recency', 'notes'], default='recency',
                    help='ranking: recency (default, most recently updated file first) or notes (annotation depth, notes_chars desc)')
    ap.add_argument('--json', action='store_true', help='emit structured JSON on stdout instead of the text table (used by the MCP wrapper)')
    a = ap.parse_args()

    b = board_from_moves(a.pos) if a.moves else chess.Board(
        a.pos if len(a.pos.split()) >= 6 else a.pos + ' 0 1')
    z = zbl.zobrist_hash(b)
    if z >= (1 << 63):
        z -= (1 << 64)

    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        """SELECT f.id AS file_id,f.name,f.path,f.course,f.author,o.chapter,o.line,o.ply,o.subtree,o.chars
           FROM occ o JOIN files f ON f.id=o.file_id WHERE o.z=?""", (z,))]
    if not rows:
        if a.json:
            json.dump({"fen": b.fen(), "found": False, "total_occurrences": 0, "hits": []}, sys.stdout)
            print()
            return
        print("position not found in the collection"); return
    total = len(rows)

    # Attach file mtime for recency ranking. Cheap — one stat() per row,
    # done here rather than at index time so re-indexing isn't required
    # for the recency signal to work.
    for r in rows:
        try:
            r['mtime'] = os.path.getmtime(r['path'])
        except OSError:
            r['mtime'] = 0

    ngame = 0
    if not a.games:
        keep = [r for r in rows if not looks_like_gamedb(r['chapter'], r['line'])]
        ngame = len(rows) - len(keep); rows = keep
    ncourse = 0
    if a.courses:
        keep = [r for r in rows if r['course']]
        ncourse = len(rows) - len(keep); rows = keep

    # collapse duplicate FILES: "Foo.pgn", "Foo (2).pgn" and re-exports of the same
    # course produce byte-identical hits -- keep one, remember how many copies.
    def norm_file(n):
        return re.sub(r'\s*\(\d+\)(?=\.pgn$)', '', n).lower()
    for r in rows:
        r['key'] = (r['course'] or norm_file(r['name']))

    if a.chapters:
        groups = {}
        for r in rows:
            k = (r['key'], r['chapter'])
            if k not in groups or r['chars'] > groups[k]['chars']:
                groups[k] = r
    else:
        groups = {}                       # best chapter per course/file
        for r in rows:
            k = r['key']
            if k not in groups or (r['chars'], r['subtree']) > (groups[k]['chars'], groups[k]['subtree']):
                groups[k] = r

    # Ranking. `recency` (default) sorts by file mtime desc — 2-month-old
    # material beats 10-year-old on the assumption that theory shifts. Ties
    # broken by notes_chars so a deep chapter beats a thin one at the same
    # mtime. `notes` sorts by annotation depth alone, useful when the
    # question is "who explains this best regardless of age".
    if a.sort == 'notes':
        hits = sorted(groups.values(), key=lambda r: (-r['chars'], -r['subtree']))
    else:  # recency
        hits = sorted(groups.values(), key=lambda r: (-r['mtime'], -r['chars']))
    shown = hits if a.all else [h for h in hits if h['chars'] >= a.min]
    thin = len(hits) - len(shown)

    import datetime as _dt
    def _updated_at(ts):
        if not ts:
            return None
        return _dt.date.fromtimestamp(ts).isoformat()

    if a.json:
        # Structured output for the MCP wrapper. Field names spelled out
        # so the LLM reader doesn't need to know the SQLite column names.
        payload = {
            "fen": b.fen(),
            "found": True,
            "total_occurrences": total,
            "sort": a.sort,
            "excluded": {
                "game_db_hits": ngame,
                "unmapped_files": ncourse,
                "thin_entries_below_min": thin,
                "min_notes_chars": a.min,
            },
            "hits": [
                {
                    "course_file_id": h['file_id'],  # opaque handle; pass to read_course_at_position
                    "course": h['course'] or None,
                    "file":   h['name'],
                    "author": h['author'] or None,
                    "chapter": h['chapter'] or None,
                    "line":    h['line'] or None,
                    "ply":     h['ply'],
                    "notes_chars":   h['chars'],
                    "subtree_moves": h['subtree'],
                    "updated_at":    _updated_at(h['mtime']),
                }
                for h in shown[:a.n]
            ],
            "truncated": max(0, len(shown) - a.n),
        }
        json.dump(payload, sys.stdout, ensure_ascii=False)
        print()
        return

    print(f"\nposition: {b.fen()}")
    note = [f"{total:,} indexed occurrences"]
    if ngame:   note.append(f"{ngame:,} game-db hits excluded (--games to keep)")
    if ncourse: note.append(f"{ncourse:,} unmapped files excluded")
    note.append(f"{len(hits):,} distinct {'chapters' if a.chapters else 'courses'}")
    if thin:    note.append(f"{thin:,} thin entries hidden (--all to show)")
    print("  " + "\n  ".join(note) + "\n")

    print(f"{'notes':>7} {'moves':>6} {'ply':>4}   course")
    print("-" * 96)
    for h in shown[:a.n]:
        title = h['course'] or h['name'][:-4]
        who = f"  [{h['author']}]" if h['author'] else ''
        print(f"{h['chars']:>7} {h['subtree']:>6} {h['ply']:>4}   {title[:70]}{who}")
        ch = h['chapter'] or '?'
        extra = f"   |  {h['line']}" if h['line'] and h['line'] != ch else ''
        print(f"{'':>19}   ch: {ch}{extra}")
    if len(shown) > a.n:
        print(f"\n... {len(shown)-a.n:,} more (-n to raise the limit)")

main()
