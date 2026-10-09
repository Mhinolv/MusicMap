"""Expose only the public Spotify client ID for browser-based PKCE authorization."""

from fastapi import APIRouter

from app.config import get_settings
from app.services.errors import ProviderNotConfigured

router = APIRouter(prefix="/api/spotify", tags=["spotify"])


@router.get("/config")
async def spotify_config() -> dict[str, str]:
    client_id = get_settings().spotify_client_id
    if not client_id:
        raise ProviderNotConfigured("spotify", "SPOTIFY_CLIENT_ID is not configured")
    return {"client_id": client_id}
