"""Application settings, loaded from environment variables / backend/.env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Last.fm (required for anything real) ---------------------------------
    lastfm_api_key: str = Field(default="", alias="LASTFM_API_KEY")

    # --- MusicBrainz -----------------------------------------------------------
    musicbrainz_user_agent: str = Field(
        default="TuneGraph/0.1 (contact@example.com)",
        alias="MUSICBRAINZ_USER_AGENT",
    )

    # --- Apple Music (optional: preview playback) ------------------------------
    apple_music_team_id: str = Field(default="", alias="APPLE_MUSIC_TEAM_ID")
    apple_music_key_id: str = Field(default="", alias="APPLE_MUSIC_KEY_ID")
    # PEM contents of the .p8 key. Newlines may be written as literal "\n".
    apple_music_private_key: str = Field(default="", alias="APPLE_MUSIC_PRIVATE_KEY")
    # Alternatively point at the .p8 file on disk.
    apple_music_private_key_path: str = Field(default="", alias="APPLE_MUSIC_PRIVATE_KEY_PATH")
    apple_music_storefront: str = Field(default="us", alias="APPLE_MUSIC_STOREFRONT")

    # --- Spotify (optional: nicer outbound links) ------------------------------
    spotify_client_id: str = Field(default="", alias="SPOTIFY_CLIENT_ID")
    spotify_client_secret: str = Field(default="", alias="SPOTIFY_CLIENT_SECRET")

    # --- App -------------------------------------------------------------------
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")
    # Serve canned fixture data instead of calling providers. Handy before keys exist.
    mock_providers: bool = Field(default=False, alias="TUNEGRAPH_MOCK")

    # Cache TTLs (seconds)
    ttl_search: int = 30 * 60
    ttl_artist: int = 24 * 3600
    ttl_similar: int = 24 * 3600
    ttl_tracks: int = 12 * 3600
    ttl_musicbrainz: int = 7 * 24 * 3600
    ttl_preview: int = 24 * 3600

    @property
    def lastfm_enabled(self) -> bool:
        return bool(self.lastfm_api_key)

    @property
    def apple_music_private_key_pem(self) -> str:
        if self.apple_music_private_key:
            return self.apple_music_private_key.replace("\\n", "\n")
        if self.apple_music_private_key_path:
            p = Path(self.apple_music_private_key_path).expanduser()
            if p.exists():
                return p.read_text()
        return ""

    @property
    def apple_music_enabled(self) -> bool:
        return bool(
            self.apple_music_team_id
            and self.apple_music_key_id
            and self.apple_music_private_key_pem
        )

    @property
    def spotify_enabled(self) -> bool:
        return bool(self.spotify_client_id and self.spotify_client_secret)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
