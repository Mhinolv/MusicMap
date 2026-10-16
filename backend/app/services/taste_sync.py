"""The account copy of the taste profile (#76), kept in the user's store document."""

from __future__ import annotations

import time
from typing import Any

from pydantic import ValidationError

from app.models.taste import TASTE_LISTS, StoredTasteProfile
from app.services.user_store import USER_PREFIX, UserStore

# Matches TASTE_LIMIT in frontend/src/taste.ts.
TASTE_LIMIT = 50


def _key(value: str) -> str:
    return value.strip().lower()


def merge_taste(
    cloud: StoredTasteProfile | None, local: StoredTasteProfile
) -> tuple[StoredTasteProfile, int, list[str]]:
    """Union each list: cloud entries first, case-insensitive dedupe, at most TASTE_LIMIT.

    Notes: keep the cloud notes, or the local notes when the cloud notes are empty.
    Returns the merged profile, the count of added local entries and the capped lists.
    """
    base = cloud or StoredTasteProfile()
    merged: dict[str, list[str]] = {}
    added = 0
    capped: list[str] = []
    for name in TASTE_LISTS:
        values: list[str] = []
        seen: set[str] = set()
        for value in getattr(base, name):
            if _key(value) not in seen:
                seen.add(_key(value))
                values.append(value)
        for value in getattr(local, name):
            if _key(value) in seen:
                continue
            if len(values) >= TASTE_LIMIT:
                capped.append(name)
                break
            seen.add(_key(value))
            values.append(value)
            added += 1
        merged[name] = values[:TASTE_LIMIT]
    notes = base.notes
    if not notes.strip() and local.notes.strip():
        notes = local.notes
        added += 1
    return StoredTasteProfile(**merged, notes=notes), added, capped


def read_taste(user: dict[str, Any]) -> StoredTasteProfile | None:
    raw = user.get("taste")
    if not isinstance(raw, dict):
        return None
    try:
        profile = StoredTasteProfile.model_validate(raw)
    except ValidationError:
        return None
    return None if profile.is_empty() else profile


async def write_taste(
    store: UserStore, user: dict[str, Any], profile: StoredTasteProfile | None
) -> StoredTasteProfile | None:
    """Last write wins. An empty profile removes the account copy."""
    kept = None if profile is None or profile.is_empty() else profile
    key = USER_PREFIX + str(user["sub"])
    fresh = await store.get(key) or user
    if kept is None:
        fresh.pop("taste", None)
    else:
        fresh["taste"] = kept.model_dump()
    fresh["taste_updated_at"] = int(time.time())
    await store.set(key, fresh)
    return kept
