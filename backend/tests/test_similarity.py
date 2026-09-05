"""Tag-vector similarity and the collaborative/content blend."""

from __future__ import annotations

import pytest

from app.cache.cache import cache
from app.config import get_settings
from app.models.artist import ArtistRef
from app.models.track import SimilarTrack
from app.services import similarity
from app.services.similarity import COLLAB_WEIGHT, blend, tag_similarity


def test_identical_tags_score_one():
    score, shared = tag_similarity(["shoegaze", "dream pop", "90s"], ["shoegaze", "dream pop", "90s"])
    assert score == pytest.approx(1.0)
    assert shared == ["shoegaze", "dream pop", "90s"]


def test_disjoint_tags_score_zero_with_nothing_shared():
    assert tag_similarity(["metal", "thrash"], ["jazz", "bebop"]) == (0.0, [])


def test_partial_overlap_is_strictly_between():
    score, shared = tag_similarity(["shoegaze", "dream pop", "90s"], ["dream pop", "indie", "90s"])
    assert 0.0 < score < 1.0
    assert set(shared) == {"dream pop", "90s"}


def test_shared_tags_ordered_by_combined_rank_weight():
    # "90s" is top-ranked on both sides, "dream pop" is 3rd on both: 90s should lead.
    _, shared = tag_similarity(["90s", "indie", "dream pop"], ["90s", "rock", "dream pop"])
    assert shared == ["90s", "dream pop"]


def test_rank_matters_higher_ranked_overlap_scores_higher():
    top_match, _ = tag_similarity(["shoegaze", "x", "y"], ["shoegaze", "p", "q"])
    tail_match, _ = tag_similarity(["x", "y", "shoegaze"], ["p", "q", "shoegaze"])
    assert top_match > tail_match


def test_tags_are_matched_case_and_whitespace_insensitively():
    score, shared = tag_similarity(["Dream Pop "], ["dream pop"])
    assert score == pytest.approx(1.0)
    assert shared == ["dream pop"]


def test_missing_tags_on_either_side_is_unknown_not_zero():
    assert tag_similarity([], ["rock"]) == (None, [])
    assert tag_similarity(["rock"], []) == (None, [])


def test_blend_weights_collaborative_side():
    assert blend(1.0, 0.0) == pytest.approx(COLLAB_WEIGHT)
    assert blend(0.0, 1.0) == pytest.approx(1.0 - COLLAB_WEIGHT)


def test_blend_falls_back_when_one_side_is_missing():
    assert blend(0.7, None) == 0.7
    assert blend(None, 0.4) == 0.4
    assert blend(None, None) is None


# --------------------------------------------------------------------------- #
# rerank_similar_tracks, driven by the mock provider's canned tags
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _mock_mode(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    get_settings.cache_clear()
    cache.clear()
    yield
    get_settings.cache_clear()


def _track(artist: str, name: str, match: float) -> SimilarTrack:
    return SimilarTrack(
        id=f"tr:{artist}|{name.lower()}",
        name=name,
        artist=ArtistRef(id=f"nm:{artist}", name=artist.title()),
        similarity=match,
    )


async def test_rerank_promotes_tag_sharing_candidate_and_reports_why():
    # Seed "Creep" is tagged alternative/90s/rock/... Last.fm ranks the trip-hop song first,
    # but the sibling Radiohead song shares far more tags and should overtake it.
    seed = "tr:radiohead|creep"
    candidates = [_track("portishead", "Glory Box", 0.9), _track("radiohead", "Karma Police", 0.8)]

    out = await similarity.rerank_similar_tracks(seed, candidates)

    assert [t.name for t in out] == ["Karma Police", "Glory Box"]
    assert "alternative" in out[0].shared_tags
    assert out[1].shared_tags == ["90s"]
    assert all(0 <= t.similarity <= 1 for t in out)


async def test_rerank_keeps_collaborative_score_when_candidate_has_no_tags():
    seed = "tr:radiohead|creep"
    unknown = _track("nobody", "Unknown Song", 0.5)  # not in the mock catalogue -> no tags

    out = await similarity.rerank_similar_tracks(seed, [unknown])

    assert out[0].similarity == 0.5
    assert out[0].shared_tags == []


async def test_rerank_survives_a_failing_tag_lookup(monkeypatch):
    from app.services import lastfm
    from app.services.errors import ProviderError

    async def boom(track_id: str, limit: int = 8) -> list[str]:
        if "karma" in track_id:
            raise ProviderError("lastfm", "busy")
        return ["alternative", "90s"]

    monkeypatch.setattr(lastfm, "get_track_tags", boom)
    candidates = [_track("radiohead", "Karma Police", 0.8), _track("portishead", "Glory Box", 0.3)]

    out = await similarity.rerank_similar_tracks("tr:radiohead|creep", candidates)

    assert {t.name for t in out} == {"Karma Police", "Glory Box"}
    karma = next(t for t in out if t.name == "Karma Police")
    assert karma.similarity == 0.8 and karma.shared_tags == []


async def test_rerank_empty_input():
    assert await similarity.rerank_similar_tracks("tr:radiohead|creep", []) == []
