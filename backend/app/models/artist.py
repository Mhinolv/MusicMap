"""Internal artist models. Provider response shapes must be mapped into these."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ExternalUrls(BaseModel):
    lastfm: str | None = None
    spotify: str | None = None
    apple_music: str | None = None
    youtube: str | None = None
    musicbrainz: str | None = None


class ArtistRef(BaseModel):
    """Minimal artist identity: what we need to look the artist up again later."""

    id: str
    mbid: str | None = None
    name: str
    lastfm_url: str | None = None
    image_url: str | None = None


class SimilarArtist(ArtistRef):
    similarity: float | None = None


class Artist(ArtistRef):
    tags: list[str] = Field(default_factory=list)
    listeners: int | None = None
    summary: str | None = None
    external_urls: ExternalUrls = Field(default_factory=ExternalUrls)


class SearchResponse(BaseModel):
    artists: list[ArtistRef]


class SimilarResponse(BaseModel):
    artist_id: str
    artists: list[SimilarArtist]
