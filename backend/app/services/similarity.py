"""Content-based re-ranking of Last.fm's similar-songs list.

Last.fm's track.getSimilar "match" is a collaborative signal: who listened to what
together. Pandora's Music Genome Project instead scores each song on hundreds of
musical attributes and ranks by weighted distance in that space. We have no genes,
but a song's Last.fm top tags are a usable content signal (genre / mood / era), so:

  1. turn each song's ranked tag list into a sparse weighted vector,
  2. score seed-vs-candidate by cosine similarity in that space,
  3. blend that with Last.fm's match and re-sort.

Tags are sparser and noisier than listening data, so the blend leans collaborative.
"""

from __future__ import annotations

import asyncio
import logging
import math

from app.models.track import SimilarTrack, TrackRankingContext, TrackSimilarResponse
from app.services import lastfm
from app.services.errors import ProviderError

log = logging.getLogger(__name__)

# Share of the blended score that comes from Last.fm's collaborative match.
COLLAB_WEIGHT = 0.6


def _tag_vector(tags: list[str]) -> dict[str, float]:
    """Last.fm lists tags most-relevant-first; earlier tags weigh more (1, 1/2, 1/3, ...)."""
    vec: dict[str, float] = {}
    for i, tag in enumerate(tags):
        name = tag.strip().lower()
        if name and name not in vec:
            vec[name] = 1.0 / (i + 1)
    return vec


def tag_similarity(tags_a: list[str], tags_b: list[str]) -> tuple[float | None, list[str]]:
    """Cosine similarity of two tag vectors plus the tags they share (strongest first).

    None when either side has no tags: "unknown", not "dissimilar".
    """
    va, vb = _tag_vector(tags_a), _tag_vector(tags_b)
    if not va or not vb:
        return None, []
    shared = sorted(va.keys() & vb.keys(), key=lambda t: -(va[t] + vb[t]))
    if not shared:
        return 0.0, []
    dot = sum(va[t] * vb[t] for t in shared)
    norm = math.sqrt(sum(w * w for w in va.values())) * math.sqrt(sum(w * w for w in vb.values()))
    return min(1.0, dot / norm), shared


def blend(collab: float | None, content: float | None) -> float | None:
    """Weighted average of the two signals, falling back to whichever one exists."""
    if collab is None:
        return content
    if content is None:
        return collab
    return COLLAB_WEIGHT * collab + (1.0 - COLLAB_WEIGHT) * content


async def _tags(track_id: str) -> list[str]:
    """A tag lookup that fails soft: one bad candidate must not sink the whole list."""
    try:
        return await lastfm.get_track_tags(track_id)
    except ProviderError as exc:
        log.warning("tags unavailable for %s: %s", track_id, exc)
        return []


TAG_CONCURRENCY = 6
TRAIL_CAP = 50
POOL_SIZE = 20
# Only optional journey work has this deadline; parent ranking remains available.
JOURNEY_TIMEOUT = 2.0


async def _tag_batch(ids: list[str]) -> dict[str, list[str]]:
    semaphore = asyncio.Semaphore(TAG_CONCURRENCY)

    async def lookup(track_id: str) -> tuple[str, list[str]]:
        async with semaphore:
            return track_id, await _tags(track_id)

    return dict(await asyncio.gather(*(lookup(i) for i in dict.fromkeys(ids))))


async def rerank_similar_tracks(seed_id: str, candidates: list[SimilarTrack]) -> list[SimilarTrack]:
    """Blend tag similarity into each candidate's score and re-sort, strongest first."""
    if not candidates:
        return candidates
    tags_by_id = await _tag_batch([seed_id, *(c.id for c in candidates)])
    seed_tags = tags_by_id[seed_id]
    candidate_tags = [tags_by_id[c.id] for c in candidates]
    out: list[SimilarTrack] = []
    for cand, tags in zip(candidates, candidate_tags):
        content, shared = tag_similarity(seed_tags, tags)
        out.append(cand.model_copy(update={"similarity": blend(cand.similarity, content), "shared_tags": shared}))
    # Stable sort: ties keep Last.fm's original order.
    out.sort(key=lambda c: -(c.similarity if c.similarity is not None else -1.0))
    return out


def journey_vector(tag_lists: list[list[str]]) -> dict[str, float]:
    """L2-normalize each stop, then weight oldest→newest by 1, 2, …, k.

    Every stop contributes positively. The final cosine normalizes the aggregate,
    so dividing weights by their sum would produce the same ranking.
    """
    vector: dict[str, float] = {}
    for recency, tags in enumerate(tag_lists, 1):
        stop = _tag_vector(tags)
        norm = math.sqrt(sum(w * w for w in stop.values()))
        if norm:
            for tag, weight in stop.items():
                vector[tag] = vector.get(tag, 0.0) + recency * weight / norm
    return vector


def _cosine(a: dict[str, float], b: dict[str, float]) -> float | None:
    if not a or not b:
        return None
    norm = math.sqrt(sum(w * w for w in a.values()) * sum(w * w for w in b.values()))
    return min(1.0, sum(w * b.get(t, 0.0) for t, w in a.items()) / norm)


async def select_similar_tracks(
    seed_id: str, limit: int = 7, trail: list[str] | None = None, excluded: list[str] | None = None,
) -> TrackSimilarResponse:
    """Reusable bounded pool selection. No context preserves the legacy path.

    Journey mode fetches 20, scores the entire pool, then slices. Fallbacks score
    only the eligible prefix, preserving parent-only ordering. Exclusions filter
    the bounded pool before either path slices; excluded IDs are never cached.
    Last.fm already caches tags and candidates; context-specific results aren't
    cached, preventing cross-journey contamination.
    """
    stops = list(dict.fromkeys(trail or []))
    if stops and seed_id not in stops:
        stops.append(seed_id)
    reason = "cap_exceeded" if len(stops) > TRAIL_CAP else None
    use_trail = len(stops) > 1 and reason is None
    excluded_ids = set(excluded or [])
    track, candidates = await lastfm.get_similar_tracks(seed_id, POOL_SIZE if use_trail or excluded_ids else limit)
    excluded_count = sum(c.id in excluded_ids for c in candidates)
    candidates = [c for c in candidates if c.id not in excluded_ids]
    if not candidates:
        return TrackSimilarResponse(track_id=seed_id, track=track, excluded_count=excluded_count, tracks=[],
            ranking=TrackRankingContext(stop_count=len(stops), fallback_reason=reason))
    # Compute the ordinary response first so a timed-out optional lookup never
    # forces another provider request to deliver the fallback.
    parent = await rerank_similar_tracks(track.id, candidates[:limit])
    ranking = TrackRankingContext(stop_count=len(stops), fallback_reason=reason)
    if use_trail:
        async def rank_journey() -> list[SimilarTrack] | None:
            tags = await _tag_batch([track.id, *stops, *(c.id for c in candidates)])
            if any(not _tag_vector(tags[i]) for i in stops):
                return None
            vector = journey_vector([tags[i] for i in stops])
            scored: list[tuple[float, SimilarTrack]] = []
            for candidate in candidates:
                content, shared = tag_similarity(tags[track.id], tags[candidate.id])
                edge = candidate.model_copy(update={
                    "similarity": blend(candidate.similarity, content), "shared_tags": shared,
                })
                score = blend(candidate.similarity, _cosine(vector, _tag_vector(tags[candidate.id])))
                scored.append((score if score is not None else -1.0, edge))
            scored.sort(key=lambda item: -item[0])
            return [edge for _, edge in scored[:limit]]

        try:
            selected = await asyncio.wait_for(rank_journey(), timeout=JOURNEY_TIMEOUT)
            if selected is not None:
                return TrackSimilarResponse(track_id=seed_id, track=track, excluded_count=excluded_count, tracks=selected,
                    ranking=TrackRankingContext(mode="journey", stop_count=len(stops)))
            ranking.fallback_reason = "missing_tags"
        except TimeoutError:
            ranking.fallback_reason = "timeout"
    return TrackSimilarResponse(track_id=seed_id, track=track, excluded_count=excluded_count, tracks=parent, ranking=ranking)
