"""Server-side JevLab adapter. The API key never reaches the browser."""

from __future__ import annotations

import httpx

from app.config import get_settings
from app.models.taste import TasteProfile
from app.services.errors import ProviderError, ProviderNotConfigured, RateLimited
from app.services.http import get_client, retry_after_seconds


async def estimate_fit(profile: TasteProfile, target: dict) -> tuple[float, str | None]:
    settings = get_settings()
    if not settings.jev_enabled:
        raise ProviderNotConfigured("jev", "JEV_API_KEY is not configured")

    payload = {
        "model": "jev-latest",
        "question_id": "taste_fit",
        "state": {
            "listener_preferences": profile.model_dump(),
            "music": target,
        },
        "instructions": (
            "Based only on the listener's stated music preferences and the supplied music facts, "
            "is this listener likely to enjoy this music? Treat dislikes as negative evidence. "
            "Do not assume missing facts or infer preference from popularity."
        ),
        "criteria": {
            "true": "The supplied music facts align clearly with the listener's likes and do not strongly conflict with dislikes.",
            "false": "The facts conflict with the listener's dislikes or give little reason to expect enjoyment.",
        },
    }
    try:
        response = await get_client().post(
            f"{settings.jev_base_url.rstrip('/')}/noul",
            json=payload,
            headers={"X-API-Key": settings.jev_api_key},
            timeout=httpx.Timeout(24.0, connect=5.0),
        )
    except httpx.HTTPError as exc:
        raise ProviderError("jev", "request timed out or failed") from exc

    if response.status_code == 429:
        raise RateLimited("jev", retry_after_seconds(response))
    if response.status_code >= 400:
        raise ProviderError("jev", f"HTTP {response.status_code}")
    try:
        body = response.json()
        # Single-question endpoints return a one-item list in the cheatsheet.
        result = body[0] if isinstance(body, list) else body
        value = result["answers"]["taste_fit"]["noul"]
        score = float(value)
        if not 0 <= score <= 1:
            raise ValueError("outside expected range")
        return score, result.get("model")
    except (IndexError, KeyError, TypeError, ValueError, AttributeError) as exc:
        raise ProviderError("jev", "invalid response") from exc
