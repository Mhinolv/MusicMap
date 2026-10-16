"""Library lists (#79): Saved bookmarks and Not suggested songs, in the browser's storage shape.

The payloads match `tunegraph:bookmarks:v1` and `tunegraph:exclusions:v1`:
`{"version": 1, "items": [{"kind", "item", "savedAt"}, ...]}`.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

# Match BOOKMARK_LIMIT and EXCLUSION_LIMIT in frontend/src/bookmarks.ts and exclusions.ts.
BOOKMARK_LIMIT = 200
EXCLUSION_LIMIT = 100

Text = Annotated[str, StringConstraints(min_length=1, max_length=500)]
OptionalText = Annotated[str, StringConstraints(max_length=2000)] | None


class LibraryRef(BaseModel):
    id: Text
    name: Text
    mbid: OptionalText = None
    image_url: OptionalText = None


class LibraryItem(LibraryRef):
    # Songs carry their artist; artist entries have none.
    artist: LibraryRef | None = None


class LibraryEntry(BaseModel):
    kind: Literal["artist", "track"]
    item: LibraryItem
    savedAt: float = Field(ge=0)

    @model_validator(mode="after")
    def song_has_artist(self) -> "LibraryEntry":
        if self.kind == "track" and self.item.artist is None:
            raise ValueError("A saved song needs its artist")
        if self.kind == "artist":
            self.item.artist = None
        return self


class BookmarkList(BaseModel):
    version: Literal[1] = 1
    items: list[LibraryEntry] = Field(default_factory=list, max_length=BOOKMARK_LIMIT)


class ExclusionList(BaseModel):
    version: Literal[1] = 1
    items: list[LibraryEntry] = Field(default_factory=list, max_length=EXCLUSION_LIMIT)

    @model_validator(mode="after")
    def songs_only(self) -> "ExclusionList":
        if any(entry.kind != "track" for entry in self.items):
            raise ValueError("Not suggested keeps songs only")
        return self


class LibraryLists(BaseModel):
    bookmarks: BookmarkList = Field(default_factory=BookmarkList)
    exclusions: ExclusionList = Field(default_factory=ExclusionList)


class LibraryMergeResponse(LibraryLists):
    """`added` counts local entries new to the account; `capped` names lists that hit their cap."""

    added: int
    capped: list[Literal["bookmarks", "exclusions"]]
