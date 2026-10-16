"""Server-side sessions behind a signed cookie (#75).

The cookie holds `{sid}.{hmac}`. The session document in the store maps `sid` to the
user's `sub`, so sign-out deletes it and an old cookie stops working at once.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any

from app.services.google_auth import GoogleIdentity
from app.services.user_store import SESSION_PREFIX, USER_PREFIX, UserStore

COOKIE_NAME = "tunegraph_session"


def _signature(sid: str, key: str) -> str:
    return hmac.new(key.encode(), sid.encode(), hashlib.sha256).hexdigest()


def sign_session(sid: str, key: str) -> str:
    return f"{sid}.{_signature(sid, key)}"


def unsign_session(value: str | None, key: str) -> str | None:
    """Return the session id, or None if the cookie is missing or tampered with."""
    if not value or not key or "." not in value:
        return None
    sid, sig = value.rsplit(".", 1)
    if not sid or not hmac.compare_digest(sig, _signature(sid, key)):
        return None
    return sid


def public_user(user: dict[str, Any]) -> dict[str, str]:
    return {"id": user["sub"], "email": user.get("email", ""), "name": user.get("name", "")}


async def upsert_user(store: UserStore, identity: GoogleIdentity) -> dict[str, Any]:
    """Create the account on first sign-in; refresh email and name on later ones."""
    key = USER_PREFIX + identity.sub
    now = int(time.time())
    user = await store.get(key) or {"sub": identity.sub, "created_at": now}
    user.update(email=identity.email, name=identity.name, updated_at=now)
    await store.set(key, user)
    return user


async def create_session(store: UserStore, sub: str, ttl: int) -> str:
    sid = secrets.token_urlsafe(32)
    await store.set(SESSION_PREFIX + sid, {"sub": sub, "created_at": int(time.time())}, ttl)
    return sid


async def session_user(store: UserStore, sid: str | None) -> dict[str, Any] | None:
    if not sid:
        return None
    session = await store.get(SESSION_PREFIX + sid)
    if not session or not session.get("sub"):
        return None
    return await store.get(USER_PREFIX + str(session["sub"]))


async def end_session(store: UserStore, sid: str | None) -> None:
    if sid:
        await store.delete(SESSION_PREFIX + sid)
