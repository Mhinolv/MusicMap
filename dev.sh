#!/usr/bin/env bash
# Runs the FastAPI backend (:8000) and the Vite frontend (:5173) together.
# Usage: ./dev.sh            -> real providers (needs backend/.env with LASTFM_API_KEY)
#        ./dev.sh --mock     -> canned fixture data, no keys needed
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--mock" ]]; then
  export TUNEGRAPH_MOCK=1
  echo "▶ mock mode: serving fixture data (no API keys used)"
fi

if [[ ! -f backend/.venv/bin/uvicorn ]]; then
  echo "▶ creating backend virtualenv"
  (cd backend && uv venv -q && uv pip install -q -e ".[dev]")
fi
if [[ ! -d frontend/node_modules ]]; then
  echo "▶ installing frontend deps"
  (cd frontend && npm install --silent)
fi
if [[ ! -f backend/.env && "${TUNEGRAPH_MOCK:-0}" != "1" ]]; then
  echo "⚠ backend/.env not found — copy backend/.env.example and add LASTFM_API_KEY, or run ./dev.sh --mock"
fi

trap 'kill 0' EXIT INT TERM
(cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000) &
(cd frontend && npm run dev -- --host 127.0.0.1) &
wait
