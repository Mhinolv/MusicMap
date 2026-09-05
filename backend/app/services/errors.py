"""Provider-neutral exceptions. Routes translate these into HTTP responses."""

from __future__ import annotations


class ProviderError(Exception):
    def __init__(self, provider: str, message: str, *, status: int = 502) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message
        self.status = status


class ProviderNotConfigured(ProviderError):
    def __init__(self, provider: str, hint: str) -> None:
        super().__init__(provider, hint, status=503)


class RateLimited(ProviderError):
    def __init__(self, provider: str, retry_after: float | None = None) -> None:
        super().__init__(provider, "rate limited", status=429)
        self.retry_after = retry_after


class NotFound(ProviderError):
    def __init__(self, provider: str, what: str) -> None:
        super().__init__(provider, f"{what} not found", status=404)
