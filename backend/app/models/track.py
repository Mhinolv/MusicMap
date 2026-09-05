from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.artist import ArtistRef, ExternalUrls


class Track(BaseModel):
    name: str
    listeners: int | None = None
    playcount: int | None = None
    lastfm_url: str | None = None


class TracksResponse(BaseModel):
    artist_id: str
    tracks: list[Track]


class PreviewResult(BaseModel):
    available: bool
    preview_url: str | None = None
    duration_seconds: int | None = None
    provider: str | None = None
    track_url: str | None = None
    artwork_url: str | None = None


class TrackRef(BaseModel):
    """A song plus the artist it belongs to. Nodes of a song-seeded map."""

    id: str
    name: str
    artist: ArtistRef
    mbid: str | None = None
    lastfm_url: str | None = None
    listeners: int | None = None


class SimilarTrack(TrackRef):
    # Blend of Last.fm's collaborative match and tag-vector similarity (see services/similarity.py).
    similarity: float | None = None
    # Tags both songs carry — the "why" behind the content half of the score. Empty when
    # either side has no tags and the score fell back to Last.fm's match alone.
    shared_tags: list[str] = Field(default_factory=list)


class TrackAlbum(BaseModel):
    title: str
    mbid: str | None = None
    url: str | None = None
    image_url: str | None = None


class TrackDetails(TrackRef):
    album: TrackAlbum | None = None
    duration_seconds: int | None = None
    playcount: int | None = None
    # Last.fm has no genre field; its top tags are the genre signal.
    tags: list[str] = Field(default_factory=list)
    summary: str | None = None
    # First release date from MusicBrainz: "YYYY", "YYYY-MM" or "YYYY-MM-DD". Last.fm has none.
    release_date: str | None = None
    external_urls: ExternalUrls = Field(default_factory=ExternalUrls)


class TrackReleaseDate(BaseModel):
    track_id: str
    # "YYYY", "YYYY-MM" or "YYYY-MM-DD"; None when unknown.
    release_date: str | None = None


class TrackSearchResponse(BaseModel):
    tracks: list[TrackRef]


class TrackSimilarResponse(BaseModel):
    """Songs Last.fm considers similar to a song."""

    track_id: str
    track: TrackRef | None = None
    tracks: list[SimilarTrack]
