"""Exclusions apply to the shared pool before selection in every ranking mode."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models.artist import ArtistRef
from app.models.track import SimilarTrack, TrackRef
from app.services import lastfm, similarity


@pytest.fixture
def pool(monkeypatch):
    seed = TrackRef(id="seed", name="Seed", artist=ArtistRef(id="a", name="Artist"))
    candidates = [SimilarTrack(id=f"c{i}", name=f"C{i}", artist=seed.artist, similarity=0.8) for i in range(20)]
    calls = []

    async def fetch(track_id, limit):
        calls.append(limit)
        return seed, candidates[:limit]

    async def tags(track_id):
        return [] if track_id == "missing" else ["rock"]

    monkeypatch.setattr(lastfm, "get_similar_tracks", fetch)
    monkeypatch.setattr(lastfm, "get_track_tags", tags)
    return calls


@pytest.mark.parametrize("trail", [None, [], ["seed"], ["old", "seed"], ["missing", "seed"],
                                        ["seed", *(f"s{i}" for i in range(50))]])
@pytest.mark.parametrize("limit", [1, 7, 20])
async def test_filter_before_selection_and_fallback(pool, trail, limit):
    result = await similarity.select_similar_tracks("seed", limit, trail, ["c0", "c1", "c0"])
    assert [t.id for t in result.tracks] == [f"c{i}" for i in range(2, min(20, 2 + limit))]
    assert result.excluded_count == 2
    assert pool == [20]
    assert all(t.similarity == pytest.approx(0.88) and t.shared_tags == ["rock"] for t in result.tracks)


@pytest.mark.parametrize("trail", [None, ["old", "seed"]])
async def test_all_excluded_and_no_context_cache_contamination(pool, trail):
    excluded = [f"c{i}" for i in range(20)]
    assert (await similarity.select_similar_tracks("seed", 7, trail, excluded)).tracks == []
    again = await similarity.select_similar_tracks("seed", 7, trail)
    assert len(again.tracks) == 7
    assert again.excluded_count == 0


async def test_timeout_fallback_still_filters(pool, monkeypatch):
    import asyncio

    async def timeout(awaitable, timeout):
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr(asyncio, "wait_for", timeout)
    result = await similarity.select_similar_tracks("seed", 7, ["old", "seed"], ["c0"])
    assert result.ranking.fallback_reason == "timeout"
    assert [t.id for t in result.tracks] == [f"c{i}" for i in range(1, 8)]


async def test_api_exclusions_limits_and_mock_compatibility(pool):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/tracks/seed/similar", params=[("excluded", "c0"), ("limit", "7")])
        assert response.status_code == 200
        assert len(response.json()["tracks"]) == 7
        assert response.json()["excluded_count"] == 1
        assert "c0" not in [t["id"] for t in response.json()["tracks"]]
        for excluded in [[""], ["x" * 201], ["x"] * 101]:
            response = await client.get("/api/tracks/seed/similar", params=[("excluded", i) for i in excluded])
            assert response.status_code == 422
        response = await client.get("/api/tracks/seed/similar", params=[("excluded", str(i)) for i in range(100)])
        assert response.status_code == 200


async def test_real_mock_provider_exclusions(monkeypatch):
    from app.config import get_settings
    from app.cache.cache import cache

    monkeypatch.setattr(get_settings(), "mock_providers", True)
    cache.clear()
    # Use a fixture search ID instead of inventing a provider identifier.
    tracks = await lastfm.search_tracks("Creep", 8)
    seed = tracks[0]
    baseline = await similarity.select_similar_tracks(seed.id, 20)
    assert baseline.tracks
    excluded = [t.id for t in baseline.tracks]
    result = await similarity.select_similar_tracks(seed.id, 7, excluded=excluded)
    assert not result.tracks
    assert result.excluded_count == len(excluded)
