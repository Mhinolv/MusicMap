"""A small, user-supplied taste profile and a single item estimate."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

Preference = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class TasteProfile(BaseModel):
    liked_artists: list[Preference] = Field(default_factory=list, max_length=50)
    liked_tracks: list[Preference] = Field(default_factory=list, max_length=50)
    liked_genres: list[Preference] = Field(default_factory=list, max_length=50)
    disliked: list[Preference] = Field(default_factory=list, max_length=50)
    notes: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def has_positive_preference(self) -> "TasteProfile":
        if not (self.liked_artists or self.liked_tracks or self.liked_genres or self.notes.strip()):
            raise ValueError("Add at least one artist, song, genre, or taste note")
        return self


class TasteEvaluationRequest(BaseModel):
    kind: Literal["artist", "track"]
    item_id: str = Field(min_length=1, max_length=250)
    profile: TasteProfile


class TasteEvaluationResponse(BaseModel):
    kind: Literal["artist", "track"]
    item_id: str
    estimate: float = Field(ge=0, le=1)
    model: str | None = None
    tags: list[str] = Field(default_factory=list)
