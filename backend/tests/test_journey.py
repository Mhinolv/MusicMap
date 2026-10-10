"""Journey selection: membership, compatibility, truthful edges and bounded work."""
import pytest

from app.models.artist import ArtistRef
from app.models.track import SimilarTrack, TrackRef
from app.services import lastfm, similarity


@pytest.fixture
def pool(monkeypatch):
    seed = TrackRef(id='seed', name='Seed', artist=ArtistRef(id='artist', name='Artist'))
    candidates = [SimilarTrack(id=f'c{i}', name=f'C{i}', artist=seed.artist, similarity=0.8) for i in range(20)]
    calls = []

    async def fetch(track_id, limit):
        calls.append(limit)
        return seed, candidates[:limit]

    async def tags(track_id):
        return ['jazz'] if track_id == 'old' or track_id == 'c7' else ['rock']

    monkeypatch.setattr(lastfm, 'get_similar_tracks', fetch)
    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    return calls


async def test_journey_can_select_outside_old_top_seven(pool):
    result = await similarity.select_similar_tracks('seed', 7, ['seed', 'old'])
    assert 'c7' in [t.id for t in result.tracks]
    assert len(result.tracks) == 7
    assert pool == [20]
    assert result.ranking.mode == 'journey'
    candidate = next(t for t in result.tracks if t.id == 'c7')
    assert candidate.similarity == pytest.approx(0.48)
    assert candidate.shared_tags == []  # still relative to seed, not the jazz trail


async def test_api_does_not_discard_journey_context(pool):
    from httpx import ASGITransport, AsyncClient
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/tracks/seed/similar', params=[('limit', '7'), ('trail', 'seed'), ('trail', 'old')])
    assert response.status_code == 200
    assert 'c7' in [t['id'] for t in response.json()['tracks']]


@pytest.mark.parametrize('trail', [None, [], ['seed'], ['seed', 'seed']])
async def test_parent_compatibility_and_single_stop(pool, trail):
    result = await similarity.select_similar_tracks('seed', 7, trail)
    _, original = await lastfm.get_similar_tracks('seed', 7)
    expected = await similarity.rerank_similar_tracks('seed', original)
    assert result.tracks == expected
    assert result.ranking.mode == 'parent'
    assert result.ranking.fallback_reason is None
    assert pool == [7, 7]


@pytest.mark.parametrize('count,mode,reason,fetch_limit', [
    (2, 'journey', None, 20), (50, 'journey', None, 20),
    (51, 'parent', 'cap_exceeded', 7),
])
async def test_unique_context_cap(pool, count, mode, reason, fetch_limit):
    stops = ['seed', *(f'stop{i}' for i in range(count - 1))]
    result = await similarity.select_similar_tracks('seed', 7, stops + stops)
    assert result.ranking.mode == mode
    assert result.ranking.stop_count == count
    assert result.ranking.fallback_reason == reason
    assert pool == [fetch_limit]


async def test_expansion_seed_is_included(pool):
    result = await similarity.select_similar_tracks('seed', 7, ['old'])
    assert result.ranking.stop_count == 2
    assert result.ranking.mode == 'journey'


async def test_missing_trail_tags_falls_back_to_exact_parent(pool, monkeypatch):
    original_tags = lastfm.get_track_tags

    async def tags(track_id):
        return [] if track_id == 'old' else await original_tags(track_id)

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 7, ['old', 'seed'])
    assert result.ranking.fallback_reason == 'missing_tags'
    assert [t.id for t in result.tracks] == [f'c{i}' for i in range(7)]


async def test_deadline_cancels_optional_work_and_falls_back(pool, monkeypatch):
    import asyncio

    original_tags = lastfm.get_track_tags
    cancelled = False

    async def tags(track_id):
        nonlocal cancelled
        if track_id == 'old':
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                cancelled = True
                raise
        return await original_tags(track_id)

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    monkeypatch.setattr(similarity, 'JOURNEY_TIMEOUT', 0.01)
    result = await similarity.select_similar_tracks('seed', 7, ['old', 'seed'])
    assert result.ranking.fallback_reason == 'timeout'
    assert result.ranking.mode == 'parent'
    assert [t.id for t in result.tracks] == [f'c{i}' for i in range(7)]
    assert cancelled


async def test_tag_concurrency_is_bounded_and_ids_deduplicated(pool, monkeypatch):
    import asyncio
    from collections import Counter

    active = peak = 0
    calls = Counter()

    async def tags(track_id):
        nonlocal active, peak
        calls[track_id] += 1
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.001)
        active -= 1
        return ['rock']

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 7, ['seed', 'old', 'old'])
    assert result.ranking.mode == 'journey'
    assert peak <= similarity.TAG_CONCURRENCY
    assert calls['old'] == 1
    assert active == 0


def test_recency_is_linear_positive_and_stop_vectors_are_normalized():
    vector = similarity.journey_vector([['old'], ['middle'], ['recent']])
    assert vector == {'old': 1, 'middle': 2, 'recent': 3}
    assert sum(w*w for w in similarity.journey_vector([['a', 'b']]).values()) == pytest.approx(1)
    assert similarity.journey_vector([[], [' ']]) == {}


@pytest.mark.parametrize('limit', [1, 7, 20])
async def test_result_limit_and_stable_ties(pool, limit):
    result = await similarity.select_similar_tracks('seed', limit, ['seed', 'same-tags'])
    assert len(result.tracks) == limit
    # c7 has disjoint tags, all other scores tie and keep provider order.
    assert [t.id for t in result.tracks[:min(limit, 7)]] == [f'c{i}' for i in range(min(limit, 7))]


async def test_empty_candidates_are_safe(pool, monkeypatch):
    async def fetch(track_id, limit):
        return TrackRef(id='seed', name='Seed', artist=ArtistRef(id='a', name='Artist')), []

    monkeypatch.setattr(lastfm, 'get_similar_tracks', fetch)
    assert (await similarity.select_similar_tracks('seed', 7, ['seed', 'old'])).tracks == []


async def test_sparse_candidate_and_provider_failure_are_soft(pool, monkeypatch):
    from app.services.errors import ProviderError

    async def tags(track_id):
        if track_id == 'c0':
            raise ProviderError('lastfm', 'busy')
        if track_id == 'c1':
            return []
        return ['rock']

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 20, ['seed', 'old'])
    assert result.ranking.mode == 'journey'
    for candidate in result.tracks:
        if candidate.id in ('c0', 'c1'):
            assert candidate.similarity == 0.8
            assert candidate.shared_tags == []
