"""Identity helpers shared by every provider adapter.

Identity hierarchy (see MVP §9):
  1. MusicBrainz ID          -> "mb:<mbid>"
  2. Last.fm canonical URL   -> "lf:<url slug>"
  3. normalized artist name  -> "nm:<normalized name>"

Every id is self-describing so the API can resolve it back to a provider lookup
without any persistent store.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import unquote_plus

_WS = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    name = unicodedata.normalize("NFKC", name)
    name = name.strip().lower()
    return _WS.sub(" ", name)


def lastfm_slug(url: str | None) -> str | None:
    """Extract the artist slug from a Last.fm URL like https://www.last.fm/music/Radiohead."""
    if not url:
        return None
    m = re.search(r"/music/([^/?#]+)", url)
    return m.group(1) if m else None


def make_artist_id(*, mbid: str | None, lastfm_url: str | None, name: str) -> str:
    if mbid:
        return f"mb:{mbid}"
    slug = lastfm_slug(lastfm_url)
    if slug:
        return f"lf:{slug}"
    return f"nm:{normalize_name(name)}"


def parse_artist_id(artist_id: str) -> tuple[str, str]:
    """Return (kind, value). Unknown/unprefixed ids are treated as names."""
    if ":" in artist_id:
        kind, value = artist_id.split(":", 1)
        if kind in {"mb", "lf", "nm"}:
            if kind == "lf":
                value = unquote_plus(value)
            return kind, value
    return "nm", artist_id


def edge_id(a: str, b: str) -> str:
    lo, hi = sorted((a, b))
    return f"{lo}::{hi}"


# --------------------------------------------------------------------------- #
# Track ids: "tr:<normalized artist>|<normalized track>"
# --------------------------------------------------------------------------- #

TRACK_SEP = "|"


def make_track_id(*, artist: str, track: str) -> str:
    return f"tr:{normalize_name(artist)}{TRACK_SEP}{normalize_name(track)}"


def parse_track_id(track_id: str) -> tuple[str, str]:
    """Return (artist, track) from a track id. Artist names never contain the separator
    in practice, so the split happens at the first one."""
    value = track_id[3:] if track_id.startswith("tr:") else track_id
    artist, _, track = value.partition(TRACK_SEP)
    return artist, track
