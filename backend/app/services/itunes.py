"""iTunes Search API adapter: keyless 30s previews and Apple Music song links.

A fallback for when no MusicKit key is configured. Apple limits the API to about
20 requests per minute per IP, so results go through the preview cache.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from app.config import get_settings
from app.models.track import PreviewResult
from app.services.errors import ProviderError, RateLimited
from app.services.http import get_client, retry_after_seconds

SEARCH_URL = "https://itunes.apple.com/search"
PROVIDER = "itunes"

# Words that mark another recording of the song. Ranked below the original unless asked for.
VARIANT_WORDS = {"live", "remix", "rmx", "mix", "acoustic", "cover", "edit", "instrumental", "karaoke", "version", "demo", "remastered"}


def _norm(s: str) -> str:
    s = s.lower().replace("&", " and ")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in s).split())


def _base(name: str) -> str:
    """Song name without bracketed or dash-separated suffixes: "Creep (Acoustic)" -> "creep"."""
    name = re.sub(r"[\(\[].*?[\)\]]", " ", name)
    name = re.split(r"\s[-–]\s", name)[0]
    return _norm(name)


def _artists(credit: str) -> set[str]:
    """Names in a credit like "The Weeknd & ROSALÍA" or "A feat. B"."""
    parts = re.split(r"\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\bwith\b|\band\b)\s*", credit.lower())
    return {_norm(p) for p in parts if _norm(p)} | {_norm(credit)}


def score(result: dict[str, Any], artist: str, track: str) -> int | None:
    """Higher is better; None means "not this song"."""
    if not result.get("previewUrl"):
        return None
    want_artist = _norm(artist)
    credit = result.get("artistName", "")
    if _norm(credit) == want_artist:
        s = 4
    elif want_artist in _artists(credit):
        s = 2
    else:
        return None  # a wrong-artist cover must never play as the requested song

    name = result.get("trackName", "")
    if _norm(name) == _norm(track):
        s += 4
    elif _base(name) == _base(track):
        s += 2
    else:
        return None

    asked = set(_norm(track).split())
    extra = (set(_norm(name).split()) - asked) & VARIANT_WORDS
    if extra:
        s -= 3
    return s


async def search_song_preview(artist: str, track: str) -> PreviewResult | None:
    settings = get_settings()
    try:
        resp = await get_client().get(
            SEARCH_URL,
            params={"term": f"{artist} {track}", "entity": "song", "limit": 25, "country": settings.apple_music_storefront},
        )
    except httpx.HTTPError as exc:
        raise ProviderError(PROVIDER, f"network error: {exc}") from exc
    # Apple answers 403 as well as 429 when an IP goes over the limit.
    if resp.status_code in (403, 429):
        raise RateLimited(PROVIDER, retry_after_seconds(resp))
    if resp.status_code >= 400:
        raise ProviderError(PROVIDER, f"HTTP {resp.status_code}")
    try:
        results = resp.json().get("results") or []  # served as text/javascript, body is JSON
    except ValueError as exc:
        raise ProviderError(PROVIDER, "bad JSON") from exc

    best: tuple[int, int, dict[str, Any]] | None = None
    for i, result in enumerate(results):
        if result.get("kind") not in (None, "song"):
            continue
        s = score(result, artist, track)
        if s is not None and (best is None or s > best[0]):
            best = (s, i, result)  # ties keep Apple's relevance order
    if best is None:
        return None
    result = best[2]
    artwork = result.get("artworkUrl100")
    if artwork:
        artwork = artwork.replace("100x100bb", "300x300bb")
    return PreviewResult(
        available=True,
        preview_url=result["previewUrl"],
        duration_seconds=30,
        provider=PROVIDER,
        track_url=result.get("trackViewUrl", "").split("&uo=")[0] or None,  # drop the affiliate tag
        artwork_url=artwork,
    )
