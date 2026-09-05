"""Vercel serverless entrypoint.

Vercel's Python runtime turns any file under `api/` into a function and, when the
module exposes an ASGI callable named `app`, serves it directly. The real
application lives in `backend/app`, which is added to the import path here so the
backend keeps working unchanged for local development (`./dev.sh`) and tests.

`vercel.json` rewrites every `/api/*` request to this function; the original path
is preserved, so FastAPI's own `/api/...` routes match without a prefix change.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.main import app  # noqa: E402

__all__ = ["app"]
