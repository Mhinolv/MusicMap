"""Tiny in-memory TTL cache with in-flight request coalescing.

Good enough for a single-process MVP. Swap for Redis if the app goes multi-instance.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

T = TypeVar("T")

_MISSING = object()


class TTLCache:
    def __init__(self, max_entries: int = 5000) -> None:
        self._data: dict[str, tuple[float, Any]] = {}
        self._inflight: dict[str, asyncio.Future[Any]] = {}
        self._max_entries = max_entries

    def get(self, key: str, default: Any = None) -> Any:
        entry = self._data.get(key)
        if entry is None:
            return default
        expires_at, value = entry
        if expires_at < time.monotonic():
            self._data.pop(key, None)
            return default
        return value

    def set(self, key: str, value: Any, ttl: float) -> None:
        if len(self._data) >= self._max_entries:
            self._evict()
        self._data[key] = (time.monotonic() + ttl, value)

    def delete(self, key: str) -> None:
        self._data.pop(key, None)

    def clear(self) -> None:
        self._data.clear()

    async def get_or_set(
        self, key: str, ttl: float, factory: Callable[[], Awaitable[T]]
    ) -> T:
        """Return the cached value, or compute it once even under concurrent calls."""
        value = self.get(key, _MISSING)
        if value is not _MISSING:
            return value  # type: ignore[return-value]

        pending = self._inflight.get(key)
        if pending is not None:
            return await pending

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._inflight[key] = fut
        try:
            result = await factory()
            self.set(key, result, ttl)
            fut.set_result(result)
            return result
        except BaseException as exc:  # propagate to waiters, never cache errors
            fut.set_exception(exc)
            raise
        finally:
            self._inflight.pop(key, None)

    def _evict(self) -> None:
        now = time.monotonic()
        expired = [k for k, (exp, _) in self._data.items() if exp < now]
        for k in expired:
            self._data.pop(k, None)
        if len(self._data) >= self._max_entries:
            # Drop the oldest-expiring third.
            by_expiry = sorted(self._data.items(), key=lambda kv: kv[1][0])
            for k, _ in by_expiry[: len(by_expiry) // 3]:
                self._data.pop(k, None)

    def __len__(self) -> int:
        return len(self._data)


cache = TTLCache()
