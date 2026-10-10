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
        while True:
            value = self.get(key, _MISSING)
            if value is not _MISSING:
                return value  # type: ignore[return-value]

            pending = self._inflight.get(key)
            if pending is None:
                break
            try:
                # Shield: a waiter hitting its own deadline must not cancel the shared work.
                value = await asyncio.shield(pending)
                if value is not _MISSING:
                    return value  # type: ignore[return-value]
                # A batch (get_or_set_many) left this key unanswered; compute anew.
            except asyncio.CancelledError:
                if not pending.cancelled():
                    raise  # this waiter itself was cancelled
                # The computing caller was cancelled (e.g. its deadline); compute anew.

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._inflight[key] = fut
        try:
            result = await factory()
            self.set(key, result, ttl)
            fut.set_result(result)
            return result
        except asyncio.CancelledError:
            fut.cancel()
            raise
        except BaseException as exc:  # propagate to waiters, never cache errors
            fut.set_exception(exc)
            fut.exception()  # mark retrieved so a waiter-less failure is not logged
            raise
        finally:
            self._inflight.pop(key, None)

    async def get_or_set_many(
        self, keys: list[str], ttl: float,
        factory: Callable[[list[str]], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        """Batch form of get_or_set. Cached keys return directly, keys another caller is
        already computing are awaited, and the rest are computed with one factory(missing)
        call. Keys the factory leaves out are not cached and are absent from the result."""
        found: dict[str, Any] = {}
        waiting: dict[str, asyncio.Future[Any]] = {}
        missing: list[str] = []
        for key in dict.fromkeys(keys):
            value = self.get(key, _MISSING)
            if value is not _MISSING:
                found[key] = value
            elif key in self._inflight:
                waiting[key] = self._inflight[key]
            else:
                missing.append(key)

        if missing:
            loop = asyncio.get_running_loop()
            futures = {key: loop.create_future() for key in missing}
            self._inflight.update(futures)
            try:
                computed = await factory(missing)
            except asyncio.CancelledError:
                for fut in futures.values():
                    fut.cancel()
                raise
            except BaseException as exc:  # propagate to waiters, never cache errors
                for fut in futures.values():
                    fut.set_exception(exc)
                    fut.exception()
                raise
            finally:
                for key, fut in futures.items():
                    if self._inflight.get(key) is fut:
                        self._inflight.pop(key)
            for key, fut in futures.items():
                value = computed.get(key, _MISSING)
                if value is not _MISSING:
                    self.set(key, value, ttl)
                    found[key] = value
                fut.set_result(value)

        for key, pending in waiting.items():
            try:
                value = await asyncio.shield(pending)
            except asyncio.CancelledError:
                if not pending.cancelled():
                    raise
                continue  # the computing caller was cancelled: leave this key unanswered
            if value is not _MISSING:
                found[key] = value
        return found

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
