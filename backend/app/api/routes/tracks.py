"""Song-seeded maps: search for a song, inspect it, then fan out to similar songs."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.models.track import PreviewResult, TrackDetails, TrackReleaseDate, TrackSearchResponse, TrackSimilarResponse
from app.services import lastfm, links, preview, similarity

router = APIRouter(prefix="/api/tracks", tags=["tracks"])


@router.get("/search", response_model=TrackSearchResponse)
async def search_tracks(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(8, ge=1, le=25),
) -> TrackSearchResponse:
    return TrackSearchResponse(tracks=await lastfm.search_tracks(q.strip(), limit))


@router.get("/{track_id}", response_model=TrackDetails)
async def get_track(track_id: str) -> TrackDetails:
    """Album, duration, tags, wiki summary (Last.fm) plus first release date (MusicBrainz)."""
    return await links.enrich_track(await lastfm.get_track_details(track_id))


@router.get("/{track_id}/release-date", response_model=TrackReleaseDate)
async def get_release_date(track_id: str) -> TrackReleaseDate:
    """Slow path (MusicBrainz, ~1 req/s): fetched after the panel has rendered the Last.fm facts."""
    details = await lastfm.get_track_details(track_id)
    date = details.release_date or await links.release_date_for(details)
    return TrackReleaseDate(track_id=track_id, release_date=date)


@router.get("/{track_id}/similar", response_model=TrackSimilarResponse)
async def get_similar(track_id: str, limit: int = Query(8, ge=1, le=20)) -> TrackSimilarResponse:
    """Last.fm's candidates, re-ranked by a blend of its match score and shared-tag similarity."""
    track, tracks = await lastfm.get_similar_tracks(track_id, limit)
    tracks = await similarity.rerank_similar_tracks(track.id, tracks)
    return TrackSimilarResponse(track_id=track_id, track=track, tracks=tracks)


@router.get("/{track_id}/preview", response_model=PreviewResult)
async def get_preview(track_id: str) -> PreviewResult:
    """Never fails: an unresolvable preview returns {available: false}."""
    try:
        track = await lastfm.get_track(track_id)
    except Exception:
        return preview.UNAVAILABLE
    return await preview.resolve_preview(track.artist.name, track.name)
