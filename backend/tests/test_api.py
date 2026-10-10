"""End-to-end through FastAPI with the mock provider."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings


@pytest.fixture(autouse=True)
def _mock_mode(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    get_settings.cache_clear()
    cache.clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
async def client():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_full_flow(client):
    r = await client.get("/api/artists/search", params={"q": "radiohead"})
    assert r.status_code == 200
    artist_id = r.json()["artists"][0]["id"]

    r = await client.get(f"/api/artists/{artist_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Radiohead"
    assert body["external_urls"]["youtube"].startswith("https://www.youtube.com/")

    r = await client.get(f"/api/artists/{artist_id}/similar", params={"limit": 6})
    assert r.status_code == 200
    similar = r.json()["artists"]
    assert 1 <= len(similar) <= 6
    assert all(0 <= s["similarity"] <= 1 for s in similar)

    r = await client.get(f"/api/artists/{artist_id}/tracks", params={"limit": 5})
    assert r.status_code == 200 and len(r.json()["tracks"]) == 5

    r = await client.get(f"/api/artists/{artist_id}/tracks/Creep/preview")
    assert r.status_code == 200 and r.json()["available"] is False


async def test_unknown_artist_404(client):
    r = await client.get("/api/artists/nm:definitely-not-real")
    assert r.status_code == 404
    assert r.json()["provider"] == "lastfm"


async def test_search_validation(client):
    r = await client.get("/api/artists/search", params={"q": ""})
    assert r.status_code == 422


async def test_song_seeded_map(client):
    r = await client.get("/api/tracks/search", params={"q": "creep"})
    assert r.status_code == 200
    tracks = r.json()["tracks"]
    assert tracks[0]["name"] == "Creep"
    assert tracks[0]["artist"]["name"] == "Radiohead"
    track_id = tracks[0]["id"]
    assert track_id.startswith("tr:")

    r = await client.get(f"/api/tracks/{track_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Creep"
    assert body["album"]["title"] == "Pablo Honey"
    assert body["release_date"] == "1992-09-21"  # mock details carry it; live mode uses /release-date
    r = await client.get(f"/api/tracks/{track_id}/release-date")
    assert r.status_code == 200 and r.json()["release_date"] == "1992-09-21"
    assert body["duration_seconds"] == 238
    assert "alternative" in body["tags"]
    assert body["external_urls"]["youtube"].startswith("https://www.youtube.com/")

    r = await client.get(f"/api/tracks/{track_id}/similar", params={"limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["track"]["name"] == "Creep"
    similar = body["tracks"]
    assert 2 <= len(similar) <= 5
    assert all(s["id"] != track_id for s in similar)
    assert len({s["id"] for s in similar}) == len(similar)
    assert all(0 <= s["similarity"] <= 1 for s in similar)
    assert all(isinstance(s["shared_tags"], list) for s in similar)
    # Sibling Radiohead songs share tags with the seed, so at least one edge explains itself.
    assert any(s["shared_tags"] for s in similar)
    # Similar songs are songs, each with their own artist, and can be expanded in turn.
    nxt = similar[0]
    r = await client.get(f"/api/tracks/{nxt['id']}/similar", params={"limit": 3})
    assert r.status_code == 200 and len(r.json()["tracks"]) >= 1

    r = await client.get(f"/api/tracks/{track_id}/preview")
    assert r.status_code == 200 and r.json()["available"] is False


async def test_unknown_track_404(client):
    r = await client.get("/api/tracks/tr:nobody|nothing/similar")
    assert r.status_code == 404
    r = await client.get("/api/tracks/tr:nobody|nothing")
    assert r.status_code == 404


async def test_journey_off_matches_legacy_for_all_mock_seeds(client):
    from urllib.parse import quote
    from app.models.graph import make_track_id
    from app.services import lastfm, mock, similarity
    for artist in mock._ARTISTS.values():
        for song in artist['tracks']:
            track_id = make_track_id(artist=artist['name'], track=song)
            _, candidates = await lastfm.get_similar_tracks(track_id, 7)
            expected = await similarity.rerank_similar_tracks(track_id, candidates)
            response = await client.get(f'/api/tracks/{quote(track_id, safe="")}/similar', params={'limit': 7})
            assert response.status_code == 200
            assert response.json()['tracks'] == [t.model_dump(mode='json') for t in expected]
            assert response.json()['ranking']['mode'] == 'parent'


async def test_mock_journey_can_promote_eighth_candidate(client):
    seed = 'tr:radiohead|creep'
    # Repeated Björk songs steer toward the eighth candidate, Army of Me.
    stops = ['tr:radiohead|creep', 'tr:björk|hyperballad', 'tr:björk|jóga', 'tr:björk|human behaviour']
    off = await client.get(f'/api/tracks/{seed}/similar', params={'limit': 7})
    on = await client.get(f'/api/tracks/{seed}/similar', params=[('limit', '7'), *(('trail', s) for s in stops)])
    assert on.status_code == 200
    assert on.json()['ranking']['mode'] == 'journey'
    off_ids = {t['id'] for t in off.json()['tracks']}
    assert any(t['id'] not in off_ids for t in on.json()['tracks'])
    assert len(on.json()['tracks']) == 7


async def test_artist_similar_ignores_song_journey(client):
    plain = await client.get('/api/artists/nm:radiohead/similar', params={'limit': 7})
    context = await client.get('/api/artists/nm:radiohead/similar', params={'limit': 7, 'trail': 'tr:radiohead|creep'})
    assert plain.status_code == context.status_code == 200
    assert plain.json() == context.json()


async def test_song_journey_over_cap_returns_parent_fallback(client):
    response = await client.get('/api/tracks/tr:radiohead|creep/similar',
        params=[('limit', '7'), *(('trail', f'tr:test|{i}') for i in range(51))])
    assert response.status_code == 200
    assert response.json()['ranking']['fallback_reason'] == 'cap_exceeded'


@pytest.mark.parametrize('params', [
    [('trail', '')], [('trail', 'x' * 201)], [('trail', 'seed')] * 201,
    [('limit', '0')], [('limit', '21')],
])
async def test_journey_request_is_bounded(client, params):
    response = await client.get('/api/tracks/tr:radiohead|creep/similar', params=params)
    assert response.status_code == 422
