"""The account copy of the Library lists (#79): Saved bookmarks and Not suggested songs.

Each list is one JSON document in the user store, so a bookmark write never races an
exclusion write:
- `tunegraph:library:{sub}:bookmarks`: `{"version": 1, "items": [...], "updated_at": ...}`
- `tunegraph:library:{sub}:exclusions`: the same shape, songs only.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Literal

from pydantic import ValidationError

from app.models.library import (
    BOOKMARK_LIMIT,
    EXCLUSION_LIMIT,
    BookmarkList,
    ExclusionList,
    LibraryEntry,
    LibraryLists,
)
from app.services.user_store import UserStore

LIBRARY_PREFIX = "tunegraph:library:"
ListName = Literal["bookmarks", "exclusions"]


def bookmark_key(entry: LibraryEntry) -> str:
    """Same as `bookmarkKey` in frontend/src/bookmarks.ts."""
    return f"{entry.kind}:{entry.item.id}"


def exclusion_key(entry: LibraryEntry) -> str:
    return entry.item.id


def _newest_first(entries: list[LibraryEntry]) -> list[LibraryEntry]:
    return sorted(entries, key=lambda e: e.savedAt, reverse=True)


def dedupe(entries: list[LibraryEntry], key: Callable[[LibraryEntry], str]) -> list[LibraryEntry]:
    """One entry per key, the newer `savedAt` wins, newest first."""
    by_key: dict[str, LibraryEntry] = {}
    for entry in entries:
        have = by_key.get(key(entry))
        if have is None or entry.savedAt > have.savedAt:
            by_key[key(entry)] = entry
    return _newest_first(list(by_key.values()))


def merge_entries(
    cloud: list[LibraryEntry], local: list[LibraryEntry], key: Callable[[LibraryEntry], str], limit: int
) -> tuple[list[LibraryEntry], int, bool, bool]:
    """Union by key: cloud entries always stay, a duplicate keeps the newer `savedAt`.

    New local entries join newest first until the list holds `limit`.
    Returns the merged list, the count of added entries, whether any entry did not fit,
    and whether the merged list differs from the cloud list.
    """
    by_key = {key(e): e for e in dedupe(cloud, key)[:limit]}
    added = 0
    capped = False
    changed = False
    for entry in _newest_first(local):
        k = key(entry)
        have = by_key.get(k)
        if have is not None:
            if entry.savedAt > have.savedAt:
                by_key[k] = entry
                changed = True
            continue
        if len(by_key) >= limit:
            capped = True
            continue
        by_key[k] = entry
        added += 1
        changed = True
    return _newest_first(list(by_key.values())), added, capped, changed


def _key(sub: str, name: ListName) -> str:
    return f"{LIBRARY_PREFIX}{sub}:{name}"


async def read_bookmarks(store: UserStore, sub: str) -> BookmarkList:
    raw = await store.get(_key(sub, "bookmarks")) or {}
    try:
        return BookmarkList.model_validate({"version": 1, "items": raw.get("items", [])})
    except ValidationError:
        return BookmarkList()


async def read_exclusions(store: UserStore, sub: str) -> ExclusionList:
    raw = await store.get(_key(sub, "exclusions")) or {}
    try:
        return ExclusionList.model_validate({"version": 1, "items": raw.get("items", [])})
    except ValidationError:
        return ExclusionList()


async def read_library(store: UserStore, sub: str) -> LibraryLists:
    return LibraryLists(bookmarks=await read_bookmarks(store, sub), exclusions=await read_exclusions(store, sub))


async def _write(store: UserStore, sub: str, name: ListName, items: list[LibraryEntry]) -> None:
    """Last write wins. An empty list removes the document."""
    if not items:
        await store.delete(_key(sub, name))
        return
    await store.set(_key(sub, name), {
        "version": 1,
        "items": [e.model_dump(exclude_none=True) for e in items],
        "updated_at": int(time.time()),
    })


async def write_bookmarks(store: UserStore, sub: str, body: BookmarkList) -> BookmarkList:
    kept = BookmarkList(items=dedupe(body.items, bookmark_key))
    await _write(store, sub, "bookmarks", kept.items)
    return kept


async def write_exclusions(store: UserStore, sub: str, body: ExclusionList) -> ExclusionList:
    kept = ExclusionList(items=dedupe(body.items, exclusion_key))
    await _write(store, sub, "exclusions", kept.items)
    return kept


async def merge_library(store: UserStore, sub: str, local: LibraryLists) -> tuple[LibraryLists, int, list[ListName]]:
    """First sign-in on a device: add this device's lists to the account, within each cap."""
    cloud = await read_library(store, sub)
    bookmarks, b_added, b_capped, b_changed = merge_entries(
        cloud.bookmarks.items, local.bookmarks.items, bookmark_key, BOOKMARK_LIMIT)
    exclusions, e_added, e_capped, e_changed = merge_entries(
        cloud.exclusions.items, local.exclusions.items, exclusion_key, EXCLUSION_LIMIT)
    if b_changed:
        await _write(store, sub, "bookmarks", bookmarks)
    if e_changed:
        await _write(store, sub, "exclusions", exclusions)
    capped: list[ListName] = [name for name, hit in (("bookmarks", b_capped), ("exclusions", e_capped)) if hit]
    merged = LibraryLists(bookmarks=BookmarkList(items=bookmarks), exclusions=ExclusionList(items=exclusions))
    return merged, b_added + e_added, capped
