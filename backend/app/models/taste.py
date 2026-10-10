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


TasteOutcome = Literal["fit", "insufficient_evidence", "uncertain"]


class TasteEvaluationResponse(BaseModel):
    """Version 2: a fit level (0 = conflicts with dislikes … 4 = strong fit), a tentative
    level for an uncertain estimate, or no level when evidence is missing. There is
    deliberately no enjoyment probability."""

    version: Literal[2] = 2
    kind: Literal["artist", "track"]
    item_id: str
    outcome: TasteOutcome
    # Rounded Score level and the raw fractional Score; for "uncertain" they are a tentative
    # lean (#51). Both null for "insufficient_evidence".
    level: int | None = Field(default=None, ge=0, le=4)
    score: float | None = Field(default=None, ge=0, le=4, allow_inf_nan=False)
    # Score confidence (0-1), only for "uncertain". For styling only: never shown as a number.
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    model: str | None = None
    rubric_version: str
    tags: list[str] = Field(default_factory=list)
    # True when TUNEGRAPH_MOCK fixtures produced the result instead of JevLab.
    simulated: bool = False

    @model_validator(mode="after")
    def level_only_when_scored(self) -> "TasteEvaluationResponse":
        _check_level(self.outcome, self.level, self.score, self.confidence)
        return self


SCORED_OUTCOMES = ("fit", "uncertain")


def _check_level(outcome: str, level: int | None, score: float | None, confidence: float | None) -> None:
    scored = outcome in SCORED_OUTCOMES
    if scored != (level is not None):
        raise ValueError("level is required for fit and uncertain outcomes and absent otherwise")
    if not scored and score is not None:
        raise ValueError("score is only returned for fit and uncertain outcomes")
    if (outcome == "uncertain") != (confidence is not None):
        raise ValueError("confidence is required for uncertain outcomes and absent otherwise")


ItemId = Annotated[str, StringConstraints(min_length=1, max_length=250)]


class TasteConnectionsRequest(BaseModel):
    """Up to seven child songs of one song expansion (the frontend's EXPAND_LIMIT)."""

    item_ids: list[ItemId] = Field(min_length=1, max_length=7)
    profile: TasteProfile

    @model_validator(mode="after")
    def unique_ids(self) -> "TasteConnectionsRequest":
        if len(set(self.item_ids)) != len(self.item_ids):
            raise ValueError("item_ids must be unique")
        return self


# "unknown": the song's facts couldn't be looked up or JEV's answer for it was unusable.
ConnectionOutcome = Literal["fit", "insufficient_evidence", "uncertain", "unknown"]


class TasteConnectionResult(BaseModel):
    item_id: str
    outcome: ConnectionOutcome
    level: int | None = Field(default=None, ge=0, le=4)
    score: float | None = Field(default=None, ge=0, le=4, allow_inf_nan=False)
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def level_only_when_scored(self) -> "TasteConnectionResult":
        _check_level(self.outcome, self.level, self.score, self.confidence)
        return self


class TasteConnectionsResponse(BaseModel):
    """Version 1: one result per requested id, in request order. No enjoyment probability."""

    version: Literal[1] = 1
    results: list[TasteConnectionResult]
    model: str | None = None
    rubric_version: str
    simulated: bool = False
