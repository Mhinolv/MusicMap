"""Preview provider abstraction.

Audio providers are pluggable. MusicKit (AppleMusicPreviewProvider) goes first when a
key is set; the keyless iTunes Search API comes after it. Adding another provider means implementing PreviewProvider and appending it to PROVIDERS.
A failed lookup NEVER raises to the caller — it returns an unavailable result.
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.cache.cache import cache
from app.config import get_settings
from app.models.track import PreviewResult
from app.services import apple_music, itunes, mock
from app.services.errors import ProviderError

log = logging.getLogger(__name__)

UNAVAILABLE = PreviewResult(available=False, preview_url=None, provider=None)
# A provider error (rate limit, outage) must not hide a preview for the full TTL.
ERROR_TTL = 120


class PreviewProvider(Protocol):
    name: str

    def enabled(self) -> bool: ...

    async def get_preview(self, artist: str, track: str) -> PreviewResult | None: ...


class AppleMusicPreviewProvider:
    name = "apple_music"

    def enabled(self) -> bool:
        return get_settings().apple_music_enabled

    async def get_preview(self, artist: str, track: str) -> PreviewResult | None:
        return await apple_music.search_song_preview(artist, track)


class ITunesPreviewProvider:
    name = "itunes"

    def enabled(self) -> bool:
        settings = get_settings()
        return settings.itunes_previews and not settings.mock_providers

    async def get_preview(self, artist: str, track: str) -> PreviewResult | None:
        return await itunes.search_song_preview(artist, track)


class MockPreviewProvider:
    name = "mock"

    def enabled(self) -> bool:
        return get_settings().mock_providers

    async def get_preview(self, artist: str, track: str) -> PreviewResult | None:
        return mock.get_preview(artist, track)


PROVIDERS: list[PreviewProvider] = [MockPreviewProvider(), AppleMusicPreviewProvider(), ITunesPreviewProvider()]


class _ProviderFailed(Exception):
    """Every provider that answered failed; cache the miss briefly, not for the full TTL."""


async def resolve_preview(artist: str, track: str) -> PreviewResult:
    settings = get_settings()
    key = f"preview:{artist.lower()}::{track.lower()}"

    async def fetch() -> PreviewResult:
        failed = False
        for provider in PROVIDERS:
            if not provider.enabled():
                continue
            try:
                result = await provider.get_preview(artist, track)
            except ProviderError as exc:
                log.warning("preview provider %s failed: %s", provider.name, exc)
                failed = True
                continue
            except Exception:  # never let a preview bug break the artist panel
                log.exception("preview provider %s crashed", provider.name)
                failed = True
                continue
            if result and result.available:
                return result
        if failed:
            raise _ProviderFailed
        return UNAVAILABLE

    try:
        return await cache.get_or_set(key, settings.ttl_preview, fetch)
    except _ProviderFailed:
        cache.set(key, UNAVAILABLE, ERROR_TTL)
        return UNAVAILABLE
