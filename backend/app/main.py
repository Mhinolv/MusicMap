from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes.artists import router as artists_router
from app.api.routes.tracks import router as tracks_router
from app.cache.cache import cache
from app.config import get_settings
from app.services.errors import ProviderError, RateLimited
from app.services.http import close_client

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tunegraph")
# httpx logs full request URLs, which would include the Last.fm API key.
logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    log.info(
        "providers: lastfm=%s apple_music=%s spotify=%s mock=%s",
        "on" if s.lastfm_enabled else "OFF (set LASTFM_API_KEY)",
        "on" if s.apple_music_enabled else "off",
        "on" if s.spotify_enabled else "off",
        s.mock_providers,
    )
    if not s.lastfm_enabled and not s.mock_providers:
        log.warning("No LASTFM_API_KEY and TUNEGRAPH_MOCK is off: every artist request will return 503.")
    yield
    await close_client()


app = FastAPI(title="TuneGraph API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_methods=["GET"],
    allow_headers=["*"],
)
app.include_router(artists_router)
app.include_router(tracks_router)


@app.exception_handler(ProviderError)
async def provider_error_handler(_: Request, exc: ProviderError) -> JSONResponse:
    headers = {}
    if isinstance(exc, RateLimited) and exc.retry_after:
        headers["Retry-After"] = str(int(exc.retry_after))
    body = {"error": exc.message, "provider": exc.provider}
    if isinstance(exc, RateLimited):
        body["retry_after"] = exc.retry_after
    return JSONResponse(status_code=exc.status, content=body, headers=headers)


@app.get("/api/health")
async def health() -> dict:
    s = get_settings()
    return {
        "ok": True,
        "providers": {
            "lastfm": s.lastfm_enabled,
            "apple_music": s.apple_music_enabled,
            "spotify": s.spotify_enabled,
            "mock": s.mock_providers,
        },
        "cache_entries": len(cache),
    }
