# fenfind — find which of your PGN files cover a position

Small python tool the MCP shells out to for the `find_position_in_courses`
tool. Given a FEN it looks up every course/chapter that reaches that
position, ranked by how much annotated material sits below it (comment
chars in the subtree). Uses polyglot Zobrist hashing so the FEN → hash
map matches the pre-built `positions.db` index.

## Files

| File | Purpose |
|------|---------|
| `fenfind` | bash wrapper; picks a python with `python-chess` installed |
| `fenfind.py` | the actual query tool (`--json` for MCP consumption) |
| `_INDEXER.py` | one-off script that builds `positions.db` from a folder of PGNs (kept out of the npm package via `.npmignore`) |

## Runtime dependencies

- **python-chess** — either at `./venv/bin/python` (the wrapper's preferred path) or system-wide `python3`.
  Install locally: `python3 -m venv .venv && .venv/bin/pip install python-chess`.
- **positions.db** — the pre-built index. Resolved via, in order:
  1. `$FENFIND_DB` env var (absolute path).
  2. `<script-dir>/positions.db`
  3. `~/chess/positions.db`
  4. `~/positions.db`

The DB is a runtime asset and never ships in the npm package. Put it at
one of the paths above on any host that runs the MCP.

## MCP integration

`src/index.ts` resolves the script via, in order:
1. `$FENFIND_PATH` env var (directory containing the `fenfind` script).
2. `<package-root>/tools/fenfind/fenfind` (this directory, shipped in the
   npm package).

If neither path exists, the `find_position_in_courses` tool returns a
clear `status: "not_available"` response with the note above rather
than erroring.

## Rebuilding the index

```
python3 _INDEXER.py    # expects PGNs at /home/lucas/chess/raw and a
                        # course-mapping CSV at /home/lucas/chess/chessable/_originals.csv
                        # — edit the paths at the top of the file for
                        # your own layout.
```

Full re-index of ~2k PGN files is a few minutes; produces the ~2 GB
positions.db in place.
