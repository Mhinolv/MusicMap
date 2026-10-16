"""Verify Google Identity Services ID tokens on the backend (#75).

The browser sends the `credential` JWT from the Google button. The backend checks the
RS256 signature against Google's published keys, the audience, issuer and expiry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import jwt

from app.cache.cache import cache
from app.services.errors import ProviderError
from app.services.http import get_client

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
# Google rotates keys about every few days and serves them with a long max-age.
JWKS_TTL = 3600


class InvalidIdToken(Exception):
    """The ID token is malformed, expired, for another app, or badly signed."""


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str
    name: str


async def _fetch_jwks() -> dict[str, Any]:
    try:
        r = await get_client().get(GOOGLE_CERTS_URL)
    except httpx.HTTPError as exc:
        raise ProviderError("google", "certificate fetch failed") from exc
    if r.status_code != 200:
        raise ProviderError("google", f"certificate fetch failed ({r.status_code})")
    return r.json()


async def google_jwks() -> dict[str, Any]:
    return await cache.get_or_set("google:jwks", JWKS_TTL, _fetch_jwks)


async def verify_id_token(token: str, client_id: str) -> GoogleIdentity:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as exc:
        raise InvalidIdToken("malformed token") from exc
    keys = {k.get("kid"): k for k in (await google_jwks()).get("keys", [])}
    jwk = keys.get(kid)
    if jwk is None:
        # A key rotation can be newer than the cached set: refetch once.
        cache.delete("google:jwks")
        keys = {k.get("kid"): k for k in (await google_jwks()).get("keys", [])}
        jwk = keys.get(kid)
    if jwk is None:
        raise InvalidIdToken("unknown signing key")
    try:
        claims = jwt.decode(
            token,
            jwt.PyJWK.from_dict(jwk).key,
            algorithms=["RS256"],
            audience=client_id,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
            leeway=30,
        )
    except jwt.PyJWTError as exc:
        raise InvalidIdToken(str(exc)) from exc
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise InvalidIdToken("wrong issuer")
    sub = str(claims.get("sub") or "")
    if not sub:
        raise InvalidIdToken("missing subject")
    email = str(claims.get("email") or "")
    name = str(claims.get("name") or claims.get("given_name") or email.split("@")[0] or "")
    return GoogleIdentity(sub=sub, email=email, name=name)
