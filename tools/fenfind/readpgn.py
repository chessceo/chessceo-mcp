#!/usr/bin/env python3
"""Read a PGN chapter's subtree at a position — the READ half of fenfind.

  readpgn.py --file-id 1528 --fen "<FEN>"       subtree at that position
  readpgn.py --file-id 1528                     whole file from move 1
  readpgn.py --file-id 1528 --chapter "..." --fen "..."   pick a specific chapter
  readpgn.py --file-id 1528 --fen "..." --max-plies-below 40    deeper subtree

Emits JSON with the matching chapter's metadata and its subtree at the
requested position as PGN text (comments, NAGs, arrows preserved).
Depth-capped to keep responses small; the LLM can widen `max_plies_below`
or walk to a different position to explore further.

Position resolution: FEN is matched by polyglot Zobrist hash (same as
fenfind), so move-order transpositions still find the right node.
"""
import chess, chess.pgn, chess.polyglot as zbl, sqlite3, argparse, os, sys, json, io

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('FENFIND_DB') or next(
    (p for p in (os.path.join(HERE, 'positions.db'),
                 os.path.expanduser('~/chess/positions.db'),
                 os.path.expanduser('~/positions.db')) if os.path.exists(p)),
    os.path.join(HERE, 'positions.db'))


def find_node_by_hash(game, target_hash):
    """DFS from game root; return the first node whose position hashes to
    target_hash. Match on Zobrist so move-order variants (transpositions)
    of the same position still find each other."""
    board = game.board()
    stack = [(game, board.copy(), iter(game.variations))]
    while stack:
        node, bd, iter_children = stack[-1]
        if zbl.zobrist_hash(bd) == target_hash:
            return node, bd
        try:
            child = next(iter_children)
        except StopIteration:
            stack.pop()
            continue
        child_board = bd.copy()
        try:
            child_board.push(child.move)
        except Exception:
            continue
        stack.append((child, child_board, iter(child.variations)))
    return None, None


def truncate_subtree(source_node, target_node, max_plies_below):
    """Build a new Game rooted at target_node's position, copying the
    subtree from target_node up to `max_plies_below` plies deep. Comments,
    NAGs, and (implicitly via chess.pgn) [%cal]/[%csl] tags inside comments
    are preserved. Headers are carried over from the source game."""
    from chess.pgn import Game
    new = Game()
    for k, v in source_node.headers.items():
        new.headers[k] = v
    # If we're not starting from the game root, set the FEN header so
    # the exported PGN is standalone-parseable.
    if target_node.parent is not None:
        setup_board = target_node.board()
        new.headers['FEN'] = setup_board.fen()
        new.headers['SetUp'] = '1'
    if target_node.comment:
        new.comment = target_node.comment
    if target_node.nags:
        new.nags = set(target_node.nags)

    def copy_children(src, dst, depth_remaining):
        if depth_remaining <= 0:
            return
        for v in src.variations:
            child = dst.add_variation(v.move)
            if v.comment:
                child.comment = v.comment
            if v.nags:
                child.nags = set(v.nags)
            copy_children(v, child, depth_remaining - 1)

    copy_children(target_node, new, max_plies_below)
    return new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file-id', type=int, required=True)
    ap.add_argument('--fen', default=None,
                    help='FEN to walk to. Omit to return the chapter from move 1.')
    ap.add_argument('--moves', default=None,
                    help='SAN moves from startpos, alternative to --fen.')
    ap.add_argument('--chapter', default=None,
                    help='Substring match on the game White header (usually the chapter title). Omit to match the first game containing the position.')
    ap.add_argument('--max-plies-below', type=int, default=20,
                    help='How deep to include the subtree below the target position. Cap at 200.')
    a = ap.parse_args()

    max_below = max(0, min(200, a.max_plies_below))

    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    row = con.execute("SELECT path, name, course, author FROM files WHERE id=?", (a.file_id,)).fetchone()
    if not row:
        json.dump({"found": False, "error": f"unknown file_id={a.file_id}"}, sys.stdout); print()
        return
    path, name, course, author = row['path'], row['name'], row['course'], row['author']
    if not os.path.exists(path):
        json.dump({"found": False, "error": f"file no longer on disk: {path}"}, sys.stdout); print()
        return

    # Compute the target hash (or None → return from move 1).
    target_hash = None
    if a.fen:
        board = chess.Board(a.fen if len(a.fen.split()) >= 6 else a.fen + ' 0 1')
        target_hash = zbl.zobrist_hash(board)
    elif a.moves:
        board = chess.Board()
        import re as _re
        for tok in _re.sub(r'\d+\.(\.\.)?', ' ', a.moves).split():
            if tok in ('*', '1-0', '0-1', '1/2-1/2'):
                continue
            try:
                board.push_san(tok)
            except Exception:
                json.dump({"found": False, "error": f"illegal move token: {tok}"}, sys.stdout); print()
                return
        target_hash = zbl.zobrist_hash(board)

    # Open the PGN, iterate games. If --chapter, filter by substring match
    # on White header (which is what the indexer used as the chapter
    # label). Otherwise take the first game that contains the target.
    fh = open(path, encoding='utf-8', errors='replace')
    chapters_tried = 0
    while True:
        try:
            game = chess.pgn.read_game(fh)
        except Exception:
            break
        if game is None:
            break
        chapter = game.headers.get('White', '') or ''
        if a.chapter and a.chapter.lower() not in chapter.lower():
            continue
        chapters_tried += 1
        # Locate the target position (or take the game root when no
        # position specified — "give me the whole chapter").
        if target_hash is None:
            target_node = game
            target_board = game.board()
        else:
            target_node, target_board = find_node_by_hash(game, target_hash)
            if target_node is None:
                continue

        new_game = truncate_subtree(game, target_node, max_below)
        pgn_out = io.StringIO()
        exporter = chess.pgn.FileExporter(pgn_out)
        new_game.accept(exporter)

        # Reconstruct the move sequence from the game root to the target
        # (helpful for the LLM to know "you're at ply N after these moves").
        moves_to_here = []
        if target_node.parent is not None:
            node = target_node
            while node.parent is not None:
                moves_to_here.append(node.san())
                node = node.parent
            moves_to_here.reverse()

        payload = {
            "found": True,
            "file_id": a.file_id,
            "file": name,
            "course": course or None,
            "author": author or None,
            "chapter": chapter or None,
            "line_header": game.headers.get('Black') or None,
            "moves_to_position": ' '.join(moves_to_here),
            "target_fen": target_board.fen(),
            "ply_from_chapter_root": len(moves_to_here),
            "max_plies_below": max_below,
            "subtree_pgn": pgn_out.getvalue().strip(),
            "chapters_searched": chapters_tried,
        }
        json.dump(payload, sys.stdout, ensure_ascii=False); print()
        return

    json.dump({
        "found": False,
        "file_id": a.file_id,
        "file": name,
        "error": (f"position not found in {'chapter matching '+repr(a.chapter) if a.chapter else 'any chapter'} of this file"
                  if target_hash is not None else
                  f"no chapter matched --chapter={a.chapter!r}"),
        "chapters_searched": chapters_tried,
    }, sys.stdout); print()


main()
