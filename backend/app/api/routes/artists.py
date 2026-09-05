from __future__ import annotations

from fastapi import APIRouter, Query

from app.models.artist import Artist, SearchResponse, SimilarResponse
from app.models.track import PreviewResult, TracksResponse
from app.services import lastfm, links, preview

router = APIRouter(prefix="/api/artists", tags=["artists"])


@router.get("/search", response_model=SearchResponse)
async def search_artists(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(8, ge=1, le=25),
) -> SearchResponse:
    return SearchResponse(artists=await lastfm.search(q.strip(), limit))


@router.get("/{artist_id}", response_model=Artist)
async def get_artist(artist_id: str) -> Artist:
    artist = await lastfm.get_artist(artist_id)
    return await links.enrich_links(artist)


@router.get("/{artist_id}/similar", response_model=SimilarResponse)
async def get_similar(artist_id: str, limit: int = Query(8, ge=1, le=20)) -> SimilarResponse:
    return SimilarResponse(artist_id=artist_id, artists=await lastfm.get_similar(artist_id, limit))


@router.get("/{artist_id}/tracks", response_model=TracksResponse)
async def get_tracks(artist_id: str, limit: int = Query(5, ge=1, le=20)) -> TracksResponse:
    return TracksResponse(artist_id=artist_id, tracks=await lastfm.get_top_tracks(artist_id, limit))


@router.get("/{artist_id}/tracks/{track_name}/preview", response_model=PreviewResult)
async def get_preview(artist_id: str, track_name: str) -> PreviewResult:
    """Never fails: an unresolvable preview returns {available: false}."""
    try:
        artist_name = await lastfm.resolve_name(artist_id)
    except Exception:
        return preview.UNAVAILABLE
    return await preview.resolve_preview(artist_name, track_name)
