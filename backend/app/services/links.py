"""Outbound link resolution: MusicBrainz url-rels first, provider search second,
plain search URLs as the always-available fallback."""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote_plus

from app.models.artist import Artist, ExternalUrls
from app.models.track import TrackDetails
from app.services import apple_music, itunes, musicbrainz, preview, spotify
from app.services.errors import ProviderError

log = logging.getLogger(__name__)

SONG_URL_TIMEOUT = 3.0  # seconds; the song panel must not wait long for the Apple lookup
ARTWORK_TIMEOUT = 3.0  # seconds; the artist panel must not wait long for the Apple lookup


async def _safe(coro):
    try:
        return await coro
    except ProviderError as exc:
        log.warning("link resolution skipped: %s", exc)
        return None
    except Exception:
        log.exception("link resolution crashed")
        return None


async def apple_artist(name: str) -> dict[str, str | None]:
    """The Apple Music artist lookup (page URL and artwork), or {} when not found or Apple is slow."""
    try:
        return await asyncio.wait_for(apple_music.find_artist(name), ARTWORK_TIMEOUT) or {}
    except asyncio.TimeoutError:
        log.warning("apple music artist lookup timed out")
        return {}
    except ProviderError as exc:
        log.warning("apple music artist lookup skipped: %s", exc)
        return {}
    except Exception:
        log.exception("apple music artist lookup crashed")
        return {}


async def enrich_links(artist: Artist) -> Artist:
    urls = artist.external_urls.model_copy()
    image_url = artist.image_url
    if artist.mbid:
        mb = await _safe(musicbrainz.get_artist_links(artist.mbid)) or {}
        urls.spotify = urls.spotify or mb.get("spotify")
        urls.apple_music = urls.apple_music or mb.get("apple_music")
        urls.youtube = urls.youtube or mb.get("youtube")
        urls.musicbrainz = urls.musicbrainz or mb.get("musicbrainz")

    lookups = []
    if not urls.spotify:
        lookups.append(("spotify", spotify.find_artist_url(artist.name)))
    # One cached Apple search gives both the artist page and the artist photo.
    if not urls.apple_music or not image_url:
        lookups.append(("apple", apple_artist(artist.name)))
    if lookups:
        results = await asyncio.gather(*(_safe(c) for _, c in lookups))
        for (field, _), value in zip(lookups, results):
            if field == "apple":
                apple = value or {}
                urls.apple_music = urls.apple_music or apple.get("url")
                image_url = image_url or apple.get("artwork_url")
            elif value:
                setattr(urls, field, value)

    # Guaranteed fallbacks: search pages need no keys at all.
    urls.spotify = urls.spotify or spotify.search_url(artist.name)
    urls.apple_music = urls.apple_music or apple_music.search_url(artist.name)
    urls.youtube = urls.youtube or f"https://www.youtube.com/results?search_query={quote_plus(artist.name)}"
    urls.lastfm = urls.lastfm or artist.lastfm_url

    return artist.model_copy(update={"external_urls": ExternalUrls(**urls.model_dump()), "image_url": image_url})


async def release_date_for(track: TrackDetails) -> str | None:
    """First release date from MusicBrainz, best effort (None when unknown or MusicBrainz is busy)."""
    return await _safe(
        musicbrainz.get_first_release_date(
            track.artist.name,
            track.name,
            track.mbid,
            album=track.album.title if track.album else None,
            duration_seconds=track.duration_seconds,
        )
    )


async def apple_song_url(artist: str, track: str) -> str | None:
    """The song's own Apple Music page (MusicKit or iTunes Search), from the cached
    preview lookup the play button also uses (one Apple request serves both). None
    when not found or Apple is slow."""
    try:
        result = await asyncio.wait_for(preview.resolve_preview(artist, track), SONG_URL_TIMEOUT)
    except asyncio.TimeoutError:
        log.warning("apple music song lookup timed out")
        return None
    except Exception:
        log.exception("apple music song lookup crashed")
        return None
    if result.available and result.provider in (apple_music.PROVIDER, itunes.PROVIDER):
        return result.track_url
    return None


async def enrich_track(track: TrackDetails) -> TrackDetails:
    """Song links: the Apple Music song page when the catalog has it, keyless search
    links otherwise. The release date is served separately because MusicBrainz is
    throttled to one request per second and must not delay the rest."""
    urls = track.external_urls.model_copy()
    term = f"{track.artist.name} {track.name}"
    urls.apple_music = urls.apple_music or await apple_song_url(track.artist.name, track.name)
    urls.spotify = urls.spotify or spotify.search_url(term)
    urls.apple_music = urls.apple_music or apple_music.search_url(term)
    urls.youtube = urls.youtube or f"https://www.youtube.com/results?search_query={quote_plus(term)}"
    urls.lastfm = urls.lastfm or track.lastfm_url
    if track.mbid:
        urls.musicbrainz = urls.musicbrainz or f"https://musicbrainz.org/recording/{track.mbid}"
    return track.model_copy(update={"external_urls": urls})
