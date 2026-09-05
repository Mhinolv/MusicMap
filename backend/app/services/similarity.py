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

from app.models.track import SimilarTrack
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


async def rerank_similar_tracks(seed_id: str, candidates: list[SimilarTrack]) -> list[SimilarTrack]:
    """Blend tag similarity into each candidate's score and re-sort, strongest first."""
    if not candidates:
        return candidates
    seed_tags, *candidate_tags = await asyncio.gather(_tags(seed_id), *(_tags(c.id) for c in candidates))
    out: list[SimilarTrack] = []
    for cand, tags in zip(candidates, candidate_tags):
        content, shared = tag_similarity(seed_tags, tags)
        out.append(cand.model_copy(update={"similarity": blend(cand.similarity, content), "shared_tags": shared}))
    # Stable sort: ties keep Last.fm's original order.
    out.sort(key=lambda c: -(c.similarity if c.similarity is not None else -1.0))
    return out
