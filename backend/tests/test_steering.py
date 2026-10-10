"""Selection-only tag steering, including mock mode and request bounds."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings
from app.main import app
from app.models.artist import ArtistRef
from app.models.track import SimilarTrack, TrackRef
from app.services import lastfm, similarity


@pytest.fixture
def pool(monkeypatch):
    seed = TrackRef(id='seed', name='Seed', artist=ArtistRef(id='a', name='Artist'))
    candidates = [SimilarTrack(id=f'c{i}', name=f'C{i}', artist=seed.artist, similarity=0.8) for i in range(20)]
    calls = []

    async def fetch(track_id, limit):
        calls.append(limit)
        return seed, candidates[:limit]

    async def tags(track_id):
        return ['jazz'] if track_id == 'c7' else ['rock']

    monkeypatch.setattr(lastfm, 'get_similar_tracks', fetch)
    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    return calls


@pytest.mark.parametrize('trail', [None, ['seed', 'old']])
@pytest.mark.parametrize('limit', [1, 7, 20])
async def test_boost_changes_membership_but_never_edges(pool, trail, limit):
    baseline = await similarity.select_similar_tracks('seed', limit, trail)
    result = await similarity.select_similar_tracks('seed', limit, trail, emphasized_tags=[' Jazz '])
    assert len(result.tracks) == limit
    assert result.tracks[0].id == 'c7'
    if limit <= 7:
        assert 'c7' not in [t.id for t in baseline.tracks]
    assert result.tracks[0].similarity == pytest.approx(0.48)
    assert result.tracks[0].shared_tags == []
    assert result.ranking.steering_matched is True
    assert pool[-1] == 20
    assert result.ranking.mode == ('journey' if trail else 'parent')


@pytest.mark.parametrize('trail', [None, ['seed', 'old'], ['seed'] * 2])
@pytest.mark.parametrize('emphasis', [None, [], ['no match']])
async def test_off_and_no_match_preserve_baseline(pool, trail, emphasis):
    baseline = await similarity.select_similar_tracks('seed', 7, trail)
    result = await similarity.select_similar_tracks('seed', 7, trail, emphasized_tags=emphasis)
    assert result.tracks == baseline.tracks
    assert result.ranking.steering_matched == (False if emphasis else None)


@pytest.mark.parametrize('count', [0, 1, 20])
async def test_empty_tags_do_not_exclude_candidates(pool, monkeypatch, count):
    original = lastfm.get_similar_tracks

    async def fetch(track_id, limit):
        track, candidates = await original(track_id, limit)
        return track, candidates[:count]

    async def tags(track_id):
        return []

    monkeypatch.setattr(lastfm, 'get_similar_tracks', fetch)
    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 7, emphasized_tags=['jazz'])
    assert len(result.tracks) == min(count, 7)
    assert result.ranking.steering_matched is False
    assert all(t.similarity == 0.8 for t in result.tracks)


async def test_exclusions_win_over_emphasis(pool):
    result = await similarity.select_similar_tracks('seed', 7, excluded=['c7'], emphasized_tags=['jazz'])
    assert 'c7' not in [t.id for t in result.tracks]
    assert result.excluded_count == 1
    assert result.ranking.steering_matched is False


@pytest.mark.parametrize('fallback', ['missing_tags', 'cap_exceeded', 'timeout'])
async def test_steering_survives_journey_fallback(pool, monkeypatch, fallback):
    import asyncio
    original = lastfm.get_track_tags

    async def tags(track_id):
        if track_id == 'old':
            if fallback == 'timeout':
                await asyncio.sleep(1)
            return []
        return await original(track_id)

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    monkeypatch.setattr(similarity, 'JOURNEY_TIMEOUT', 0.01)
    trail = [f'stop{i}' for i in range(51)] if fallback == 'cap_exceeded' else ['seed', 'old']
    result = await similarity.select_similar_tracks('seed', 7, trail, emphasized_tags=['jazz'])
    assert result.ranking.fallback_reason == fallback
    assert result.tracks[0].id == 'c7'


@pytest.mark.parametrize('tags,status', [([], 200), (['jazz'], 200), (['jazz', 'rock', 'pop'], 200),
    (['a', 'b', 'c', 'd'], 422), ([''], 422), ([' '], 422), (['a' * 101], 422)])
async def test_api_bounds_and_forwarding(pool, tags, status):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/tracks/seed/similar', params=[('emphasized_tags', t) for t in tags])
    assert response.status_code == status
    if status == 200 and tags == ['jazz']:
        assert response.json()['tracks'][0]['id'] == 'c7'
        assert response.json()['ranking']['steering_matched'] is True


async def test_mock_steering_on_and_off(monkeypatch):
    monkeypatch.setenv('TUNEGRAPH_MOCK', '1')
    get_settings.cache_clear()
    cache.clear()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            off = await client.get('/api/tracks/tr:radiohead|creep/similar')
            on = await client.get('/api/tracks/tr:radiohead|creep/similar', params={'emphasized_tags': 'trip-hop'})
        assert off.status_code == on.status_code == 200
        assert off.json()['ranking']['steering_matched'] is None
        assert on.json()['ranking']['steering_matched'] is True
        assert on.json()['tracks']
    finally:
        get_settings.cache_clear()
        cache.clear()


async def test_three_tags_are_weighted_and_duplicates_do_not_amplify(pool, monkeypatch):
    async def tags(track_id):
        if track_id == 'seed':
            return ['rock']
        if track_id == 'c7':
            return ['jazz', 'pop', 'folk']
        if track_id == 'c8':
            return ['other', 'jazz']
        return ['rock']

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 7, emphasized_tags=['jazz', 'pop', 'folk'])
    duplicate = await similarity.select_similar_tracks('seed', 7, emphasized_tags=[' Jazz ', 'JAZZ', 'jazz'])
    single = await similarity.select_similar_tracks('seed', 7, emphasized_tags=['jazz'])
    assert result.tracks[0].id == 'c7'
    assert duplicate.tracks == single.tracks
    assert all(t.similarity <= 1 for t in result.tracks)


async def test_candidate_provider_error_still_returns_seven(pool, monkeypatch):
    from app.services.errors import ProviderError
    original = lastfm.get_track_tags

    async def tags(track_id):
        if track_id == 'c0':
            raise ProviderError('lastfm', 'busy')
        return await original(track_id)

    monkeypatch.setattr(lastfm, 'get_track_tags', tags)
    result = await similarity.select_similar_tracks('seed', 7, emphasized_tags=['jazz'])
    assert len(result.tracks) == 7
    assert result.tracks[0].id == 'c7'
    full = await similarity.select_similar_tracks('seed', 20, emphasized_tags=['jazz'])
    missing = next(t for t in full.tracks if t.id == 'c0')
    assert missing.similarity == 0.8
    assert missing.shared_tags == []
