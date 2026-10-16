"""Google sign-in, session cookie lifecycle and the user store (#75). No live calls."""

from __future__ import annotations

import json
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings
from app.services import google_auth, user_store
from app.services.sessions import COOKIE_NAME, sign_session, unsign_session
from app.services.user_store import SESSION_PREFIX, USER_PREFIX, MemoryStore, UpstashStore

CLIENT_ID = "test-client.apps.googleusercontent.com"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks() -> dict:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
    return {"keys": [{**jwk, "kid": "k1", "alg": "RS256", "use": "sig"}]}


def id_token(*, key=KEY, kid="k1", **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1234567890",
        "email": "ada@example.com", "name": "Ada Lovelace", "iat": now, "exp": now + 600,
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for name in ("VERCEL", "SESSION_COOKIE_SECURE", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
                 "KV_REST_API_URL", "KV_REST_API_TOKEN", "SESSION_SECRET", "GOOGLE_CLIENT_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    fetches = []

    async def fake_jwks():
        fetches.append(1)
        return _jwks()

    monkeypatch.setattr(google_auth, "_fetch_jwks", fake_jwks)
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()
    yield fetches
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()


@pytest.fixture
async def client():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _google_mode(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("SESSION_SECRET", "s3cret")
    get_settings.cache_clear()


# ---- ID token verification --------------------------------------------------------

async def test_valid_token_yields_identity():
    who = await google_auth.verify_id_token(id_token(), CLIENT_ID)
    assert (who.sub, who.email, who.name) == ("1234567890", "ada@example.com", "Ada Lovelace")


async def test_name_falls_back_to_email_local_part():
    who = await google_auth.verify_id_token(id_token(name=None), CLIENT_ID)
    assert who.name == "ada"


@pytest.mark.parametrize("token", [
    "not-a-jwt",
    id_token(aud="someone-else"),
    id_token(iss="https://evil.example.com"),
    id_token(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200),
    id_token(key=OTHER_KEY),
    id_token(sub=None),
    id_token(kid="unknown"),
])
async def test_bad_tokens_are_rejected(token):
    with pytest.raises(google_auth.InvalidIdToken):
        await google_auth.verify_id_token(token, CLIENT_ID)


async def test_unknown_kid_refetches_keys_once(_settings):
    with pytest.raises(google_auth.InvalidIdToken):
        await google_auth.verify_id_token(id_token(kid="rotated"), CLIENT_ID)
    assert len(_settings) == 2
    # The refetched set is cached again, so known keys need no more fetches.
    await google_auth.verify_id_token(id_token(), CLIENT_ID)
    await google_auth.verify_id_token(id_token(), CLIENT_ID)
    assert len(_settings) == 2


# ---- cookie signature -------------------------------------------------------------

def test_cookie_signature_round_trip_and_tamper():
    value = sign_session("abc", "key")
    assert unsign_session(value, "key") == "abc"
    assert unsign_session(value, "other-key") is None
    assert unsign_session("xyz" + value[3:], "key") is None
    for bad in (None, "", "abc", ".sig", "abc."):
        assert unsign_session(bad, "key") is None
    assert unsign_session(value, "") is None


# ---- routes -----------------------------------------------------------------------

async def test_me_is_401_when_signed_out(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401 and r.json()["error"] == "Not signed in"


async def test_me_is_401_without_any_auth_config(client, monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    client.cookies.set(COOKIE_NAME, "abc.def")
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
    r = await client.get("/api/auth/config")
    assert r.json() == {"enabled": False, "google_client_id": "", "mock": False}


async def test_google_sign_in_sets_cookie_and_stable_user(client, monkeypatch):
    _google_mode(monkeypatch)
    r = await client.post("/api/auth/google", json={"credential": id_token()})
    assert r.status_code == 200
    assert r.json()["user"] == {"id": "1234567890", "email": "ada@example.com", "name": "Ada Lovelace"}
    cookie = r.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE_NAME}=")
    lowered = cookie.lower()
    assert "httponly" in lowered and "samesite=lax" in lowered and "path=/" in lowered
    assert "secure" not in lowered  # local http

    r = await client.get("/api/auth/me")
    assert r.status_code == 200 and r.json()["user"]["id"] == "1234567890"

    # A second sign-in (another device) keeps the same id and creation time.
    store = user_store.memory_store()
    created = (await store.get(USER_PREFIX + "1234567890"))["created_at"]
    r = await client.post("/api/auth/google", json={"credential": id_token(name="Ada L.")})
    assert r.json()["user"] == {"id": "1234567890", "email": "ada@example.com", "name": "Ada L."}
    assert (await store.get(USER_PREFIX + "1234567890"))["created_at"] == created


async def test_secure_cookie_on_vercel(client, monkeypatch):
    _google_mode(monkeypatch)
    monkeypatch.setenv("VERCEL", "1")
    get_settings.cache_clear()
    r = await client.post("/api/auth/google", json={"credential": id_token()})
    assert "secure" in r.headers["set-cookie"].lower()


async def test_invalid_google_token_is_401_and_sets_no_cookie(client, monkeypatch):
    _google_mode(monkeypatch)
    r = await client.post("/api/auth/google", json={"credential": id_token(aud="other")})
    assert r.status_code == 401 and "set-cookie" not in r.headers
    r = await client.post("/api/auth/google", json={"credential": ""})
    assert r.status_code == 422


async def test_google_sign_in_needs_config(client, monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    r = await client.post("/api/auth/google", json={"credential": id_token()})
    assert r.status_code == 503


async def test_sign_out_clears_server_session_and_cookie(client, monkeypatch):
    _google_mode(monkeypatch)
    await client.post("/api/auth/google", json={"credential": id_token()})
    old_cookie = client.cookies.get(COOKIE_NAME)
    sid = unsign_session(old_cookie, "s3cret")
    assert await user_store.memory_store().get(SESSION_PREFIX + sid) is not None

    r = await client.post("/api/auth/signout")
    assert r.status_code == 200
    assert f'{COOKIE_NAME}=""' in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]
    assert await user_store.memory_store().get(SESSION_PREFIX + sid) is None
    assert (await client.get("/api/auth/me")).status_code == 401

    # A copy of the old cookie no longer works: the server session is gone.
    client.cookies.set(COOKIE_NAME, old_cookie)
    r = await client.get("/api/auth/me")
    assert r.status_code == 401 and "Max-Age=0" in r.headers["set-cookie"]
    # The account itself stays for the next sign-in.
    assert await user_store.memory_store().get(USER_PREFIX + "1234567890") is not None


async def test_sign_out_when_signed_out_is_ok(client):
    r = await client.post("/api/auth/signout")
    assert r.status_code == 200


async def test_tampered_cookie_is_401(client, monkeypatch):
    _google_mode(monkeypatch)
    await client.post("/api/auth/google", json={"credential": id_token()})
    sid = unsign_session(client.cookies.get(COOKIE_NAME), "s3cret")
    client.cookies.set(COOKIE_NAME, sign_session(sid, "wrong-key"))
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_mock_sign_in_needs_no_credentials(client):
    r = await client.get("/api/auth/config")
    assert r.json() == {"enabled": True, "google_client_id": "", "mock": True}
    r = await client.post("/api/auth/mock")
    assert r.status_code == 200
    assert r.json()["user"] == {"id": "mock-user", "email": "listener@example.com", "name": "Mock Listener"}
    assert (await client.get("/api/auth/me")).json()["user"]["id"] == "mock-user"
    await client.post("/api/auth/signout")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_mock_sign_in_is_off_outside_mock_mode(client, monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    _google_mode(monkeypatch)
    assert (await client.post("/api/auth/mock")).status_code == 404


# ---- stores -----------------------------------------------------------------------

async def test_memory_store_round_trip_and_expiry(monkeypatch):
    store = MemoryStore()
    await store.set("a", {"x": 1})
    await store.set("b", {"y": 2}, ttl=10)
    assert await store.get("a") == {"x": 1} and await store.get("b") == {"y": 2}
    later = time.monotonic() + 11
    monkeypatch.setattr(user_store.time, "monotonic", lambda: later)
    assert await store.get("b") is None and await store.get("a") == {"x": 1}
    await store.delete("a")
    await store.delete("missing")
    assert await store.get("a") is None


def _upstash(monkeypatch, handler):
    calls = []

    def record(request: httpx.Request):
        calls.append((request.headers.get("authorization"), json.loads(request.content)))
        return handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(record))
    monkeypatch.setattr(user_store, "get_client", lambda: client)
    return calls


async def test_upstash_store_commands(monkeypatch):
    data: dict[str, str] = {}

    def handler(request):
        cmd = json.loads(request.content)
        if cmd[0] == "SET":
            data[cmd[1]] = cmd[2]
            return httpx.Response(200, json={"result": "OK"})
        if cmd[0] == "GET":
            return httpx.Response(200, json={"result": data.get(cmd[1])})
        data.pop(cmd[1], None)
        return httpx.Response(200, json={"result": 1})

    calls = _upstash(monkeypatch, handler)
    store = UpstashStore("https://example.upstash.io/", "tok")
    await store.set("k", {"a": 1}, ttl=60)
    assert await store.get("k") == {"a": 1}
    await store.delete("k")
    assert await store.get("k") is None
    assert calls[0] == ("Bearer tok", ["SET", "k", '{"a": 1}', "EX", 60])
    assert [c[1][0] for c in calls] == ["SET", "GET", "DEL", "GET"]


async def test_upstash_store_ignores_non_object_values(monkeypatch):
    _upstash(monkeypatch, lambda request: httpx.Response(200, json={"result": "not json"}))
    assert await UpstashStore("https://x", "t").get("k") is None


@pytest.mark.parametrize("response", [
    httpx.Response(401, json={"error": "WRONGPASS"}),
    httpx.Response(200, json={"error": "ERR syntax"}),
    httpx.Response(200, text="<html>"),
])
async def test_upstash_store_errors_become_provider_errors(monkeypatch, response):
    from app.services.errors import ProviderError

    _upstash(monkeypatch, lambda request: response)
    with pytest.raises(ProviderError) as exc:
        await UpstashStore("https://x", "t").get("k")
    assert exc.value.provider == "upstash" and exc.value.status == 502


async def test_real_mode_uses_upstash(monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    monkeypatch.setenv("KV_REST_API_URL", "https://kv.example.com")
    monkeypatch.setenv("KV_REST_API_TOKEN", "tok")
    get_settings.cache_clear()
    assert isinstance(user_store.get_store(), UpstashStore)
    monkeypatch.delenv("KV_REST_API_URL")
    get_settings.cache_clear()
    from app.services.errors import ProviderNotConfigured

    with pytest.raises(ProviderNotConfigured):
        user_store.get_store()
