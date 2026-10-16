"""Signed-in user data (#76): the account copy of the taste profile.

Every route needs the #75 session cookie. Without a valid session it answers 401.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.models.taste import StoredTasteProfile, StoredTasteResponse, TasteMergeResponse
from app.services.sessions import COOKIE_NAME, session_user, unsign_session
from app.services.taste_sync import merge_taste, read_taste, write_taste
from app.services.user_store import UserStore, get_store

router = APIRouter(prefix="/api/user", tags=["user"])


def _unauthorized() -> JSONResponse:
    return JSONResponse(status_code=401, content={"error": "Not signed in"})


async def _signed_in(request: Request) -> tuple[UserStore, dict[str, Any]] | None:
    s = get_settings()
    sid = unsign_session(request.cookies.get(COOKIE_NAME), s.session_key)
    if sid is None:
        return None
    store = get_store(s)
    user = await session_user(store, sid)
    return (store, user) if user else None


@router.get("/taste", response_model=StoredTasteResponse)
async def get_taste(request: Request):
    who = await _signed_in(request)
    if who is None:
        return _unauthorized()
    return StoredTasteResponse(profile=read_taste(who[1]))


@router.put("/taste", response_model=StoredTasteResponse)
async def put_taste(body: StoredTasteProfile, request: Request):
    who = await _signed_in(request)
    if who is None:
        return _unauthorized()
    store, user = who
    return StoredTasteResponse(profile=await write_taste(store, user, body))


@router.post("/taste/merge", response_model=TasteMergeResponse)
async def merge_local_taste(body: StoredTasteProfile, request: Request):
    """First sign-in on a device: add this device's profile to the account copy."""
    who = await _signed_in(request)
    if who is None:
        return _unauthorized()
    store, user = who
    cloud = read_taste(user)
    merged, added, capped = merge_taste(cloud, body)
    saved = await write_taste(store, user, merged) if added else cloud
    return TasteMergeResponse(profile=saved, added=added, capped=capped)
