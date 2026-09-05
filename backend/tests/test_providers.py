"""Apple Music token signing, MusicBrainz link parsing, preview fallback."""

from __future__ import annotations

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.cache.cache import cache
from app.config import get_settings
from app.services import apple_music, http as http_mod, musicbrainz, preview


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
