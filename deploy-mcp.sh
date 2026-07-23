#!/usr/bin/env bash
# Deploy chessceo-mcp end to end: publish to npm (idempotent, safe if the
# version is already up), nuke the npx cache, restart the systemd service,
# verify the running version. Idempotent — safe to re-run.
#
# Usage:  bash ~/dev/chessceo-mcp/deploy-mcp.sh
#
# Prompts for sudo password once for the systemctl restart.
#
# Why a script instead of chained &&: `npm publish` returns non-zero when
# the version is already published (which is a common recovery state, not
# a failure). A naive `&& rm && sudo restart` chain skips the restart in
# that case. This script treats "already published" as success.

set -uo pipefail

# ─── config ────────────────────────────────────────────────────────
REPO_DIR="$HOME/dev/chessceo-mcp"
SERVICE="chessceo-mcp.service"
NPX_CACHE_DIR="$HOME/.npm/_npx"
REMOTE_URL="https://mcp.chess.ceo/mcp"

# ─── helpers ───────────────────────────────────────────────────────
c()   { printf "\033[36m▸ %s\033[0m\n" "$1"; }         # step header
ok()  { printf "\033[32m✓ %s\033[0m\n" "$1"; }         # success line
warn(){ printf "\033[33m⚠ %s\033[0m\n" "$1"; }         # non-fatal
die() { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

# ─── 0. sanity ────────────────────────────────────────────────────
[[ -d "$REPO_DIR" ]] || die "repo not found: $REPO_DIR"
cd "$REPO_DIR" || die "cannot cd into $REPO_DIR"

LOCAL_VERSION=$(node -p "require('./package.json').version")
[[ -n "$LOCAL_VERSION" ]] || die "cannot read local version from package.json"
c "deploying @chessceo/mcp@$LOCAL_VERSION"

# ─── 1. publish (tolerant of already-published) ────────────────────
c "1/5 npm publish"
PUBLISH_OUT=$(npm publish --access public 2>&1) || true
if echo "$PUBLISH_OUT" | grep -q "cannot publish over"; then
  warn "$LOCAL_VERSION already on npm — treating as success"
elif echo "$PUBLISH_OUT" | grep -qE "^\+ @chessceo/mcp@$LOCAL_VERSION"; then
  ok "published $LOCAL_VERSION to npm"
else
  echo "$PUBLISH_OUT" | tail -20
  die "npm publish failed for an unexpected reason"
fi

# ─── 2. clear the npm packument cache ──────────────────────────────
# The registry's local metadata cache sometimes lags a fresh publish by
# 20-40 s, which crash-loops the systemd unit ("No matching version").
# Blowing away _cacache/index-v5 forces npx to re-resolve from the
# authoritative registry.
c "2/5 npm cache clean"
npm cache clean --force >/dev/null 2>&1 || true
ok "npm cache cleaned"

# ─── 3. nuke the npx cache dir(s) ──────────────────────────────────
# npx caches installed tarballs under ~/.npm/_npx/<hash>/. A restart
# reuses whatever is there, so a fresh publish is invisible until this
# is wiped. Nuking everything is safe — it just re-downloads on next
# use.
c "3/5 rm -rf $NPX_CACHE_DIR"
rm -rf "$NPX_CACHE_DIR" 2>/dev/null
ok "npx cache wiped"

# ─── 4. wait for npm CDN + restart ─────────────────────────────────
# Small wait covers the CDN propagation window we've observed after
# publish. Cheap insurance against the ETARGET crash-loop.
c "4/5 waiting 20s for CDN, then restarting $SERVICE"
sleep 20
sudo systemctl restart "$SERVICE" || die "systemctl restart failed"
ok "restarted"

# ─── 5. verify running version ─────────────────────────────────────
c "5/5 verifying running version"
# Give the service ~10 s to install + start.
for i in 1 2 3 4 5; do
  sleep 2
  RUNNING=$(
    for d in "$NPX_CACHE_DIR"/*/; do
      pj="$d/node_modules/@chessceo/mcp/package.json"
      [[ -f "$pj" ]] && node -p "require('$pj').version" 2>/dev/null && break
    done
  )
  [[ -n "$RUNNING" ]] && break
done

if [[ "$RUNNING" == "$LOCAL_VERSION" ]]; then
  ok "$SERVICE is running @chessceo/mcp@$RUNNING"
else
  warn "expected $LOCAL_VERSION, got \"${RUNNING:-<none>}\" — check journalctl -u $SERVICE"
fi

# Sanity-poke the live tools list too — most useful signal that the
# public surface actually reflects the deploy.
TOOLS_JSON=$(curl -sX POST "$REMOTE_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)

if [[ -n "$TOOLS_JSON" ]]; then
  TOOL_COUNT=$(node -p "JSON.parse(process.argv[1]).result?.tools?.length ?? 0" "$TOOLS_JSON" 2>/dev/null)
  ok "$REMOTE_URL serves ${TOOL_COUNT} tools"
else
  warn "$REMOTE_URL did not respond — check nginx and the service"
fi

c "done"
