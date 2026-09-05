"""Last.fm adapter — the primary relationship engine.

Only public, key-authenticated read methods are used:
  artist.search, artist.getInfo, artist.getSimilar, artist.getTopTracks, artist.getTopTags
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.cache.cache import cache
from app.config import get_settings
from app.models.artist import Artist, ArtistRef, ExternalUrls, SimilarArtist
from app.models.graph import lastfm_slug, make_artist_id, make_track_id, normalize_name, parse_artist_id, parse_track_id
from app.models.track import SimilarTrack, Track, TrackAlbum, TrackDetails, TrackRef
from app.services import mock
from app.services.errors import NotFound, ProviderError, ProviderNotConfigured, RateLimited
from app.services.http import get_client, retry_after_seconds

log = logging.getLogger(__name__)

API_ROOT = "https://ws.audioscrobbler.com/2.0/"
PROVIDER = "lastfm"

# Last.fm error codes: https://www.last.fm/api/errorcodes
_ERR_INVALID_PARAMS = 6
_ERR_RATE_LIMIT = 29
_ERR_SUSPENDED_KEY = 26
_ERR_INVALID_KEY = 10

# Registry: artist id -> ArtistRef, so ids can be resolved back to lookups.
_REGISTRY_TTL = 7 * 24 * 3600


def _registry_key(artist_id: str) -> str:
    return f"lastfm:ref:{artist_id}"


def remember(ref: ArtistRef) -> ArtistRef:
    cache.set(_registry_key(ref.id), ref, _REGISTRY_TTL)
    return ref


def recall(artist_id: str) -> ArtistRef | None:
    return cache.get(_registry_key(artist_id))


def _image_url(images: Any) -> str | None:
    """Last.fm returns a list of {'#text': url, 'size': ...}; most are placeholder images."""
    if not isinstance(images, list):
        return None
    preferred = {"extralarge": 0, "large": 1, "medium": 2, "small": 3, "mega": 4}
    candidates = [
        (preferred.get(i.get("size", ""), 9), i.get("#text", ""))
        for i in images
        if isinstance(i, dict) and i.get("#text")
    ]
    candidates.sort()
    for _, url in candidates:
        # Last.fm's blank placeholder image — treat as missing.
        if "2a96cbd8b46e442fc41c2b86b821562f" in url:
            continue
        return url
    return None


def _to_ref(raw: dict[str, Any]) -> ArtistRef:
    name = raw.get("name") or ""
    mbid = raw.get("mbid") or None
    url = raw.get("url") or None
    ref = ArtistRef(
        id=make_artist_id(mbid=mbid, lastfm_url=url, name=name),
        mbid=mbid,
        name=name,
        lastfm_url=url,
        image_url=_image_url(raw.get("image")),
    )
    return remember(ref)


async def _call(method: str, **params: Any) -> dict[str, Any]:
    settings = get_settings()
    if not settings.lastfm_enabled:
        raise ProviderNotConfigured(PROVIDER, "LASTFM_API_KEY is not set")

    query = {
        "method": method,
        "api_key": settings.lastfm_api_key,
        "format": "json",
        **{k: v for k, v in params.items() if v is not None},
    }
    try:
        resp = await get_client().get(API_ROOT, params=query)
    except httpx.HTTPError as exc:
        raise ProviderError(PROVIDER, f"network error: {exc}") from exc

    if resp.status_code == 429:
        raise RateLimited(PROVIDER, retry_after_seconds(resp))

    try:
        data = resp.json()
    except ValueError as exc:
        raise ProviderError(PROVIDER, f"bad response ({resp.status_code})") from exc

    if isinstance(data, dict) and "error" in data:
        code = int(data.get("error", 0))
        message = str(data.get("message", "unknown error"))
        if code == _ERR_RATE_LIMIT:
            raise RateLimited(PROVIDER)
        if code == _ERR_INVALID_PARAMS:
            raise NotFound(PROVIDER, "artist")
        if code in (_ERR_INVALID_KEY, _ERR_SUSPENDED_KEY):
            raise ProviderNotConfigured(PROVIDER, f"Last.fm rejected the API key: {message}")
        raise ProviderError(PROVIDER, message)

    if resp.status_code >= 400:
        raise ProviderError(PROVIDER, f"HTTP {resp.status_code}")
    return data


def _lookup_params(artist_id: str) -> list[dict[str, Any]]:
    """Ordered list of parameter sets to try when resolving an id to a Last.fm artist."""
    kind, value = parse_artist_id(artist_id)
    ref = recall(artist_id)
    attempts: list[dict[str, Any]] = []
    if kind == "mb":
        attempts.append({"mbid": value})
        if ref:
            attempts.append({"artist": ref.name, "autocorrect": 1})
    else:
        name = ref.name if ref else value
        attempts.append({"artist": name, "autocorrect": 1})
    return attempts


async def _call_for_artist(method: str, artist_id: str, **params: Any) -> dict[str, Any]:
    last_exc: ProviderError | None = None
    for lookup in _lookup_params(artist_id):
        try:
            return await _call(method, **lookup, **params)
        except NotFound as exc:
            last_exc = exc
            continue
    raise last_exc or NotFound(PROVIDER, "artist")


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


async def search(query: str, limit: int = 10) -> list[ArtistRef]:
    settings = get_settings()
    if settings.mock_providers:
        return [remember(r) for r in mock.search(query, limit)]

    key = f"lastfm:search:{normalize_name(query)}:{limit}"

    async def fetch() -> list[ArtistRef]:
        data = await _call("artist.search", artist=query, limit=limit)
        matches = data.get("results", {}).get("artistmatches", {}).get("artist", [])
        if isinstance(matches, dict):
            matches = [matches]
        return [_to_ref(m) for m in matches if m.get("name")]

    return await cache.get_or_set(key, settings.ttl_search, fetch)


async def get_artist(artist_id: str) -> Artist:
    settings = get_settings()
    if settings.mock_providers:
        artist = mock.get_artist(artist_id)
        if artist is None:
            raise NotFound(PROVIDER, "artist")
        return artist

    key = f"lastfm:artist:{artist_id}"

    async def fetch() -> Artist:
        data = await _call_for_artist("artist.getInfo", artist_id)
        raw = data.get("artist") or {}
        ref = _to_ref(raw)
        tags_raw = (raw.get("tags") or {}).get("tag") or []
        if isinstance(tags_raw, dict):
            tags_raw = [tags_raw]
        tags = [t.get("name") for t in tags_raw if isinstance(t, dict) and t.get("name")]
        if not tags:
            tags = await get_top_tags(artist_id)
        stats = raw.get("stats") or {}
        bio = (raw.get("bio") or {}).get("summary") or None
        if bio:
            # Strip the trailing "<a href=...>Read more on Last.fm</a>" Last.fm appends.
            bio = bio.split("<a href")[0].strip() or None
        artist = Artist(
            **ref.model_dump(),
            tags=tags[:8],
            listeners=_int(stats.get("listeners")),
            summary=bio,
            external_urls=ExternalUrls(lastfm=ref.lastfm_url),
        )
        # Keep the registry pointing at the *requested* id too, in case Last.fm
        # canonicalised to a different one (e.g. added an mbid).
        cache.set(_registry_key(artist_id), ref, _REGISTRY_TTL)
        return artist

    return await cache.get_or_set(key, settings.ttl_artist, fetch)


async def get_top_tags(artist_id: str, limit: int = 8) -> list[str]:
    settings = get_settings()
    key = f"lastfm:tags:{artist_id}:{limit}"

    async def fetch() -> list[str]:
        data = await _call_for_artist("artist.getTopTags", artist_id)
        tags = (data.get("toptags") or {}).get("tag") or []
        if isinstance(tags, dict):
            tags = [tags]
        return [t["name"] for t in tags if isinstance(t, dict) and t.get("name")][:limit]

    return await cache.get_or_set(key, settings.ttl_artist, fetch)


async def get_similar(artist_id: str, limit: int = 8) -> list[SimilarArtist]:
    settings = get_settings()
    if settings.mock_providers:
        similar = mock.get_similar(artist_id, limit)
        for s in similar:
            remember(s)
        return similar

    key = f"lastfm:similar:{artist_id}:{limit}"

    async def fetch() -> list[SimilarArtist]:
        data = await _call_for_artist("artist.getSimilar", artist_id, limit=limit)
        raw = (data.get("similarartists") or {}).get("artist") or []
        if isinstance(raw, dict):
            raw = [raw]
        out: list[SimilarArtist] = []
        for item in raw:
            if not item.get("name"):
                continue
            ref = _to_ref(item)
            if ref.id == artist_id:
                continue
            out.append(SimilarArtist(**ref.model_dump(), similarity=_float(item.get("match"))))
        return out

    return await cache.get_or_set(key, settings.ttl_similar, fetch)


async def get_top_tracks(artist_id: str, limit: int = 5) -> list[Track]:
    settings = get_settings()
    if settings.mock_providers:
        return mock.get_top_tracks(artist_id, limit)

    key = f"lastfm:tracks:{artist_id}:{limit}"

    async def fetch() -> list[Track]:
        data = await _call_for_artist("artist.getTopTracks", artist_id, limit=limit)
        raw = (data.get("toptracks") or {}).get("track") or []
        if isinstance(raw, dict):
            raw = [raw]
        return [
            Track(
                name=t["name"],
                listeners=_int(t.get("listeners")),
                playcount=_int(t.get("playcount")),
                lastfm_url=t.get("url"),
            )
            for t in raw
            if isinstance(t, dict) and t.get("name")
        ]

    return await cache.get_or_set(key, settings.ttl_tracks, fetch)


async def resolve_name(artist_id: str) -> str:
    """Best-known display name for an artist id (used by preview/link resolution)."""
    ref = recall(artist_id)
    if ref:
        return ref.name
    kind, value = parse_artist_id(artist_id)
    if kind == "mb":
        artist = await get_artist(artist_id)
        return artist.name
    return value


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None




# --------------------------------------------------------------------------- #
# Tracks (song-seeded maps)
# --------------------------------------------------------------------------- #


def _track_registry_key(track_id: str) -> str:
    return f"lastfm:track:{track_id}"


def remember_track(ref: TrackRef) -> TrackRef:
    cache.set(_track_registry_key(ref.id), ref, _REGISTRY_TTL)
    remember(ref.artist)
    return ref


def recall_track(track_id: str) -> TrackRef | None:
    return cache.get(_track_registry_key(track_id))


def _artist_ref_from_track(raw_artist: Any, track_url: str | None) -> ArtistRef:
    """track.search gives the artist as a bare string; track.getInfo/getSimilar give a dict."""
    if isinstance(raw_artist, dict):
        return _to_ref(raw_artist)
    name = str(raw_artist or "")
    # https://www.last.fm/music/Radiohead/_/Creep -> artist url https://www.last.fm/music/Radiohead
    artist_url = None
    slug = lastfm_slug(track_url)
    if slug:
        artist_url = f"https://www.last.fm/music/{slug}"
    return remember(
        ArtistRef(id=make_artist_id(mbid=None, lastfm_url=artist_url, name=name), name=name, lastfm_url=artist_url)
    )


def _to_track_ref(raw: dict[str, Any]) -> TrackRef:
    name = raw.get("name") or ""
    url = raw.get("url") or None
    artist = _artist_ref_from_track(raw.get("artist"), url)
    return remember_track(
        TrackRef(
            id=make_track_id(artist=artist.name, track=name),
            name=name,
            artist=artist,
            mbid=raw.get("mbid") or None,
            lastfm_url=url,
            listeners=_int(raw.get("listeners")),
        )
    )


def _track_lookup(track_id: str) -> dict[str, Any]:
    ref = recall_track(track_id)
    if ref:
        return {"artist": ref.artist.name, "track": ref.name, "autocorrect": 1}
    artist, track = parse_track_id(track_id)
    return {"artist": artist, "track": track, "autocorrect": 1}


def _tag_names(raw: Any) -> list[str]:
    tags = (raw or {}).get("tag") if isinstance(raw, dict) else raw
    if isinstance(tags, dict):
        tags = [tags]
    return [t["name"] for t in tags or [] if isinstance(t, dict) and t.get("name")]


async def search_tracks(query: str, limit: int = 10) -> list[TrackRef]:
    settings = get_settings()
    if settings.mock_providers:
        return [remember_track(t) for t in mock.search_tracks(query, limit)]

    key = f"lastfm:tracksearch:{normalize_name(query)}:{limit}"

    async def fetch() -> list[TrackRef]:
        data = await _call("track.search", track=query, limit=limit)
        matches = data.get("results", {}).get("trackmatches", {}).get("track", [])
        if isinstance(matches, dict):
            matches = [matches]
        out: list[TrackRef] = []
        seen: set[str] = set()
        for m in matches:
            if not isinstance(m, dict) or not m.get("name") or not m.get("artist"):
                continue
            ref = _to_track_ref(m)
            if ref.id in seen:
                continue
            seen.add(ref.id)
            out.append(ref)
        return out

    return await cache.get_or_set(key, settings.ttl_search, fetch)


async def _fetch_track_info(track_id: str) -> dict[str, Any]:
    key = f"lastfm:trackinfo:{track_id}"

    async def fetch() -> dict[str, Any]:
        data = await _call("track.getInfo", **_track_lookup(track_id))
        raw = data.get("track") or {}
        if not raw.get("name"):
            raise NotFound(PROVIDER, "track")
        ref = _to_track_ref(raw)
        # Keep the registry pointing at the requested id too, in case Last.fm autocorrected.
        cache.set(_track_registry_key(track_id), ref, _REGISTRY_TTL)
        return raw

    return await cache.get_or_set(key, settings_ttl_artist(), fetch)


def settings_ttl_artist() -> int:
    return get_settings().ttl_artist


async def get_track(track_id: str) -> TrackRef:
    settings = get_settings()
    if settings.mock_providers:
        ref = mock.get_track(track_id)
        if ref is None:
            raise NotFound(PROVIDER, "track")
        return remember_track(ref)
    known = recall_track(track_id)
    if known:
        return known
    return _to_track_ref(await _fetch_track_info(track_id))


async def get_track_tags(track_id: str, limit: int = 8) -> list[str]:
    """A song's top tags, falling back to its artist's when Last.fm has none for the song.

    Track-level tags are sparse on Last.fm (well-known songs often return an empty list)
    while artist-level tags are dependable, so the fallback keeps the panel and the
    tag-similarity blend from going blind. Mirrors what the mock provider does.
    """
    settings = get_settings()
    if settings.mock_providers:
        details = mock.get_track_details(track_id)
        return (details.tags if details else [])[:limit]

    key = f"lastfm:tracktags:{track_id}:{limit}"

    async def fetch() -> list[str]:
        data = await _call("track.getTopTags", **_track_lookup(track_id))
        tags = _tag_names(data.get("toptags"))[:limit]
        if tags:
            return tags
        track = await get_track(track_id)
        return await get_top_tags(track.artist.id, limit)

    return await cache.get_or_set(key, get_settings().ttl_artist, fetch)


async def get_track_details(track_id: str) -> TrackDetails:
    """Everything Last.fm knows about a song: album + art, duration, counts, tags, wiki."""
    settings = get_settings()
    if settings.mock_providers:
        details = mock.get_track_details(track_id)
        if details is None:
            raise NotFound(PROVIDER, "track")
        remember_track(details)
        return details

    raw = await _fetch_track_info(track_id)
    ref = _to_track_ref(raw)
    album_raw = raw.get("album") or {}
    album = (
        TrackAlbum(
            title=album_raw["title"],
            mbid=album_raw.get("mbid") or None,
            url=album_raw.get("url") or None,
            image_url=_image_url(album_raw.get("image")),
        )
        if isinstance(album_raw, dict) and album_raw.get("title")
        else None
    )
    tags = _tag_names(raw.get("toptags"))
    if not tags:
        try:
            tags = await get_track_tags(track_id)
        except ProviderError:
            tags = []
    wiki = raw.get("wiki") or {}
    summary = wiki.get("summary") or None
    if summary:
        # Strip the trailing "<a href=...>Read more on Last.fm</a>" Last.fm appends.
        summary = summary.split("<a href")[0].strip() or None
    duration_ms = _int(raw.get("duration"))
    return TrackDetails(
        **ref.model_dump(),
        album=album,
        duration_seconds=duration_ms // 1000 if duration_ms else None,
        playcount=_int(raw.get("playcount")),
        tags=tags[:8],
        summary=summary,
        external_urls=ExternalUrls(lastfm=ref.lastfm_url),
    )


async def get_similar_tracks(track_id: str, limit: int = 8) -> tuple[TrackRef, list[SimilarTrack]]:
    """Songs similar to a song, per Last.fm, de-duplicated with the best match kept."""
    settings = get_settings()
    if settings.mock_providers:
        found = mock.get_similar_tracks(track_id, limit)
        if found is None:
            raise NotFound(PROVIDER, "track")
        track, similar = found
        remember_track(track)
        for s in similar:
            remember_track(s)
        return track, similar

    track = await get_track(track_id)
    key = f"lastfm:tracksimilar:{track.id}:{limit}"

    async def fetch() -> list[SimilarTrack]:
        data = await _call("track.getSimilar", **_track_lookup(track.id), limit=limit + 3)
        raw = (data.get("similartracks") or {}).get("track") or []
        if isinstance(raw, dict):
            raw = [raw]
        best: dict[str, SimilarTrack] = {}
        order: list[str] = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("name") or not item.get("artist"):
                continue
            ref = _to_track_ref(item)
            if ref.id == track.id:
                continue
            match = _float(item.get("match"))
            score = max(0.0, min(1.0, match)) if match is not None else None
            existing = best.get(ref.id)
            if existing is None:
                best[ref.id] = SimilarTrack(**ref.model_dump(), similarity=score)
                order.append(ref.id)
            elif score is not None and (existing.similarity or 0) < score:
                best[ref.id] = SimilarTrack(**ref.model_dump(), similarity=score)
        return [best[i] for i in order][:limit]

    return track, await cache.get_or_set(key, settings.ttl_similar, fetch)
