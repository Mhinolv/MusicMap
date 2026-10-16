"""User and session documents: Upstash Redis over REST, or memory in mock mode (#75).

Keys hold one JSON document each:
- `tunegraph:user:{sub}`: the account (Google `sub`, email, name, timestamps).
- `tunegraph:session:{sid}`: the signed-in user's `sub`, with the session TTL.
"""

from __future__ import annotations

import json
import time
from typing import Any, Protocol

import httpx

from app.config import Settings, get_settings
from app.services.errors import ProviderError, ProviderNotConfigured
from app.services.http import get_client

USER_PREFIX = "tunegraph:user:"
SESSION_PREFIX = "tunegraph:session:"


class UserStore(Protocol):
    async def get(self, key: str) -> dict[str, Any] | None: ...
    async def set(self, key: str, value: dict[str, Any], ttl: int | None = None) -> None: ...
    async def delete(self, key: str) -> None: ...


class MemoryStore:
    """Process-local store for mock mode and tests. Expired keys read as missing."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[str, float | None]] = {}

    async def get(self, key: str) -> dict[str, Any] | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        raw, expires = hit
        if expires is not None and expires <= time.monotonic():
            del self._data[key]
            return None
        return json.loads(raw)

    async def set(self, key: str, value: dict[str, Any], ttl: int | None = None) -> None:
        self._data[key] = (json.dumps(value), time.monotonic() + ttl if ttl else None)

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)

    def clear(self) -> None:
        self._data.clear()


class UpstashStore:
    """Upstash Redis REST API: POST a command array, read `{"result": ...}`."""

    def __init__(self, url: str, token: str) -> None:
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _command(self, *args: str | int) -> Any:
        try:
            r = await get_client().post(self._url, json=list(args), headers=self._headers)
        except httpx.HTTPError as exc:
            raise ProviderError("upstash", "store unreachable") from exc
        if r.status_code >= 400:
            raise ProviderError("upstash", f"store error ({r.status_code})")
        try:
            body = r.json()
        except ValueError as exc:
            raise ProviderError("upstash", "store returned bad JSON") from exc
        if isinstance(body, dict) and body.get("error"):
            raise ProviderError("upstash", "store command failed")
        return body.get("result") if isinstance(body, dict) else None

    async def get(self, key: str) -> dict[str, Any] | None:
        raw = await self._command("GET", key)
        if not isinstance(raw, str):
            return None
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    async def set(self, key: str, value: dict[str, Any], ttl: int | None = None) -> None:
        args: list[str | int] = ["SET", key, json.dumps(value)]
        if ttl:
            args += ["EX", ttl]
        await self._command(*args)

    async def delete(self, key: str) -> None:
        await self._command("DEL", key)


_memory = MemoryStore()


def memory_store() -> MemoryStore:
    return _memory


def get_store(settings: Settings | None = None) -> UserStore:
    s = settings or get_settings()
    if s.mock_providers:
        return _memory
    if not s.upstash_enabled:
        raise ProviderNotConfigured("upstash", "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not configured")
    return UpstashStore(s.upstash_redis_rest_url, s.upstash_redis_rest_token)
