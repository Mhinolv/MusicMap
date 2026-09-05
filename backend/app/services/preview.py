"""Preview provider abstraction.

Audio providers are pluggable. The MVP ships with AppleMusicPreviewProvider; adding
another provider means implementing PreviewProvider and appending it to PROVIDERS.
A failed lookup NEVER raises to the caller — it returns an unavailable result.
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.cache.cache import cache
from app.config import get_settings
from app.models.track import PreviewResult
from app.services import apple_music, mock
from app.services.errors import ProviderError

log = logging.getLogger(__name__)

UNAVAILABLE = PreviewResult(available=False, preview_url=None, provider=None)


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


class MockPreviewProvider:
    name = "mock"

    def enabled(self) -> bool:
        return get_settings().mock_providers

    async def get_preview(self, artist: str, track: str) -> PreviewResult | None:
        return mock.get_preview(artist, track)


PROVIDERS: list[PreviewProvider] = [MockPreviewProvider(), AppleMusicPreviewProvider()]


async def resolve_preview(artist: str, track: str) -> PreviewResult:
    settings = get_settings()
    key = f"preview:{artist.lower()}::{track.lower()}"

    async def fetch() -> PreviewResult:
        for provider in PROVIDERS:
            if not provider.enabled():
                continue
            try:
                result = await provider.get_preview(artist, track)
            except ProviderError as exc:
                log.warning("preview provider %s failed: %s", provider.name, exc)
                continue
            except Exception:  # never let a preview bug break the artist panel
                log.exception("preview provider %s crashed", provider.name)
                continue
            if result and result.available:
                return result
        return UNAVAILABLE

    return await cache.get_or_set(key, settings.ttl_preview, fetch)
