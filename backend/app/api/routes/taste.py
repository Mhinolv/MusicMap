"""Evaluate one selected artist or song against a listener's supplied preferences."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from app.models.taste import TasteEvaluationRequest, TasteEvaluationResponse
from app.services import jev, lastfm
from app.services.errors import ProviderError

router = APIRouter(prefix="/api/taste", tags=["taste"])


async def canonical_target(kind: str, item_id: str) -> tuple[dict, list[str]]:
    """Canonical Last.fm facts sent to Jev (and hashed into its cache key), plus tags."""
    if kind == "artist":
        artist = await lastfm.get_artist(item_id)
        tags = artist.tags[:12]
        return {"kind": "artist", "name": artist.name, "tags": tags}, tags
    track = await lastfm.get_track_details(item_id)
    tags = track.tags[:12]
    return {
        "kind": "song",
        "title": track.name,
        "artist": track.artist.name,
        "album": track.album.title if track.album else None,
        "tags": tags,
    }, tags


async def _evaluate(request: TasteEvaluationRequest) -> TasteEvaluationResponse:
    target, tags = await canonical_target(request.kind, request.item_id)
    judgment = await jev.judge_fit(request.profile, target)
    level = judgment.level
    return TasteEvaluationResponse(
        kind=request.kind,
        item_id=request.item_id,
        outcome=judgment.outcome,
        level=level,
        score=judgment.score if level is not None else None,
        model=judgment.model,
        rubric_version=jev.RUBRIC_VERSION,
        tags=tags,
        simulated=judgment.simulated,
    )


@router.post("/evaluate", response_model=TasteEvaluationResponse)
async def evaluate(request: TasteEvaluationRequest) -> TasteEvaluationResponse:
    try:
        return await asyncio.wait_for(_evaluate(request), timeout=jev.DEADLINE_SECONDS)
    except TimeoutError as exc:
        raise ProviderError(jev.PROVIDER, "timed out", status=504) from exc
