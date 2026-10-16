"""Map session history for signed-in users (#77).

Signed-out users keep history in the browser only, so every route here answers 401
without a session. Mock mode uses the in-memory store and needs no Upstash keys.
"""

from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.map_history import (
    BadMap,
    MapTooLarge,
    check_map,
    clear_sessions,
    delete_session,
    get_session,
    list_sessions,
    save_session,
)
from app.services.sessions import COOKIE_NAME, session_user, unsign_session
from app.services.user_store import get_store

router = APIRouter(prefix="/api/history", tags=["history"])

SESSION_ID = r"^[A-Za-z0-9_-]{1,64}$"


class SessionBody(BaseModel):
    seed: str = Field(min_length=1, max_length=300)
    mode: Literal["artist", "track"]
    stops: int = Field(ge=0, le=500)
    updated_at: int = Field(ge=0)
    # check_map applies the 1 MB UTF-8 limit, so oversize maps answer 413.
    map: str = Field(min_length=1)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


async def _user_sub(request: Request) -> str | None:
    s = get_settings()
    sid = unsign_session(request.cookies.get(COOKIE_NAME), s.session_key)
    if sid is None:
        return None
    user = await session_user(get_store(s), sid)
    return str(user["sub"]) if user else None


def _valid_id(sid: str) -> bool:
    return re.fullmatch(SESSION_ID, sid) is not None


@router.get("")
async def history_list(request: Request):
    sub = await _user_sub(request)
    if sub is None:
        return _error(401, "Not signed in")
    return {"sessions": await list_sessions(get_store(), sub)}


@router.get("/{sid}")
async def history_get(sid: str, request: Request):
    sub = await _user_sub(request)
    if sub is None:
        return _error(401, "Not signed in")
    session = await get_session(get_store(), sub, sid) if _valid_id(sid) else None
    if session is None:
        return _error(404, "Map not found")
    return session


@router.put("/{sid}")
async def history_put(sid: str, body: SessionBody, request: Request):
    sub = await _user_sub(request)
    if sub is None:
        return _error(401, "Not signed in")
    if not _valid_id(sid):
        return _error(422, "Bad map id")
    try:
        check_map(body.map)
    except MapTooLarge as exc:
        return _error(413, str(exc))
    except BadMap as exc:
        return _error(422, str(exc))
    sessions = await save_session(get_store(), sub, {"id": sid, **body.model_dump()})
    return {"sessions": sessions}


@router.delete("/{sid}")
async def history_delete(sid: str, request: Request):
    sub = await _user_sub(request)
    if sub is None:
        return _error(401, "Not signed in")
    if not _valid_id(sid):
        return _error(422, "Bad map id")
    return {"sessions": await delete_session(get_store(), sub, sid)}


@router.delete("")
async def history_clear(request: Request):
    sub = await _user_sub(request)
    if sub is None:
        return _error(401, "Not signed in")
    await clear_sessions(get_store(), sub)
    return {"sessions": []}
