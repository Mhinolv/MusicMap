"""Outbound link resolution: MusicBrainz url-rels first, provider search second,
plain search URLs as the always-available fallback."""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote_plus

from app.models.artist import Artist, ExternalUrls
from app.models.track import TrackDetails
from app.services import apple_music, musicbrainz, spotify
from app.services.errors import ProviderError

log = logging.getLogger(__name__)


async def _safe(coro):
    try:
        return await coro
    except ProviderError as exc:
        log.warning("link resolution skipped: %s", exc)
        return None
    except Exception:
        log.exception("link resolution crashed")
        return None


async def enrich_links(artist: Artist) -> Artist:
    urls = artist.external_urls.model_copy()
    if artist.mbid:
        mb = await _safe(musicbrainz.get_artist_links(artist.mbid)) or {}
        urls.spotify = urls.spotify or mb.get("spotify")
        urls.apple_music = urls.apple_music or mb.get("apple_music")
        urls.youtube = urls.youtube or mb.get("youtube")
        urls.musicbrainz = urls.musicbrainz or mb.get("musicbrainz")

    lookups = []
    if not urls.spotify:
        lookups.append(("spotify", spotify.find_artist_url(artist.name)))
    if not urls.apple_music:
        lookups.append(("apple_music", apple_music.find_artist_url(artist.name)))
    if lookups:
        results = await asyncio.gather(*(_safe(c) for _, c in lookups))
        for (field, _), value in zip(lookups, results):
            if value:
                setattr(urls, field, value)

    # Guaranteed fallbacks: search pages need no keys at all.
    urls.spotify = urls.spotify or spotify.search_url(artist.name)
    urls.apple_music = urls.apple_music or apple_music.search_url(artist.name)
    urls.youtube = urls.youtube or f"https://www.youtube.com/results?search_query={quote_plus(artist.name)}"
    urls.lastfm = urls.lastfm or artist.lastfm_url

    return artist.model_copy(update={"external_urls": ExternalUrls(**urls.model_dump())})


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


async def enrich_track(track: TrackDetails) -> TrackDetails:
    """Keyless search links for a song. The release date is served separately because
    MusicBrainz is throttled to one request per second and must not delay the rest."""
    urls = track.external_urls.model_copy()
    term = f"{track.artist.name} {track.name}"
    urls.spotify = urls.spotify or spotify.search_url(term)
    urls.apple_music = urls.apple_music or apple_music.search_url(term)
    urls.youtube = urls.youtube or f"https://www.youtube.com/results?search_query={quote_plus(term)}"
    urls.lastfm = urls.lastfm or track.lastfm_url
    if track.mbid:
        urls.musicbrainz = urls.musicbrainz or f"https://musicbrainz.org/recording/{track.mbid}"
    return track.model_copy(update={"external_urls": urls})
