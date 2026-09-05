"""Spotify adapter — OPTIONAL, outbound links only.

Uses the client-credentials flow (no user OAuth). If credentials are missing we
fall back to a Spotify search URL, which still works without an account.
"""

from __future__ import annotations

import logging
import time
from urllib.parse import quote

import httpx

from app.cache.cache import cache
from app.config import get_settings
from app.services.errors import ProviderError
from app.services.http import get_client

log = logging.getLogger(__name__)

_token: tuple[float, str] | None = None


async def _access_token() -> str | None:
    global _token
    settings = get_settings()
    if not settings.spotify_enabled:
        return None
    now = time.time()
    if _token and _token[0] > now + 30:
        return _token[1]
    try:
        resp = await get_client().post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "client_credentials"},
            auth=(settings.spotify_client_id, settings.spotify_client_secret),
        )
        resp.raise_for_status()
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("spotify token request failed: %s", exc)
        return None
    _token = (now + int(body.get("expires_in", 3600)), body["access_token"])
    return _token[1]


async def find_artist_url(artist: str) -> str | None:
    settings = get_settings()
    if not settings.spotify_enabled or settings.mock_providers:
        return None
    key = f"spotify:artist_url:{artist.lower()}"

    async def fetch() -> str | None:
        token = await _access_token()
        if not token:
            return None
        try:
            resp = await get_client().get(
                "https://api.spotify.com/v1/search",
                params={"q": artist, "type": "artist", "limit": 3},
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code >= 400:
                raise ProviderError("spotify", f"HTTP {resp.status_code}")
            items = ((resp.json().get("artists") or {}).get("items")) or []
        except (httpx.HTTPError, ValueError, ProviderError) as exc:
            log.warning("spotify artist lookup failed: %s", exc)
            return None
        for item in items:
            if item.get("name", "").lower() == artist.lower():
                return (item.get("external_urls") or {}).get("spotify")
        return None

    return await cache.get_or_set(key, settings.ttl_artist, fetch)


def search_url(artist: str) -> str:
    # The term is a path segment, not a query string: "+" would stay a literal plus.
    return f"https://open.spotify.com/search/{quote(artist)}"
