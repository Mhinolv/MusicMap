#!/usr/bin/env bash
# Double-click to start TuneGraph. Runs backend (:8000) + frontend (:5173) and opens the app.
# Close the Terminal window or press Ctrl+C to stop both servers.
#
# To run with canned fixture data instead of live Last.fm, use:  TUNEGRAPH_MOCK=1 ./TuneGraph.command
cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:5173"
ARGS=()
if [[ "${TUNEGRAPH_MOCK:-0}" == "1" ]]; then
  ARGS+=(--mock)
fi

if [[ ! -f backend/.env && "${TUNEGRAPH_MOCK:-0}" != "1" ]]; then
  echo "⚠  backend/.env not found. Copy backend/.env.example, add LASTFM_API_KEY, and run again."
  echo "   (Or run with TUNEGRAPH_MOCK=1 for fixture data.)"
  read -r -p "Press Enter to close…"
  exit 1
fi

# Open the browser once the frontend is answering, then hand control to dev.sh.
(
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$URL"; then
      open "$URL"
      exit 0
    fi
    sleep 1
  done
  echo "⚠  Frontend did not come up within 60s; check the log above."
) &

echo "▶ Starting TuneGraph — $URL"
echo "  Press Ctrl+C (or close this window) to stop."
echo
exec ./dev.sh "${ARGS[@]}"
