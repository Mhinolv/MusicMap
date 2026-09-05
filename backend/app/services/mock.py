"""Canned fixture data so the app runs end-to-end before any API keys exist.

Enable with TUNEGRAPH_MOCK=1. Deliberately small: a handful of artists around
Radiohead with hand-written similarity scores.
"""

from __future__ import annotations

from app.models.artist import Artist, ArtistRef, ExternalUrls, SimilarArtist
from app.models.graph import make_artist_id, make_track_id, normalize_name, parse_track_id
from app.models.track import PreviewResult, SimilarTrack, Track, TrackAlbum, TrackDetails, TrackRef

_ARTISTS: dict[str, dict] = {
    "radiohead": {
        "name": "Radiohead",
        "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        "tags": ["alternative", "alternative rock", "art rock", "experimental", "rock"],
        "tracks": ["Creep", "Karma Police", "No Surprises", "Paranoid Android", "Everything in Its Right Place"],
        "similar": {"portishead": 0.73, "the smile": 0.69, "thom yorke": 0.66, "muse": 0.52, "pixies": 0.44, "sigur rós": 0.41, "björk": 0.38},
    },
    "portishead": {
        "name": "Portishead",
        "mbid": "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
        "tags": ["trip-hop", "electronic", "alternative", "downtempo"],
        "tracks": ["Glory Box", "Roads", "Sour Times", "Wandering Star", "Mysterons"],
        "similar": {"massive attack": 0.88, "tricky": 0.71, "björk": 0.55, "radiohead": 0.5, "morcheeba": 0.47, "lamb": 0.42},
    },
    "the smile": {
        "name": "The Smile",
        "mbid": "6cd4a0ee-2d5f-4b1b-9bf3-6ff0a0cb2e21",
        "tags": ["art rock", "experimental rock", "post-punk", "alternative"],
        "tracks": ["You Will Never Work in Television Again", "The Smoke", "Free in the Knowledge", "Bending Hectic", "Wall of Eyes"],
        "similar": {"radiohead": 0.9, "thom yorke": 0.85, "atoms for peace": 0.7, "jonny greenwood": 0.6, "black midi": 0.35},
    },
    "thom yorke": {
        "name": "Thom Yorke",
        "mbid": "8ba1a0ba-5f1c-4c42-8a9e-77f0bd2c5c2a",
        "tags": ["electronic", "experimental", "alternative", "idm"],
        "tracks": ["Hearing Damage", "Black Swan", "Harrowdown Hill", "Suspirium", "Dawn Chorus"],
        "similar": {"radiohead": 0.92, "the smile": 0.85, "atoms for peace": 0.8, "burial": 0.4, "four tet": 0.38, "flying lotus": 0.36},
    },
    "muse": {"name": "Muse", "mbid": "9c9f1380-2516-4fc9-a3e6-f9f61941d090", "tags": ["alternative rock", "rock", "progressive rock"], "tracks": ["Hysteria", "Supermassive Black Hole", "Starlight", "Time Is Running Out", "Uprising"], "similar": {"radiohead": 0.52, "placebo": 0.6, "the killers": 0.45, "arctic monkeys": 0.4, "coldplay": 0.38}},
    "pixies": {"name": "Pixies", "mbid": "b6b2bb8d-54a9-491f-9607-7b546023b433", "tags": ["alternative rock", "indie rock", "90s"], "tracks": ["Where Is My Mind?", "Here Comes Your Man", "Debaser", "Monkey Gone to Heaven", "Gouge Away"], "similar": {"the breeders": 0.85, "sonic youth": 0.6, "pavement": 0.55, "radiohead": 0.44, "dinosaur jr.": 0.5}},
    "sigur rós": {"name": "Sigur Rós", "mbid": "f6f2326f-6b25-4170-b89d-e235b25508e8", "tags": ["post-rock", "ambient", "icelandic"], "tracks": ["Hoppípolla", "Svefn-g-englar", "Sæglópur", "Glósóli", "Untitled #3"], "similar": {"jónsi": 0.9, "explosions in the sky": 0.7, "mogwai": 0.62, "björk": 0.5, "radiohead": 0.41}},
    "björk": {"name": "Björk", "mbid": "87c5dedd-371d-4a53-9f7f-80522fb7f3cb", "tags": ["electronic", "experimental", "art pop", "icelandic"], "tracks": ["Army of Me", "Hyperballad", "Jóga", "It's Oh So Quiet", "Human Behaviour"], "similar": {"portishead": 0.55, "sigur rós": 0.5, "fka twigs": 0.45, "radiohead": 0.38, "massive attack": 0.4, "arca": 0.36}},
    "massive attack": {"name": "Massive Attack", "mbid": "10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8", "tags": ["trip-hop", "electronic", "downtempo"], "tracks": ["Teardrop", "Angel", "Unfinished Sympathy", "Paradise Circus", "Protection"], "similar": {"portishead": 0.88, "tricky": 0.8, "morcheeba": 0.55, "unkle": 0.5, "björk": 0.4}},
    "tricky": {"name": "Tricky", "mbid": "9d4a1ed3-cb88-42a2-b8a5-a4d5b0d0a60d", "tags": ["trip-hop", "electronic", "hip-hop"], "tracks": ["Hell Is Round the Corner", "Overcome", "Black Steel", "Aftermath", "Ponderosa"], "similar": {"massive attack": 0.8, "portishead": 0.71, "morcheeba": 0.4, "unkle": 0.35}},
    "atoms for peace": {"name": "Atoms for Peace", "mbid": "8f9ea1b1-0c95-4d20-a2b5-1d8a3a2c9f11", "tags": ["electronic", "experimental", "supergroup"], "tracks": ["Default", "Ingenue", "Before Your Very Eyes...", "Judge Jury and Executioner", "Amok"], "similar": {"thom yorke": 0.8, "the smile": 0.7, "radiohead": 0.6, "flying lotus": 0.4}},
    "jonny greenwood": {"name": "Jonny Greenwood", "mbid": "f9bb0a4b-1f3d-4b7e-9b95-2f5ae4d1c4f8", "tags": ["soundtrack", "modern classical", "experimental"], "tracks": ["House of Woodcock", "Sandalwood", "Prospectors Arrive", "Henry Plainview", "Alma"], "similar": {"the smile": 0.6, "radiohead": 0.5, "thom yorke": 0.45}},
}

_MB_LINKS = {
    "radiohead": {"spotify": "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb", "apple_music": "https://music.apple.com/us/artist/radiohead/657515"},
    "portishead": {"spotify": "https://open.spotify.com/artist/6liAMWkVf5LH7YR9yfFy1Y", "apple_music": "https://music.apple.com/us/artist/portishead/3573139"},
}


def _by_key(artist_id: str) -> tuple[str, dict] | None:
    for key, data in _ARTISTS.items():
        if make_artist_id(mbid=data["mbid"], lastfm_url=None, name=data["name"]) == artist_id:
            return key, data
        if artist_id in (f"nm:{key}", key):
            return key, data
    return None


def _ref(key: str) -> ArtistRef:
    data = _ARTISTS.get(key) or {"name": key.title(), "mbid": None}
    name = data["name"]
    return ArtistRef(
        id=make_artist_id(mbid=data.get("mbid"), lastfm_url=None, name=name),
        mbid=data.get("mbid"),
        name=name,
        lastfm_url=f"https://www.last.fm/music/{name.replace(' ', '+')}",
    )


def search(query: str, limit: int) -> list[ArtistRef]:
    q = normalize_name(query)
    hits = [k for k in _ARTISTS if q in k]
    # Also surface unknown names so any search "works" in mock mode.
    if not hits:
        hits = [q]
    return [_ref(k) for k in hits[:limit]]


def get_artist(artist_id: str) -> Artist | None:
    found = _by_key(artist_id)
    if found is None:
        return None
    key, data = found
    ref = _ref(key)
    links = _MB_LINKS.get(key, {})
    return Artist(
        **ref.model_dump(),
        tags=data.get("tags", []),
        listeners=1_000_000,
        summary=f"{data['name']} (mock data — set LASTFM_API_KEY and unset TUNEGRAPH_MOCK for real results).",
        external_urls=ExternalUrls(lastfm=ref.lastfm_url, **links),
    )


def get_similar(artist_id: str, limit: int) -> list[SimilarArtist]:
    found = _by_key(artist_id)
    if found is None:
        return []
    _, data = found
    out = []
    for key, score in sorted(data.get("similar", {}).items(), key=lambda kv: -kv[1])[:limit]:
        out.append(SimilarArtist(**_ref(key).model_dump(), similarity=score))
    return out


def get_top_tracks(artist_id: str, limit: int) -> list[Track]:
    found = _by_key(artist_id)
    if found is None:
        return []
    _, data = found
    return [Track(name=t, listeners=500_000 - i * 40_000) for i, t in enumerate(data.get("tracks", [])[:limit])]


def get_preview(artist: str, track: str) -> PreviewResult | None:
    # No real audio in mock mode; exercise the "unavailable" path.
    return None


# --------------------------------------------------------------------------- #
# Tracks
# --------------------------------------------------------------------------- #

# Hand-written song facts for the songs people are most likely to try first.
_SONGS: dict[tuple[str, str], dict] = {
    ("radiohead", "Creep"): {"album": "Pablo Honey", "released": "1992-09-21", "duration": 238, "tags": ["alternative", "90s", "rock", "alternative rock", "grunge"], "summary": "Radiohead's debut single, from Pablo Honey. A quiet-loud anthem the band spent years trying to outrun."},
    ("radiohead", "Karma Police"): {"album": "OK Computer", "released": "1997-08-25", "duration": 264, "tags": ["alternative", "alternative rock", "90s", "rock"], "summary": "Second single from OK Computer."},
    ("radiohead", "No Surprises"): {"album": "OK Computer", "released": "1998-01-12", "duration": 228, "tags": ["alternative", "mellow", "90s"]},
    ("radiohead", "Paranoid Android"): {"album": "OK Computer", "released": "1997-05-26", "duration": 383, "tags": ["alternative", "progressive rock", "art rock"]},
    ("portishead", "Glory Box"): {"album": "Dummy", "released": "1995-01-02", "duration": 308, "tags": ["trip-hop", "downtempo", "90s", "electronic"], "summary": "Closing track of Dummy, built on an Isaac Hayes sample."},
    ("portishead", "Roads"): {"album": "Dummy", "released": "1994-08-22", "duration": 305, "tags": ["trip-hop", "melancholic", "downtempo"]},
    ("massive attack", "Teardrop"): {"album": "Mezzanine", "released": "1998-04-27", "duration": 331, "tags": ["trip-hop", "electronic", "downtempo", "90s"], "summary": "Sung by Elizabeth Fraser of Cocteau Twins; the second single from Mezzanine."},
    ("björk", "Hyperballad"): {"album": "Post", "released": "1996-02-12", "duration": 321, "tags": ["electronic", "art pop", "90s"]},
    ("muse", "Hysteria"): {"album": "Absolution", "released": "2003-12-01", "duration": 227, "tags": ["alternative rock", "rock", "00s"]},
    ("pixies", "Where Is My Mind?"): {"album": "Surfer Rosa", "released": "1988-03-21", "duration": 233, "tags": ["alternative", "indie rock", "80s"]},
    ("sigur rós", "Hoppípolla"): {"album": "Takk...", "released": "2005-11-28", "duration": 268, "tags": ["post-rock", "ambient", "icelandic"]},
    ("the smile", "The Smoke"): {"album": "A Light for Attracting Attention", "released": "2022-01-28", "duration": 296, "tags": ["art rock", "experimental rock"]},
    ("thom yorke", "Black Swan"): {"album": "The Eraser", "released": "2006-07-10", "duration": 289, "tags": ["electronic", "experimental"]},
    ("tricky", "Overcome"): {"album": "Maxinquaye", "released": "1995-02-20", "duration": 268, "tags": ["trip-hop", "90s"]},
}


def _track_ref(key: str, track: str) -> TrackRef:
    artist = _ref(key)
    return TrackRef(
        id=make_track_id(artist=artist.name, track=track),
        name=track,
        artist=artist,
        lastfm_url=f"{artist.lastfm_url}/_/{track.replace(' ', '+')}",
        listeners=750_000,
    )


def _find_track(track_id: str) -> tuple[str, str] | None:
    artist_norm, track_norm = parse_track_id(track_id)
    for key, data in _ARTISTS.items():
        if normalize_name(data["name"]) != artist_norm:
            continue
        for t in data.get("tracks", []):
            if normalize_name(t) == track_norm:
                return key, t
    return None


def search_tracks(query: str, limit: int) -> list[TrackRef]:
    q = normalize_name(query)
    hits: list[TrackRef] = []
    for key, data in _ARTISTS.items():
        for t in data.get("tracks", []):
            if q in normalize_name(t) or q in key:
                hits.append(_track_ref(key, t))
    # Exact-name matches first so "creep" puts Creep at the top.
    hits.sort(key=lambda t: (normalize_name(t.name) != q, t.name))
    return hits[:limit]


def get_track(track_id: str) -> TrackRef | None:
    found = _find_track(track_id)
    if found is None:
        return None
    return _track_ref(*found)


def get_track_details(track_id: str) -> TrackDetails | None:
    found = _find_track(track_id)
    if found is None:
        return None
    key, track = found
    ref = _track_ref(key, track)
    facts = _SONGS.get((key, track), {})
    album = facts.get("album")
    return TrackDetails(
        **ref.model_dump(),
        album=TrackAlbum(title=album) if album else None,
        duration_seconds=facts.get("duration"),
        playcount=4_200_000,
        tags=facts.get("tags") or _ARTISTS[key].get("tags", [])[:4],
        summary=facts.get("summary") or f"{track} by {ref.artist.name} (mock data — set LASTFM_API_KEY and unset TUNEGRAPH_MOCK for real results).",
        release_date=facts.get("released"),
        external_urls=ExternalUrls(lastfm=ref.lastfm_url),
    )


def get_similar_tracks(track_id: str, limit: int) -> tuple[TrackRef, list[SimilarTrack]] | None:
    """Similar songs: one more song by the same artist, then a song from each similar artist."""
    found = _find_track(track_id)
    if found is None:
        return None
    key, track = found
    ref = _track_ref(key, track)
    own = _ARTISTS[key].get("tracks", [])
    idx = own.index(track)
    out: list[SimilarTrack] = []
    if len(own) > 1:
        sibling = own[(idx + 1) % len(own)]
        out.append(SimilarTrack(**_track_ref(key, sibling).model_dump(), similarity=0.62))
    for other, score in sorted(_ARTISTS[key].get("similar", {}).items(), key=lambda kv: -kv[1]):
        tracks = _ARTISTS.get(other, {}).get("tracks", [])
        if not tracks:
            continue
        pick = tracks[idx % len(tracks)]
        out.append(SimilarTrack(**_track_ref(other, pick).model_dump(), similarity=round(score * 0.9, 2)))
    out.sort(key=lambda s: -(s.similarity or 0))
    return ref, out[:limit]
