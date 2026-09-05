"""MusicBrainz adapter — identity + external links.

Public lookups need no key, but MusicBrainz asks for a descriptive User-Agent and
~1 request/second/IP. We throttle with a process-wide lock and cache for 7 days.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from app.cache.cache import cache
from app.config import get_settings
from app.services.errors import ProviderError, RateLimited
from app.services.http import get_client, retry_after_seconds

log = logging.getLogger(__name__)

API_ROOT = "https://musicbrainz.org/ws/2"
PROVIDER = "musicbrainz"
MIN_INTERVAL = 1.05  # seconds between requests

_lock = asyncio.Lock()
_last_request = 0.0


class MBArtistLinks(dict):
    """Mapping of provider -> URL discovered via MusicBrainz url-rels."""


async def _throttled_get(path: str, **params: Any) -> dict[str, Any]:
    global _last_request
    settings = get_settings()
    async with _lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            resp = await get_client().get(
                f"{API_ROOT}{path}",
                params={"fmt": "json", **params},
                headers={"User-Agent": settings.musicbrainz_user_agent},
            )
        except httpx.HTTPError as exc:
            raise ProviderError(PROVIDER, f"network error: {exc}") from exc
        finally:
            _last_request = time.monotonic()

    if resp.status_code == 429 or resp.status_code == 503:
        raise RateLimited(PROVIDER, retry_after_seconds(resp))
    if resp.status_code == 404:
        return {}
    if resp.status_code >= 400:
        raise ProviderError(PROVIDER, f"HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderError(PROVIDER, "bad JSON") from exc


def _classify_url(url: str) -> str | None:
    if "open.spotify.com/artist" in url:
        return "spotify"
    if "music.apple.com" in url or "itunes.apple.com" in url:
        return "apple_music"
    if "youtube.com/" in url:
        return "youtube"
    return None


async def get_artist_links(mbid: str) -> dict[str, str]:
    """Return {spotify|apple_music|youtube: url} for an MBID, best effort."""
    settings = get_settings()
    if settings.mock_providers:
        return {}
    key = f"mb:links:{mbid}"

    async def fetch() -> dict[str, str]:
        data = await _throttled_get(f"/artist/{mbid}", inc="url-rels")
        links: dict[str, str] = {"musicbrainz": f"https://musicbrainz.org/artist/{mbid}"}
        for rel in data.get("relations") or []:
            url = ((rel.get("url") or {}).get("resource")) or ""
            kind = _classify_url(url)
            if kind and kind not in links:
                links[kind] = url
        return links

    return await cache.get_or_set(key, settings.ttl_musicbrainz, fetch)


async def find_mbid(name: str) -> str | None:
    """Look up a canonical MBID by artist name. Used only when Last.fm has none."""
    settings = get_settings()
    if settings.mock_providers:
        return None
    key = f"mb:search:{name.lower()}"

    async def fetch() -> str | None:
        data = await _throttled_get("/artist", query=f'artist:"{name}"', limit=1)
        artists = data.get("artists") or []
        if not artists:
            return None
        top = artists[0]
        # Only trust high-confidence exact-ish matches.
        if int(top.get("score", 0)) >= 90 and top.get("name", "").lower() == name.lower():
            return top.get("id")
        return None

    return await cache.get_or_set(key, settings.ttl_musicbrainz, fetch)


def _lucene(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


async def _get_with_retry(path: str, **params: Any) -> dict[str, Any]:
    """MusicBrainz answers "server is currently busy" (503) fairly often; one retry usually clears it."""
    try:
        return await _throttled_get(path, **params)
    except RateLimited as exc:
        await asyncio.sleep(min(exc.retry_after or 2.0, 5.0))
        return await _throttled_get(path, **params)


def _same_title(a: str, b: str) -> bool:
    return a.strip().casefold() == b.strip().casefold()


async def get_first_release_date(
    artist: str,
    track: str,
    mbid: str | None = None,
    *,
    album: str | None = None,
    duration_seconds: int | None = None,
) -> str | None:
    """Release date for a song ("YYYY", "YYYY-MM" or "YYYY-MM-DD"). Last.fm has none.

    Tried in order of reliability:
      1. The album's release group (when Last.fm named the album): its first-release-date
         is well curated, and picking the earliest exact-title match handles same-name albums.
      2. Official, non-live recordings with the song's title, narrowed to those whose length
         matches Last.fm's duration; earliest wins. Noisy: covers and remixes share titles.
      3. The recording MBID Last.fm supplied, which often points at a later pressing.
    """
    settings = get_settings()
    if settings.mock_providers:
        return None
    key = f"mb:release:{artist.casefold()}|{track.casefold()}|{(album or '').casefold()}|{duration_seconds or ''}|{mbid or ''}"

    async def fetch() -> str | None:
        if album:
            data = await _get_with_retry(
                "/release-group",
                query=f'releasegroup:"{_lucene(album)}" AND artist:"{_lucene(artist)}" AND NOT secondarytype:compilation',
                limit=10,
            )
            dates = [
                rg["first-release-date"]
                for rg in data.get("release-groups") or []
                if int(rg.get("score", 0)) >= 90
                and rg.get("first-release-date")
                and _same_title(rg.get("title", ""), album)
                and not rg.get("secondary-types")
            ]
            if dates:
                return min(dates)

        data = await _get_with_retry(
            "/recording",
            query=(
                f'recording:"{_lucene(track)}" AND artist:"{_lucene(artist)}" '
                "AND status:official AND NOT secondarytype:live AND NOT secondarytype:compilation"
            ),
            limit=25,
        )
        recs = [
            r
            for r in data.get("recordings") or []
            if int(r.get("score", 0)) >= 90 and r.get("first-release-date") and _same_title(r.get("title", ""), track)
        ]
        if duration_seconds:
            close = [r for r in recs if r.get("length") and abs(r["length"] / 1000 - duration_seconds) <= max(4, duration_seconds * 0.04)]
            recs = close or recs
        if recs:
            # Dates are ISO-ordered strings, so the lexical minimum is the earliest.
            return min(r["first-release-date"] for r in recs)

        if mbid:
            data = await _get_with_retry(f"/recording/{mbid}")
            return data.get("first-release-date") or None
        return None

    return await cache.get_or_set(key, settings.ttl_musicbrainz, fetch)
