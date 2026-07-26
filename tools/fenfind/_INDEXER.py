import chess, chess.pgn, chess.polyglot as zbl, sqlite3, os, sys, csv, time

# Live DB path fenfind.py reads (~/positions.db by default, overridable
# via FENFIND_DB). Build into a temp file next to it and atomically
# rename at the end so fenfind keeps serving the current DB until the
# new build is ready — same aphex-store deploy pattern.
DB   = os.environ.get('FENFIND_DB') or os.path.expanduser('~/positions.db')
TMP  = DB + '.tmp'
ROOT = os.environ.get('FENFIND_RAW') or os.path.expanduser('~/chess/raw')

if os.path.exists(TMP):
    os.remove(TMP)
con=sqlite3.connect(TMP); cur=con.cursor()
cur.executescript("""
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS occ;
CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT, name TEXT, course TEXT, author TEXT);
CREATE TABLE occ(z INTEGER, file_id INTEGER, chapter TEXT, line TEXT,
                 ply INTEGER, subtree INTEGER, chars INTEGER, score REAL);
""")

CSV = os.environ.get('FENFIND_COURSES_CSV') or os.path.expanduser('~/chess/chessable/_originals.csv')
course={}
try:
    for r in csv.DictReader(open(CSV)):
        course[r['original_file']]=(r.get('course_name',''),r.get('author',''))
except Exception as e:
    print(f'  (no course-mapping CSV at {CSV}: {e})', flush=True)

def subtree_all(root):
    """one post-order pass: id(node) -> (descendants, comment_chars_in_subtree)"""
    order=[]; stack=[root]
    while stack:
        n=stack.pop(); order.append(n); stack.extend(n.variations)
    res={}
    for n in reversed(order):
        cnt=0; ch=len(n.comment or '')
        for v in n.variations:
            a,b=res[id(v)]; cnt+=1+a; ch+=b
        res[id(n)]=(cnt,ch)
    return res

def sz(z):
    'unsigned 64-bit zobrist -> signed for SQLite'
    return z-(1<<64) if z>=(1<<63) else z

sys.setrecursionlimit(200000)
files=[os.path.join(ROOT,f) for f in sorted(os.listdir(ROOT)) if f.lower().endswith('.pgn')]
t0=time.time(); fid=0; tot=0

for p in files:
    fid+=1; b=os.path.basename(p)
    cn,au=course.get(b,('',''))
    cur.execute("INSERT INTO files VALUES(?,?,?,?,?)",(fid,p,b,cn,au))
    best={}   # (zobrist, chapter) -> richest occurrence in this file
    try: fh=open(p,encoding='utf-8',errors='replace')
    except Exception: continue
    while True:
        try: g=chess.pgn.read_game(fh)
        except Exception: break
        if g is None: break
        ch=(g.headers.get('White') or '')[:120]
        ln=(g.headers.get('Black') or '')[:120]
        try: board=g.board()
        except Exception: continue
        sub=subtree_all(g)

        def walk(node, ply):
            z=sz(zbl.zobrist_hash(board))
            st,cc=sub[id(node)]
            sc=st+cc/50.0
            k=(z,ch)
            cb=best.get(k)
            if cb is None or sc>cb[6]:
                best[k]=(z,ch,ln,ply,st,cc,sc)
            for v in node.variations:
                try: board.push(v.move)
                except Exception: continue
                walk(v, ply+1)
                board.pop()
        try: walk(g,0)
        except RecursionError: pass
    if best:
        cur.executemany("INSERT INTO occ VALUES(?,?,?,?,?,?,?,?)",
                        [(r[0],fid,r[1],r[2],r[3],r[4],r[5],r[6]) for r in best.values()])
        tot+=len(best); con.commit()
    if fid%100==0:
        print(f"{fid}/{len(files)} files  {tot:,} rows  {time.time()-t0:.0f}s",flush=True)

con.commit()
print(f"indexed {fid} files -> {tot:,} deduped positions in {time.time()-t0:.0f}s",flush=True)
cur.execute("CREATE INDEX idx_z ON occ(z)")
con.commit(); con.close()

# Atomic swap — fenfind sees the new DB in one filesystem operation.
# The old positions.db becomes positions.db.old as a rollback safety net.
if os.path.exists(DB):
    old = DB + '.old'
    if os.path.exists(old):
        os.remove(old)
    os.rename(DB, old)
    print(f"kept previous DB at {old}", flush=True)
os.rename(TMP, DB)
print(f"swapped in -> {DB}", flush=True)
print("done",flush=True)
