"""Evaluate one selected artist or song against a listener's supplied preferences."""

from __future__ import annotations

from fastapi import APIRouter

from app.models.taste import TasteEvaluationRequest, TasteEvaluationResponse
from app.services import jev, lastfm

router = APIRouter(prefix="/api/taste", tags=["taste"])


@router.post("/evaluate", response_model=TasteEvaluationResponse)
async def evaluate(request: TasteEvaluationRequest) -> TasteEvaluationResponse:
    if request.kind == "artist":
        artist = await lastfm.get_artist(request.item_id)
        target = {
            "kind": "artist",
            "name": artist.name,
            "tags": artist.tags[:12],
        }
        tags = artist.tags[:12]
    else:
        track = await lastfm.get_track_details(request.item_id)
        target = {
            "kind": "song",
            "title": track.name,
            "artist": track.artist.name,
            "album": track.album.title if track.album else None,
            "tags": track.tags[:12],
        }
        tags = track.tags[:12]

    estimate, model = await jev.estimate_fit(request.profile, target)
    return TasteEvaluationResponse(
        kind=request.kind,
        item_id=request.item_id,
        estimate=estimate,
        model=model,
        tags=tags,
    )
