"""Apple Music token signing, MusicBrainz link parsing, preview fallback."""

from __future__ import annotations

import asyncio
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.cache.cache import cache
from app.config import get_settings
from app.models.artist import ArtistRef
from app.models.track import TrackDetails
from app.services import apple_music, http as http_mod, itunes, links, musicbrainz, preview


@pytest.fixture
def es256_key() -> tuple[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    pub = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    return pem, pub


@pytest.fixture(autouse=True)
def _reset():
    get_settings.cache_clear()
    cache.clear()
    apple_music._token = None
    yield
    get_settings.cache_clear()
    cache.clear()
    apple_music._token = None


def install(monkeypatch, handler):
    monkeypatch.setattr(http_mod, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_developer_token_signs_with_escaped_newlines(monkeypatch, es256_key):
    pem, pub = es256_key
    monkeypatch.setenv("APPLE_MUSIC_TEAM_ID", "TEAM123")
    monkeypatch.setenv("APPLE_MUSIC_KEY_ID", "KEY456")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY", pem.replace("\n", "\\n"))  # as pasted into .env
    get_settings.cache_clear()
    assert get_settings().apple_music_enabled
    token = apple_music.developer_token()
    claims = jwt.decode(token, pub, algorithms=["ES256"])
    assert claims["iss"] == "TEAM123"
    assert jwt.get_unverified_header(token)["kid"] == "KEY456"
    assert apple_music.developer_token() == token  # memoised


def test_developer_token_from_file(monkeypatch, es256_key, tmp_path):
    pem, _ = es256_key
    p = tmp_path / "AuthKey.p8"
    p.write_text(pem)
    monkeypatch.setenv("APPLE_MUSIC_TEAM_ID", "T")
    monkeypatch.setenv("APPLE_MUSIC_KEY_ID", "K")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY", "")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY_PATH", str(p))
    get_settings.cache_clear()
    assert apple_music.developer_token()


async def test_apple_preview_picks_matching_song(monkeypatch, es256_key):
    pem, _ = es256_key
    monkeypatch.setenv("APPLE_MUSIC_TEAM_ID", "T")
    monkeypatch.setenv("APPLE_MUSIC_KEY_ID", "K")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY", pem)
    get_settings.cache_clear()

    def handler(req: httpx.Request):
        assert req.headers["Authorization"].startswith("Bearer ")
        assert "/catalog/us/search" in str(req.url)
        return httpx.Response(200, json={"results": {"songs": {"data": [
            {"attributes": {"name": "Creep (Live)", "artistName": "Some Cover Band", "previews": [{"url": "https://x/cover.m4a"}]}},
            {"attributes": {"name": "Creep", "artistName": "Radiohead", "url": "https://music.apple.com/us/song/1",
                            "previews": [{"url": "https://x/real.m4a"}], "artwork": {"url": "https://art/{w}x{h}.jpg"}}},
        ]}}})

    install(monkeypatch, handler)
    result = await preview.resolve_preview("Radiohead", "Creep")
    assert result.available and result.preview_url == "https://x/real.m4a"
    assert result.artwork_url == "https://art/300x300.jpg"
    assert result.provider == "apple_music"


async def test_preview_never_raises(monkeypatch, es256_key):
    pem, _ = es256_key
    monkeypatch.setenv("APPLE_MUSIC_TEAM_ID", "T")
    monkeypatch.setenv("APPLE_MUSIC_KEY_ID", "K")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY", pem)
    get_settings.cache_clear()
    install(monkeypatch, lambda req: httpx.Response(500))
    result = await preview.resolve_preview("Radiohead", "Creep")
    assert result.available is False


async def test_preview_unavailable_when_nothing_configured(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    result = await preview.resolve_preview("Radiohead", "Creep")
    assert result == preview.UNAVAILABLE


def _apple_env(monkeypatch, pem):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    monkeypatch.setenv("APPLE_MUSIC_TEAM_ID", "T")
    monkeypatch.setenv("APPLE_MUSIC_KEY_ID", "K")
    monkeypatch.setenv("APPLE_MUSIC_PRIVATE_KEY", pem)
    get_settings.cache_clear()


def _creep() -> TrackDetails:
    return TrackDetails(id="tr:radiohead|creep", name="Creep", artist=ArtistRef(id="ar:radiohead", name="Radiohead"))


SEARCH_PREFIX = "https://music.apple.com/us/search?term="


async def test_song_link_opens_the_apple_song(monkeypatch, es256_key):
    _apple_env(monkeypatch, es256_key[0])
    calls = []

    def handler(req: httpx.Request):
        calls.append(req)
        return httpx.Response(200, json={"results": {"songs": {"data": [
            {"attributes": {"name": "Creep", "artistName": "Radiohead",
                            "url": "https://music.apple.com/us/album/creep/1097861387?i=1097861703",
                            "previews": [{"url": "https://x/real.m4a"}]}},
        ]}}})

    install(monkeypatch, handler)
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music == "https://music.apple.com/us/album/creep/1097861387?i=1097861703"
    # The play button reuses the same cached lookup: no second Apple request.
    result = await preview.resolve_preview("Radiohead", "Creep")
    assert result.preview_url == "https://x/real.m4a"
    assert len(calls) == 1


async def test_song_link_falls_back_to_search_when_apple_has_no_match(monkeypatch, es256_key):
    _apple_env(monkeypatch, es256_key[0])
    install(monkeypatch, lambda req: httpx.Response(200, json={"results": {}}))
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music.startswith(SEARCH_PREFIX)


async def test_song_link_falls_back_to_search_on_apple_error(monkeypatch, es256_key):
    _apple_env(monkeypatch, es256_key[0])
    install(monkeypatch, lambda req: httpx.Response(503))
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music.startswith(SEARCH_PREFIX)


async def test_song_link_falls_back_to_search_when_apple_is_slow(monkeypatch, es256_key):
    _apple_env(monkeypatch, es256_key[0])
    monkeypatch.setattr(links, "SONG_URL_TIMEOUT", 0.05)

    async def slow(artist, track):
        await asyncio.sleep(1)

    monkeypatch.setattr(apple_music, "search_song_preview", slow)
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music.startswith(SEARCH_PREFIX)


async def test_song_link_is_search_without_keys(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music.startswith(SEARCH_PREFIX)


def _itunes_env(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    monkeypatch.setenv("ITUNES_PREVIEWS", "1")
    get_settings.cache_clear()


def _song(artist, name, url="https://music.apple.com/us/album/x/1?i=2&uo=4", preview_url="https://audio/p.m4a"):
    return {"wrapperType": "track", "kind": "song", "artistName": artist, "trackName": name, "previewUrl": preview_url,
            "trackViewUrl": url, "artworkUrl100": "https://art/100x100bb.jpg"}


def _itunes(monkeypatch, results, calls=None):
    def handler(req: httpx.Request):
        assert req.url.host == "itunes.apple.com"
        if calls is not None:
            calls.append(req)
        return httpx.Response(200, json={"resultCount": len(results), "results": results},
                              headers={"content-type": "text/javascript; charset=utf-8"})

    install(monkeypatch, handler)


async def test_itunes_preview_without_keys(monkeypatch):
    _itunes_env(monkeypatch)
    _itunes(monkeypatch, [
        _song("Massive Attack", "Teardrop (Mad Professor Mazaruni Vocal Mix)", preview_url="https://audio/remix.m4a"),
        _song("Massive Attack", "Teardrop", url="https://music.apple.com/us/album/teardrop/724466069?i=724466291&uo=4"),
    ])
    result = await preview.resolve_preview("Massive Attack", "Teardrop")
    assert result.available and result.provider == "itunes"
    assert result.preview_url == "https://audio/p.m4a"
    assert result.track_url == "https://music.apple.com/us/album/teardrop/724466069?i=724466291"
    assert result.artwork_url == "https://art/300x300bb.jpg"


async def test_itunes_song_link_reuses_the_preview_lookup(monkeypatch):
    _itunes_env(monkeypatch)
    calls = []
    _itunes(monkeypatch, [_song("Radiohead", "Creep", url="https://music.apple.com/us/album/creep/1?i=9&uo=4")], calls)
    track = await links.enrich_track(_creep())
    assert track.external_urls.apple_music == "https://music.apple.com/us/album/creep/1?i=9"
    assert (await preview.resolve_preview("Radiohead", "Creep")).available
    assert len(calls) == 1


async def test_itunes_never_plays_a_wrong_artist_cover(monkeypatch):
    _itunes_env(monkeypatch)
    _itunes(monkeypatch, [_song("Daniel Chuer", "Creep (Radiohead Cover)"), _song("Lena Hall", "Creep"),
                          _song("Stone Temple Pilots", "Creep")])
    assert await preview.resolve_preview("Radiohead", "Creep") == preview.UNAVAILABLE


async def test_itunes_prefers_the_original_over_variants():
    original, live, acoustic = (_song("Portishead", n) for n in ("Glory Box", "Glory Box (Live / Remastered 2023)", "Glory Box (Acoustic)"))
    assert itunes.score(original, "Portishead", "Glory Box") > itunes.score(live, "Portishead", "Glory Box")
    assert itunes.score(original, "Portishead", "Glory Box") > itunes.score(acoustic, "Portishead", "Glory Box")
    # Only a variant exists: same artist and base name still plays.
    assert itunes.score(acoustic, "Radiohead", "Glory Box") is None
    assert itunes.score(_song("Radiohead", "Creep (Acoustic)"), "Radiohead", "Creep") is not None
    # Asking for the live version does not penalise it.
    assert itunes.score(live, "Portishead", "Glory Box (Live / Remastered 2023)") > itunes.score(original, "Portishead", "Glory Box (Live / Remastered 2023)")


def test_itunes_artist_credits():
    weeknd = _song("The Weeknd & ROSALÍA", "Blinding Lights (Remix)")
    assert itunes.score(weeknd, "The Weeknd", "Blinding Lights") is not None
    assert itunes.score(_song("Simon & Garfunkel", "The Boxer"), "Simon and Garfunkel", "The Boxer") is not None
    assert itunes.score(_song("Radiohead", "Creep", preview_url=None), "Radiohead", "Creep") is None


@pytest.mark.parametrize("status", [403, 429, 503])
async def test_itunes_error_is_cached_briefly(monkeypatch, status):
    _itunes_env(monkeypatch)
    install(monkeypatch, lambda req: httpx.Response(status))
    assert await preview.resolve_preview("Radiohead", "Creep") == preview.UNAVAILABLE
    key = "preview:radiohead::creep"
    expires_at, _ = cache._data[key]
    assert expires_at - time.monotonic() <= preview.ERROR_TTL
    # After the short TTL the next call asks iTunes again.
    cache.delete(key)
    _itunes(monkeypatch, [_song("Radiohead", "Creep")])
    assert (await preview.resolve_preview("Radiohead", "Creep")).available


async def test_itunes_off_switch(monkeypatch):
    _itunes_env(monkeypatch)
    monkeypatch.setenv("ITUNES_PREVIEWS", "0")
    get_settings.cache_clear()
    install(monkeypatch, lambda req: pytest.fail("iTunes must not be called"))
    assert await preview.resolve_preview("Radiohead", "Creep") == preview.UNAVAILABLE


async def test_itunes_not_called_in_mock_mode(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    monkeypatch.setenv("ITUNES_PREVIEWS", "1")
    get_settings.cache_clear()
    install(monkeypatch, lambda req: pytest.fail("iTunes must not be called"))
    assert await preview.resolve_preview("Radiohead", "Creep") == preview.UNAVAILABLE


async def test_musickit_goes_before_itunes(monkeypatch, es256_key):
    _apple_env(monkeypatch, es256_key[0])
    monkeypatch.setenv("ITUNES_PREVIEWS", "1")
    get_settings.cache_clear()
    hosts = []

    def handler(req: httpx.Request):
        hosts.append(req.url.host)
        return httpx.Response(200, json={"results": {"songs": {"data": [
            {"attributes": {"name": "Creep", "artistName": "Radiohead", "url": "https://music.apple.com/us/song/1",
                            "previews": [{"url": "https://x/real.m4a"}]}}]}}})

    install(monkeypatch, handler)
    result = await preview.resolve_preview("Radiohead", "Creep")
    assert result.provider == "apple_music" and hosts == ["api.music.apple.com"]


async def test_musicbrainz_links(monkeypatch):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.headers.get("User-Agent"))
        return httpx.Response(200, json={"relations": [
            {"type": "streaming", "url": {"resource": "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb"}},
            {"type": "streaming", "url": {"resource": "https://music.apple.com/us/artist/radiohead/657515"}},
            {"type": "wikidata", "url": {"resource": "https://www.wikidata.org/wiki/Q42"}},
        ]})

    install(monkeypatch, handler)
    monkeypatch.setenv("MUSICBRAINZ_USER_AGENT", "TuneGraph/test (t@example.com)")
    get_settings.cache_clear()
    links = await musicbrainz.get_artist_links("a74b1b7f-71a5-4011-9441-d0b5e4122711")
    assert links["spotify"].endswith("4Z8W4fKeB5YxbusRsdQVPb")
    assert "apple_music" in links and "musicbrainz" in links
    assert seen == ["TuneGraph/test (t@example.com)"]
    await musicbrainz.get_artist_links("a74b1b7f-71a5-4011-9441-d0b5e4122711")
    assert len(seen) == 1  # cached


async def test_musicbrainz_release_date_prefers_album_then_recordings_then_mbid(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    calls = []

    def handler(req):
        calls.append(req.url.path + "?" + str(req.url.params.get("query", "")))
        if req.url.path.endswith("/release-group"):
            return httpx.Response(200, json={"release-groups": [
                {"score": 100, "title": "Weezer", "primary-type": "Album", "first-release-date": "2001-05-07"},
                {"score": 100, "title": "Weezer", "primary-type": "Album", "first-release-date": "1994-05-10"},
                {"score": 88, "title": "Weezer: The Remixes", "secondary-types": ["Remix"], "first-release-date": "1990"},
            ]})
        if req.url.path.endswith("/recording"):
            if "Nothing" in str(req.url.params.get("query")):
                return httpx.Response(200, json={"recordings": []})
            return httpx.Response(200, json={"recordings": [
                {"score": 100, "title": "Creep", "length": 236000, "first-release-date": "1995"},
                {"score": 100, "title": "Creep", "length": 179000, "first-release-date": "1992-09-21"},
                {"score": 100, "title": "Creep (live)", "length": 235000, "first-release-date": "1980"},
            ]})
        if "/recording/rec-1" in req.url.path:
            return httpx.Response(200, json={"id": "rec-1", "first-release-date": "1998-06-28"})
        return httpx.Response(404)

    install(monkeypatch, handler)
    monkeypatch.setattr(musicbrainz, "MIN_INTERVAL", 0)
    # 1. Album known: earliest exact-title release group, ignoring remixes/compilations.
    assert await musicbrainz.get_first_release_date("Weezer", "Buddy Holly", album="Weezer") == "1994-05-10"
    assert calls == ['/ws/2/release-group?releasegroup:"Weezer" AND artist:"Weezer" AND NOT secondarytype:compilation']
    # 2. No album: recordings with a matching length win over closer-titled but wrong-length ones.
    assert await musicbrainz.get_first_release_date("Radiohead", "Creep", duration_seconds=235) == "1995"
    assert await musicbrainz.get_first_release_date("Radiohead", "Creep") == "1992-09-21"
    # 3. Nothing found by search: fall back to the MBID Last.fm gave us.
    assert await musicbrainz.get_first_release_date("Nobody", "Nothing", "rec-1") == "1998-06-28"
    assert calls[-1].startswith("/ws/2/recording/rec-1")


async def test_musicbrainz_retries_once_when_busy(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    attempts = []

    def handler(req):
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(503, json={"error": "The MusicBrainz web server is currently busy."})
        return httpx.Response(200, json={"release-groups": [
            {"score": 100, "title": "Dummy", "primary-type": "Album", "first-release-date": "1994-08-22"},
        ]})

    install(monkeypatch, handler)
    monkeypatch.setattr(musicbrainz, "MIN_INTERVAL", 0)
    monkeypatch.setattr(musicbrainz.asyncio, "sleep", _no_sleep)
    assert await musicbrainz.get_first_release_date("Portishead", "Glory Box", album="Dummy") == "1994-08-22"
    assert len(attempts) == 2


async def _no_sleep(_seconds):
    return None
