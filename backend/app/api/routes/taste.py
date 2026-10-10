"""Evaluate one selected artist or song, or the songs of one song expansion, against a
listener's supplied preferences."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from app.config import get_settings
from app.models.taste import (
    TasteConnectionResult,
    TasteConnectionsRequest,
    TasteConnectionsResponse,
    TasteEvaluationRequest,
    TasteEvaluationResponse,
)
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


async def _song_target(item_id: str) -> dict | None:
    # A song whose facts can't be looked up becomes "unknown" instead of failing the batch.
    try:
        target, _ = await canonical_target("track", item_id)
    except ProviderError:
        return None
    return target


async def _evaluate_connections(request: TasteConnectionsRequest) -> TasteConnectionsResponse:
    looked_up = await asyncio.gather(*(_song_target(item_id) for item_id in request.item_ids))
    targets = {item_id: target for item_id, target in zip(request.item_ids, looked_up) if target is not None}
    judgments = await jev.judge_fits(request.profile, targets) if targets else {}
    results = []
    for item_id in request.item_ids:
        judgment = judgments.get(item_id)
        if judgment is None:
            results.append(TasteConnectionResult(item_id=item_id, outcome="unknown"))
            continue
        level = judgment.level
        results.append(TasteConnectionResult(
            item_id=item_id, outcome=judgment.outcome, level=level,
            score=judgment.score if level is not None else None,
        ))
    return TasteConnectionsResponse(
        results=results,
        model=next((j.model for j in judgments.values() if j.model), None),
        rubric_version=jev.RUBRIC_VERSION,
        simulated=get_settings().mock_providers,
    )


@router.post("/connections/evaluate", response_model=TasteConnectionsResponse)
async def evaluate_connections(request: TasteConnectionsRequest) -> TasteConnectionsResponse:
    try:
        return await asyncio.wait_for(_evaluate_connections(request), timeout=jev.DEADLINE_SECONDS)
    except TimeoutError as exc:
        raise ProviderError(jev.PROVIDER, "timed out", status=504) from exc
