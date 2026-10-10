#!/usr/bin/env bash
# Offscreen UI snapshots: starts the backend in mock mode and the Vite dev server on
# free ports, captures light and dark PNGs of the main screens with headless Chrome
# (puppeteer-core), then stops both servers.
#
# Usage: ./scripts/snapshot.sh <out-dir>
# Output: <out-dir>/<scenario>-light.png, <scenario>-dark.png, manifest.json
# Exit code: 0 when the harness ran (even if some scenarios failed), non-zero when the
# servers could not be started.
set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_CHECKOUT="${TUNEGRAPH_MAIN_CHECKOUT:-/Users/markhinojosa/Projects/MusicMap}"
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
LOGS="$OUT/logs"
mkdir -p "$LOGS"

# Python: the tree's own venv, else the shared one in the main checkout.
if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
  PY="$ROOT/backend/.venv/bin/python"
else
  PY="$MAIN_CHECKOUT/backend/.venv/bin/python"
fi
if [[ ! -x "$PY" ]]; then
  echo "snapshot: no Python venv found (looked in backend/.venv and $MAIN_CHECKOUT/backend/.venv)" >&2
  exit 3
fi

# Frontend deps: reuse the main checkout's node_modules in worktrees.
if [[ ! -e "$ROOT/frontend/node_modules" ]]; then
  ln -s "$MAIN_CHECKOUT/frontend/node_modules" "$ROOT/frontend/node_modules"
fi

free_port() {
  "$PY" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}
API_PORT="$(free_port)"
WEB_PORT="$(free_port)"
while [[ "$WEB_PORT" == "$API_PORT" ]]; do WEB_PORT="$(free_port)"; done

API_PID=""
WEB_PID=""
cleanup() {
  for pid in "$WEB_PID" "$API_PID"; do
    [[ -n "$pid" ]] || continue
    # Kill the whole process group (npx/vite spawn children), then the pid itself.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  sleep 0.5
  for pid in "$WEB_PID" "$API_PID"; do
    [[ -n "$pid" ]] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# set -m gives each background job its own process group, so cleanup can kill it whole.
set -m
(cd "$ROOT/backend" && TUNEGRAPH_MOCK=1 exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT") \
  >"$LOGS/backend.log" 2>&1 &
API_PID=$!
(cd "$ROOT/frontend" && VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
  exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$WEB_PORT" --strictPort) \
  >"$LOGS/frontend.log" 2>&1 &
WEB_PID=$!
set +m

wait_for() {
  local url="$1" name="$2" pid="$3" tries=120
  while (( tries-- > 0 )); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "snapshot: $name exited early; see $LOGS/$name.log" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "snapshot: $name did not become ready at $url; see $LOGS/$name.log" >&2
  return 1
}

wait_for "http://127.0.0.1:$API_PORT/api/health" backend "$API_PID" || exit 4
wait_for "http://127.0.0.1:$WEB_PORT/" frontend "$WEB_PID" || exit 5
# The proxy path proves the frontend can reach this backend.
wait_for "http://127.0.0.1:$WEB_PORT/api/health" frontend "$WEB_PID" || exit 5

echo "snapshot: backend :$API_PORT, frontend :$WEB_PORT, writing to $OUT"
node "$ROOT/scripts/snapshot.mjs" "http://127.0.0.1:$WEB_PORT" "$OUT"
status=$?
if [[ $status -ne 0 ]]; then
  echo "snapshot: helper exited with status $status (see manifest.json if written)" >&2
fi
exit 0
