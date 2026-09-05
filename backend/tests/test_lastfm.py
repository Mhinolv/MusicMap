"""Exercises the real Last.fm adapter against canned provider responses."""

from __future__ import annotations

import json

import httpx
import pytest

from app.cache.cache import cache
from app.config import get_settings
from app.services import http as http_mod
from app.services import lastfm
from app.services.errors import NotFound, ProviderNotConfigured, RateLimited

LASTFM_SEARCH = {
    "results": {
        "artistmatches": {
            "artist": [
                {"name": "Radiohead", "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711",
                 "url": "https://www.last.fm/music/Radiohead",
                 "image": [{"#text": "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png", "size": "extralarge"}]},
                {"name": "Radiohead Tribute", "mbid": "", "url": "https://www.last.fm/music/Radiohead+Tribute", "image": []},
            ]
        }
    }
}
LASTFM_SIMILAR = {
    "similarartists": {
        "artist": [
            {"name": "Portishead", "mbid": "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", "match": "0.73", "url": "https://www.last.fm/music/Portishead"},
            {"name": "The Smile", "mbid": "", "match": "0.69", "url": "https://www.last.fm/music/The+Smile"},
            {"name": "Radiohead", "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711", "match": "1", "url": "https://www.last.fm/music/Radiohead"},
        ]
    }
}
LASTFM_TRACKS = {"toptracks": {"track": [{"name": "Creep", "listeners": "1234567", "playcount": "9", "url": "u"}]}}
LASTFM_INFO = {
    "artist": {
        "name": "Radiohead", "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711", "url": "https://www.last.fm/music/Radiohead",
        "stats": {"listeners": "5000000"},
        "tags": {"tag": [{"name": "alternative"}, {"name": "art rock"}]},
        "bio": {"summary": "A band. <a href=\"x\">Read more</a>"},
    }
}


@pytest.fixture(autouse=True)
def _configure(monkeypatch):
    monkeypatch.setenv("LASTFM_API_KEY", "test-key")
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    cache.clear()
    yield
    get_settings.cache_clear()
    cache.clear()


def install_transport(monkeypatch, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(http_mod, "_client", client)
    return client


def route(request: httpx.Request) -> httpx.Response:
    method = request.url.params.get("method")
    assert request.url.params.get("api_key") == "test-key"
    table = {
        "artist.search": LASTFM_SEARCH,
        "artist.getSimilar": LASTFM_SIMILAR,
        "artist.getTopTracks": LASTFM_TRACKS,
        "artist.getInfo": LASTFM_INFO,
    }
    return httpx.Response(200, json=table[method])


async def test_search_maps_ids_and_drops_placeholder_images(monkeypatch):
    install_transport(monkeypatch, route)
    results = await lastfm.search("radiohead")
    assert [r.id for r in results] == ["mb:a74b1b7f-71a5-4011-9441-d0b5e4122711", "lf:Radiohead+Tribute"]
    assert results[0].image_url is None  # placeholder filtered
    # Registry lets the id resolve later without a persistent store.
    assert lastfm.recall("lf:Radiohead+Tribute").name == "Radiohead Tribute"


async def test_similar_excludes_self_and_keeps_similarity(monkeypatch):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return route(req)

    install_transport(monkeypatch, handler)
    sim = await lastfm.get_similar("mb:a74b1b7f-71a5-4011-9441-d0b5e4122711", limit=8)
    assert [s.name for s in sim] == ["Portishead", "The Smile"]
    assert sim[0].similarity == 0.73
    assert sim[1].id == "lf:The+Smile"
    assert seen[0]["mbid"] == "a74b1b7f-71a5-4011-9441-d0b5e4122711"
    # Second call served from cache.
    await lastfm.get_similar("mb:a74b1b7f-71a5-4011-9441-d0b5e4122711", limit=8)
    assert len(seen) == 1


async def test_lf_id_resolves_by_decoded_name(monkeypatch):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return route(req)

    install_transport(monkeypatch, handler)
    await lastfm.get_top_tracks("lf:The+Smile", limit=3)
    assert seen[0]["artist"] == "The Smile"


async def test_mbid_lookup_falls_back_to_name(monkeypatch):
    calls = []

    def handler(req):
        calls.append(dict(req.url.params))
        if "mbid" in req.url.params:
            return httpx.Response(200, json={"error": 6, "message": "The artist you supplied could not be found"})
        return route(req)

    install_transport(monkeypatch, handler)
    lastfm.remember(lastfm.ArtistRef(id="mb:x", mbid="x", name="Radiohead"))
    tracks = await lastfm.get_top_tracks("mb:x")
    assert tracks[0].name == "Creep" and tracks[0].listeners == 1234567
    assert calls[1]["artist"] == "Radiohead"


async def test_get_artist_info_and_bio_cleanup(monkeypatch):
    install_transport(monkeypatch, route)
    artist = await lastfm.get_artist("mb:a74b1b7f-71a5-4011-9441-d0b5e4122711")
    assert artist.tags == ["alternative", "art rock"]
    assert artist.listeners == 5_000_000
    assert artist.summary == "A band."


async def test_rate_limit_translates(monkeypatch):
    install_transport(monkeypatch, lambda req: httpx.Response(429, headers={"Retry-After": "7"}))
    with pytest.raises(RateLimited) as exc:
        await lastfm.search("x")
    assert exc.value.retry_after == 7


async def test_error_code_29_is_rate_limit(monkeypatch):
    install_transport(monkeypatch, lambda req: httpx.Response(200, json={"error": 29, "message": "Rate limit exceeded"}))
    with pytest.raises(RateLimited):
        await lastfm.search("x")


async def test_not_found(monkeypatch):
    install_transport(monkeypatch, lambda req: httpx.Response(200, json={"error": 6, "message": "not found"}))
    with pytest.raises(NotFound):
        await lastfm.get_similar("nm:nobody")


async def test_missing_key(monkeypatch):
    monkeypatch.setenv("LASTFM_API_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(ProviderNotConfigured):
        await lastfm.search("x")


LASTFM_TRACK_SEARCH = {
    "results": {
        "trackmatches": {
            "track": [
                {"name": "Creep", "artist": "Radiohead", "url": "https://www.last.fm/music/Radiohead/_/Creep", "listeners": "3000000", "mbid": ""},
                {"name": "Creep", "artist": "Radiohead", "url": "https://www.last.fm/music/Radiohead/_/Creep", "listeners": "5", "mbid": ""},
                {"name": "Creep (Acoustic)", "artist": "Radiohead", "url": "https://www.last.fm/music/Radiohead/_/Creep+(Acoustic)", "listeners": "9"},
            ]
        }
    }
}
LASTFM_TRACK_INFO = {
    "track": {
        "name": "Creep",
        "mbid": "rec-mbid-1",
        "url": "https://www.last.fm/music/Radiohead/_/Creep",
        "duration": "238000",
        "listeners": "3000000",
        "playcount": "40000000",
        "artist": {"name": "Radiohead", "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711", "url": "https://www.last.fm/music/Radiohead"},
        "album": {
            "artist": "Radiohead", "title": "Pablo Honey", "mbid": "album-mbid", "url": "https://www.last.fm/music/Radiohead/Pablo+Honey",
            "image": [{"#text": "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png", "size": "extralarge"}],
        },
        "toptags": {"tag": [{"name": "alternative"}, {"name": "90s"}]},
        "wiki": {"published": "01 Jan 2010", "summary": "Debut single. <a href=\"x\">Read more on Last.fm</a>"},
    }
}
LASTFM_TRACK_SIMILAR = {
    "similartracks": {
        "track": [
            {"name": "Glory Box", "match": "0.9", "url": "https://www.last.fm/music/Portishead/_/Glory+Box",
             "artist": {"name": "Portishead", "mbid": "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", "url": "https://www.last.fm/music/Portishead"}},
            {"name": "Creep", "match": "1", "url": "https://www.last.fm/music/Radiohead/_/Creep",
             "artist": {"name": "Radiohead", "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711", "url": "https://www.last.fm/music/Radiohead"}},
            {"name": "Glory Box", "match": "0.95", "url": "https://www.last.fm/music/Portishead/_/Glory+Box",
             "artist": {"name": "Portishead", "mbid": "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", "url": "https://www.last.fm/music/Portishead"}},
            {"name": "Teardrop", "match": "0.6", "url": "https://www.last.fm/music/Massive+Attack/_/Teardrop",
             "artist": {"name": "Massive Attack", "mbid": "", "url": "https://www.last.fm/music/Massive+Attack"}},
        ]
    }
}


def track_route(request: httpx.Request) -> httpx.Response:
    table = {
        "track.search": LASTFM_TRACK_SEARCH,
        "track.getInfo": LASTFM_TRACK_INFO,
        "track.getSimilar": LASTFM_TRACK_SIMILAR,
    }
    method = request.url.params.get("method")
    return httpx.Response(200, json=table[method]) if method in table else route(request)


async def test_track_search_dedupes_and_derives_artist_from_url(monkeypatch):
    install_transport(monkeypatch, track_route)
    tracks = await lastfm.search_tracks("creep")
    assert [t.name for t in tracks] == ["Creep", "Creep (Acoustic)"]
    assert tracks[0].id == "tr:radiohead|creep"
    assert tracks[0].artist.id == "lf:Radiohead"
    assert tracks[0].artist.lastfm_url == "https://www.last.fm/music/Radiohead"
    assert tracks[0].listeners == 3_000_000


async def test_track_details_maps_album_tags_and_wiki(monkeypatch):
    install_transport(monkeypatch, track_route)
    d = await lastfm.get_track_details("tr:radiohead|creep")
    assert d.name == "Creep" and d.mbid == "rec-mbid-1"
    assert d.artist.id == "mb:a74b1b7f-71a5-4011-9441-d0b5e4122711"
    assert d.album and d.album.title == "Pablo Honey"
    assert d.album.image_url == "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png"
    assert d.duration_seconds == 238
    assert d.playcount == 40_000_000
    assert d.tags == ["alternative", "90s"]
    assert d.summary == "Debut single."
    assert d.release_date is None  # comes from MusicBrainz via links.enrich_track, not Last.fm


async def test_track_tags_fall_back_to_artist_tags(monkeypatch):
    """Last.fm's track-level tags are often empty even for well-known songs."""
    calls = []

    def handler(req):
        method = req.url.params.get("method")
        calls.append(method)
        if method == "track.getTopTags":
            return httpx.Response(200, json={"toptags": {"tag": [], "@attr": {"artist": "Radiohead", "track": "Creep"}}})
        if method == "artist.getTopTags":
            return httpx.Response(200, json={"toptags": {"tag": [{"name": "alternative"}, {"name": "art rock"}, {"name": "rock"}]}})
        return track_route(req)

    install_transport(monkeypatch, handler)
    assert await lastfm.get_track_tags("tr:radiohead|creep") == ["alternative", "art rock", "rock"]
    assert "artist.getTopTags" in calls


async def test_track_tags_prefer_the_songs_own_tags(monkeypatch):
    calls = []

    def handler(req):
        method = req.url.params.get("method")
        calls.append(method)
        if method == "track.getTopTags":
            return httpx.Response(200, json={"toptags": {"tag": [{"name": "grunge"}]}})
        return track_route(req)

    install_transport(monkeypatch, handler)
    assert await lastfm.get_track_tags("tr:radiohead|creep") == ["grunge"]
    assert "artist.getTopTags" not in calls


async def test_similar_tracks_skips_self_and_keeps_best_match(monkeypatch):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return track_route(req)

    install_transport(monkeypatch, handler)
    track, similar = await lastfm.get_similar_tracks("tr:radiohead|creep", limit=5)
    assert track.name == "Creep"
    assert [s.name for s in similar] == ["Glory Box", "Teardrop"]
    assert similar[0].similarity == 0.95  # best of the two Glory Box entries
    assert similar[0].id == "tr:portishead|glory box"
    assert similar[1].artist.id == "lf:Massive+Attack"
    assert seen[0]["method"] == "track.getInfo" and seen[0]["track"] == "creep"
    assert seen[1]["method"] == "track.getSimilar" and seen[1]["track"] == "Creep"
