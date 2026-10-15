"""Apple Music catalog adapter.

Uses a developer token (ES256 JWT signed with your MusicKit .p8 key). No user
authorization is involved — catalog search and 30s previews are available with the
developer token alone.
"""

from __future__ import annotations

import asyncio
import logging
import time
import weakref
from typing import Any
from urllib.parse import quote_plus

import httpx
import jwt

from app.cache.cache import cache
from app.config import get_settings
from app.models.track import PreviewResult
from app.services.errors import ProviderError, ProviderNotConfigured, RateLimited
from app.services.http import get_client, retry_after_seconds

log = logging.getLogger(__name__)

API_ROOT = "https://api.music.apple.com/v1"
PROVIDER = "apple_music"
TOKEN_TTL = 12 * 3600  # Apple allows up to 6 months; we rotate daily-ish.
ERROR_TTL = 120  # seconds; a failed artist lookup is retried after this, not after ttl_artist
ARTIST_LOOKUP_LIMIT = 3  # concurrent artist searches; 8 at once gave HTTP 429

_token: tuple[float, str] | None = None
_artist_semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def developer_token() -> str:
    """Build (and memoise) a MusicKit developer token."""
    global _token
    settings = get_settings()
    if not settings.apple_music_enabled:
        raise ProviderNotConfigured(
            PROVIDER,
            "APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID and APPLE_MUSIC_PRIVATE_KEY(_PATH) are required",
        )
    now = time.time()
    if _token and _token[0] > now + 60:
        return _token[1]

    issued = int(now)
    payload = {"iss": settings.apple_music_team_id, "iat": issued, "exp": issued + TOKEN_TTL}
    try:
        token = jwt.encode(
            payload,
            settings.apple_music_private_key_pem,
            algorithm="ES256",
            headers={"kid": settings.apple_music_key_id},
        )
    except Exception as exc:  # bad PEM, wrong key type, etc.
        raise ProviderNotConfigured(PROVIDER, f"could not sign developer token: {exc}") from exc
    _token = (issued + TOKEN_TTL, token)
    return token


async def _get(path: str, **params: Any) -> dict[str, Any]:
    token = developer_token()
    try:
        resp = await get_client().get(
            f"{API_ROOT}{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as exc:
        raise ProviderError(PROVIDER, f"network error: {exc}") from exc
    if resp.status_code == 429:
        raise RateLimited(PROVIDER, retry_after_seconds(resp))
    if resp.status_code in (401, 403):
        raise ProviderNotConfigured(PROVIDER, f"Apple rejected the developer token (HTTP {resp.status_code})")
    if resp.status_code >= 400:
        raise ProviderError(PROVIDER, f"HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderError(PROVIDER, "bad JSON") from exc


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == " ").strip()


async def search_song_preview(artist: str, track: str) -> PreviewResult | None:
    """Find a catalog song matching artist+track and return its preview, if any."""
    settings = get_settings()
    term = f"{artist} {track}"
    data = await _get(
        f"/catalog/{settings.apple_music_storefront}/search",
        term=term,
        types="songs",
        limit=10,
    )
    songs = (((data.get("results") or {}).get("songs") or {}).get("data")) or []
    want_artist = _norm(artist)
    want_track = _norm(track)

    def score(song: dict[str, Any]) -> int:
        attrs = song.get("attributes") or {}
        s = 0
        if _norm(attrs.get("artistName", "")) == want_artist:
            s += 2
        elif want_artist in _norm(attrs.get("artistName", "")):
            s += 1
        if _norm(attrs.get("name", "")) == want_track:
            s += 2
        elif want_track in _norm(attrs.get("name", "")):
            s += 1
        if attrs.get("previews"):
            s += 1
        return s

    ranked = sorted(songs, key=score, reverse=True)
    for song in ranked:
        attrs = song.get("attributes") or {}
        if score(song) < 3:
            break
        previews = attrs.get("previews") or []
        url = previews[0].get("url") if previews else None
        if not url:
            continue
        artwork = _artwork_url(attrs)
        return PreviewResult(
            available=True,
            preview_url=url,
            duration_seconds=30,
            provider=PROVIDER,
            track_url=attrs.get("url"),
            artwork_url=artwork,
        )
    return None


def _artwork_url(attrs: dict[str, Any], size: int = 300) -> str | None:
    """MusicKit artwork URLs are templates with {w} and {h} placeholders."""
    url = (attrs.get("artwork") or {}).get("url")
    if not url:
        return None
    return url.replace("{w}", str(size)).replace("{h}", str(size))


class _LookupFailed(Exception):
    """The Apple request failed, so the cache must not keep the miss for ttl_artist."""


def _artist_slots() -> asyncio.Semaphore:
    """The semaphore for the running event loop (a semaphore must not cross loops)."""
    loop = asyncio.get_running_loop()
    slots = _artist_semaphores.get(loop)
    if slots is None:
        slots = _artist_semaphores[loop] = asyncio.Semaphore(ARTIST_LOOKUP_LIMIT)
    return slots


async def find_artist(artist: str) -> dict[str, str | None] | None:
    """The catalog artist whose name matches exactly: its page URL and 300x300 artwork.
    One cached search serves both the outbound link and the artist photo."""
    settings = get_settings()
    if not settings.apple_music_enabled or settings.mock_providers:
        return None
    key = f"apple:artist:{artist.lower()}"

    async def fetch() -> dict[str, str | None] | None:
        try:
            async with _artist_slots():
                data = await _get(
                    f"/catalog/{settings.apple_music_storefront}/search",
                    term=artist,
                    types="artists",
                    limit=3,
                )
        except ProviderError as exc:
            raise _LookupFailed from exc
        items = (((data.get("results") or {}).get("artists") or {}).get("data")) or []
        for item in items:
            attrs = item.get("attributes") or {}
            if _norm(attrs.get("name", "")) == _norm(artist):
                return {"url": attrs.get("url"), "artwork_url": _artwork_url(attrs)}
        return None  # a real "no exact match": cached for ttl_artist

    try:
        return await cache.get_or_set(key, settings.ttl_artist, fetch)
    except _LookupFailed as exc:
        # A failed request (429, 5xx, network) is not a real miss: retry after ERROR_TTL.
        log.warning("apple music artist lookup failed: %s", exc.__cause__)
        cache.set(key, None, ERROR_TTL)
        return None


def search_url(artist: str) -> str:
    return f"https://music.apple.com/{get_settings().apple_music_storefront}/search?term={quote_plus(artist)}"
