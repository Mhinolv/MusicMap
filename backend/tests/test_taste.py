"""Taste requests use canonical music facts and parse JevLab's response shape."""

import pytest
from pydantic import ValidationError
from httpx import ASGITransport, AsyncClient, MockTransport, Response

from app.config import get_settings
from app.models.taste import TasteProfile
from app.services import jev
from app.services.errors import ProviderError


@pytest.fixture(autouse=True)
def _mock_mode(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
async def client():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_artist_and_track_evaluation_use_provider_metadata(client, monkeypatch):
    captured = []

    async def estimate(profile, target):
        captured.append(target)
        return 0.82, "jev-test"

    monkeypatch.setattr(jev, "estimate_fit", estimate)
    artist = (await client.get("/api/artists/search", params={"q": "radiohead"})).json()["artists"][0]
    song = (await client.get("/api/tracks/search", params={"q": "creep"})).json()["tracks"][0]
    profile = {"liked_artists": ["Portishead"], "liked_tracks": [], "liked_genres": [], "disliked": [], "notes": ""}

    for kind, item in (("artist", artist), ("track", song)):
        response = await client.post("/api/taste/evaluate", json={"kind": kind, "item_id": item["id"], "profile": profile})
        assert response.status_code == 200
        assert response.json()["estimate"] == 0.82
        assert response.json()["item_id"] == item["id"]

    assert captured[0]["name"] == "Radiohead"
    assert captured[1]["title"] == "Creep"
    assert captured[1]["artist"] == "Radiohead"


async def test_empty_positive_profile_is_rejected(client):
    response = await client.post("/api/taste/evaluate", json={
        "kind": "artist", "item_id": "nm:radiohead",
        "profile": {"disliked": ["metal"]},
    })
    assert response.status_code == 422


async def test_spotify_pkce_config_exposes_only_client_id(client, monkeypatch):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "public-test-id")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "private-test-secret")
    get_settings.cache_clear()
    response = await client.get("/api/spotify/config")
    assert response.status_code == 200
    assert response.json() == {"client_id": "public-test-id"}


async def test_jev_adapter_parses_single_question_response(monkeypatch):
    monkeypatch.setenv("JEV_API_KEY", "test-key")
    get_settings.cache_clear()

    def handler(request):
        assert request.headers["X-API-Key"] == "test-key"
        assert request.url.path == "/noul"
        assert b'"taste_fit"' in request.content
        return Response(200, json=[{"model": "jev-test", "answers": {"taste_fit": {"type": "noul", "noul": 0.73}}}])

    async with AsyncClient(transport=MockTransport(handler)) as http:
        monkeypatch.setattr(jev, "get_client", lambda: http)
        score, model = await jev.estimate_fit(TasteProfile(liked_artists=["Radiohead"]), {"kind": "artist", "name": "Muse"})
    assert (score, model) == (0.73, "jev-test")


async def test_jev_adapter_rejects_invalid_score(monkeypatch):
    monkeypatch.setenv("JEV_API_KEY", "test-key")
    get_settings.cache_clear()

    async with AsyncClient(transport=MockTransport(lambda _: Response(200, json={"answers": {"taste_fit": {"noul": 1.5}}}))) as http:
        monkeypatch.setattr(jev, "get_client", lambda: http)
        with pytest.raises(ProviderError, match="invalid response"):
            await jev.estimate_fit(TasteProfile(liked_genres=["jazz"]), {"kind": "song", "title": "Example"})


@pytest.mark.parametrize("field", ["liked_artists", "liked_tracks", "liked_genres", "disliked"])
@pytest.mark.parametrize("count", [0, 15, 49, 50, 51])
def test_taste_list_capacity(field, count):
    profile = {field: [f"Entry {i}" for i in range(count)], "notes": "Positive note"}
    if count > 50:
        with pytest.raises(ValidationError) as error:
            TasteProfile(**profile)
        assert error.value.errors()[0]["loc"] == (field,)
        assert error.value.errors()[0]["type"] == "too_long"
    else:
        assert len(getattr(TasteProfile(**profile), field)) == count


@pytest.mark.parametrize("kind", ["artist", "track"])
async def test_mock_evaluation_accepts_fifty_preferences(client, monkeypatch, kind):
    async def estimate(profile, target):
        assert all(len(getattr(profile, field)) == 50
                   for field in ("liked_artists", "liked_tracks", "liked_genres", "disliked"))
        return 0.82, "jev-test"

    monkeypatch.setattr(jev, "estimate_fit", estimate)
    endpoint, query, key = ("artists", "radiohead", "artists") if kind == "artist" else ("tracks", "creep", "tracks")
    item_id = (await client.get(f"/api/{endpoint}/search", params={"q": query})).json()[key][0]["id"]
    profile = {field: [f"Entry {i}" for i in range(50)]
               for field in ("liked_artists", "liked_tracks", "liked_genres", "disliked")}
    response = await client.post("/api/taste/evaluate", json={
        "kind": kind, "item_id": item_id, "profile": profile,
    })
    assert response.status_code == 200
