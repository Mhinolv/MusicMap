"""Application settings, loaded from environment variables / backend/.env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
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
    # Keyless iTunes Search previews, used after MusicKit. Set ITUNES_PREVIEWS=0 to turn off.
    itunes_previews: bool = Field(default=True, alias="ITUNES_PREVIEWS")

    # --- Spotify (optional: nicer outbound links) ------------------------------
    spotify_client_id: str = Field(default="", alias="SPOTIFY_CLIENT_ID")
    spotify_client_secret: str = Field(default="", alias="SPOTIFY_CLIENT_SECRET")

    # --- JEV via TypeSafe (personal taste estimates) ----------------------------
    jev_api_key: str = Field(default="", alias="JEV_API_KEY")
    # Requests go to {base}/systemone; override only to point at another compatible host.
    jev_base_url: str = Field(default="https://api.typesafe.ai/v1", alias="JEV_BASE_URL")
    # Pinned rather than jev-latest so a silent model move cannot change cached judgments.
    jev_model: str = Field(default="jev-1.13.0", alias="JEV_MODEL")

    # --- Accounts: Google sign-in + Upstash Redis user store (#75) ---------------
    # Public OAuth client ID; the browser gets it from /api/auth/config.
    google_client_id: str = Field(default="", alias="GOOGLE_CLIENT_ID")
    # Upstash REST credentials. The Vercel Marketplace integration names them KV_REST_API_*.
    upstash_redis_rest_url: str = Field(
        default="", validation_alias=AliasChoices("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL")
    )
    upstash_redis_rest_token: str = Field(
        default="", validation_alias=AliasChoices("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN")
    )
    # HMAC key for the session cookie. Mock mode falls back to a fixed development key.
    session_secret: str = Field(default="", alias="SESSION_SECRET")
    # Secure cookie flag. Unset means "on when running on Vercel".
    session_cookie_secure: bool | None = Field(default=None, alias="SESSION_COOKIE_SECURE")
    on_vercel: bool = Field(default=False, alias="VERCEL")
    ttl_session: int = 30 * 24 * 3600

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
    ttl_taste: int = 15 * 60

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
    def jev_enabled(self) -> bool:
        return bool(self.jev_api_key)

    @property
    def upstash_enabled(self) -> bool:
        return bool(self.upstash_redis_rest_url and self.upstash_redis_rest_token)

    @property
    def session_key(self) -> str:
        if self.session_secret:
            return self.session_secret
        return "tunegraph-mock-session-key" if self.mock_providers else ""

    @property
    def auth_enabled(self) -> bool:
        """Real Google sign-in needs the client ID, the store and the signing key."""
        return bool(self.google_client_id and self.upstash_enabled and self.session_secret)

    @property
    def cookie_secure(self) -> bool:
        if self.session_cookie_secure is not None:
            return self.session_cookie_secure
        return self.on_vercel

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
