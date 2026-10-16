"""Optional Google sign-in with an HttpOnly session cookie (#75).

Signed-out use needs none of this: `/me` answers 401 and every other route works as before.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.services.errors import ProviderNotConfigured
from app.services.google_auth import GoogleIdentity, InvalidIdToken, verify_id_token
from app.services.sessions import (
    COOKIE_NAME,
    create_session,
    end_session,
    public_user,
    sign_session,
    session_user,
    unsign_session,
    upsert_user,
)
from app.services.user_store import get_store

router = APIRouter(prefix="/api/auth", tags=["auth"])

MOCK_IDENTITY = GoogleIdentity(sub="mock-user", email="listener@example.com", name="Mock Listener")


class GoogleSignIn(BaseModel):
    credential: str = Field(min_length=1, max_length=8192)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _set_cookie(response: Response, sid: str, s: Settings) -> None:
    response.set_cookie(
        COOKIE_NAME,
        sign_session(sid, s.session_key),
        max_age=s.ttl_session,
        path="/",
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
    )


def _clear_cookie(response: Response, s: Settings) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=s.cookie_secure, samesite="lax")


async def _sign_in(identity: GoogleIdentity, s: Settings) -> JSONResponse:
    store = get_store(s)
    user = await upsert_user(store, identity)
    sid = await create_session(store, identity.sub, s.ttl_session)
    response = JSONResponse(content={"user": public_user(user)})
    _set_cookie(response, sid, s)
    return response


@router.get("/config")
async def auth_config() -> dict:
    s = get_settings()
    return {
        "enabled": s.auth_enabled or s.mock_providers,
        "google_client_id": s.google_client_id if s.auth_enabled or s.mock_providers else "",
        "mock": s.mock_providers,
    }


@router.post("/google")
async def sign_in_google(body: GoogleSignIn):
    s = get_settings()
    if not s.google_client_id or not s.session_key:
        raise ProviderNotConfigured("google", "GOOGLE_CLIENT_ID and SESSION_SECRET are not configured")
    try:
        identity = await verify_id_token(body.credential, s.google_client_id)
    except InvalidIdToken:
        return _error(401, "Google sign-in could not be verified")
    return await _sign_in(identity, s)


@router.post("/mock")
async def sign_in_mock():
    s = get_settings()
    if not s.mock_providers:
        return _error(404, "Not found")
    return await _sign_in(MOCK_IDENTITY, s)


@router.get("/me")
async def me(request: Request):
    s = get_settings()
    sid = unsign_session(request.cookies.get(COOKIE_NAME), s.session_key)
    if sid is None:
        return _error(401, "Not signed in")
    user = await session_user(get_store(s), sid)
    if user is None:
        response = _error(401, "Not signed in")
        _clear_cookie(response, s)
        return response
    return {"user": public_user(user)}


@router.post("/signout")
async def sign_out(request: Request):
    s = get_settings()
    sid = unsign_session(request.cookies.get(COOKIE_NAME), s.session_key)
    if sid is not None:
        await end_session(get_store(s), sid)
    response = JSONResponse(content={"ok": True})
    _clear_cookie(response, s)
    return response
