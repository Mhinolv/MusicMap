# TuneGraph

An interactive music relationship explorer. Search an artist, see them as a node, expand outward through
Last.fm's similar-artist graph, and listen to 30-second previews along the way.

Built from `Product_MVP.md`. Stack: **React + TypeScript + D3** frontend, **FastAPI + HTTPX** backend,
in-memory TTL cache, no database.

```
frontend/   Vite + React + D3 force graph          -> http://localhost:5173
backend/    FastAPI, provider adapters, cache      -> http://localhost:8000
dev.sh      runs both
```

## Quick start

Double-click `TuneGraph.command` in Finder to start both servers and open the app in your browser
(closing the Terminal window stops them). Everything below is the manual equivalent.

Prerequisites: Python 3.11+, [uv](https://docs.astral.sh/uv/), Node 20+.

```bash
# 1. Try it immediately with fixture data (no keys):
./dev.sh --mock

# 2. Real data: add a Last.fm key, then run normally
cp backend/.env.example backend/.env
#   edit backend/.env -> LASTFM_API_KEY=...
./dev.sh
```

Open http://localhost:5173 and search for an artist.

Run the backend tests with `cd backend && .venv/bin/pytest`.

## Configuration (`backend/.env`)

| Variable | Required | What it does |
| --- | --- | --- |
| `LASTFM_API_KEY` | **Yes** | Search, similar artists, tags, top tracks. Free key: https://www.last.fm/api/account/create |
| `MUSICBRAINZ_USER_AGENT` | Yes (any value works) | MusicBrainz requires a descriptive UA with contact info, e.g. `TuneGraph/0.1 (you@example.com)` |
| `APPLE_MUSIC_TEAM_ID` | Optional | Enables 30s audio previews via the Apple Music catalog |
| `APPLE_MUSIC_KEY_ID` | Optional | Key ID of your MusicKit private key |
| `APPLE_MUSIC_PRIVATE_KEY` or `APPLE_MUSIC_PRIVATE_KEY_PATH` | Optional | The `.p8` contents (newlines as `\n`) or a path to the file |
| `APPLE_MUSIC_STOREFRONT` | Optional | Catalog storefront, default `us` |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional | Resolves real Spotify artist URLs for the "Open in Spotify" link (client-credentials, no user OAuth) |
| `CORS_ORIGINS` | Optional | Comma-separated allowed origins, default `http://localhost:5173` |
| `TUNEGRAPH_MOCK` | Optional | `1` serves canned fixture data instead of calling any provider |

All secrets stay on the backend. The frontend only ever talks to `/api/*` (proxied by Vite in dev).

### Getting the keys

- **Last.fm**: create an API account at https://www.last.fm/api/account/create. Only the API key is needed;
  the shared secret is not used (no user auth in the MVP).
- **Apple Music** (optional): in the Apple Developer portal, *Certificates, Identifiers & Profiles → Keys*,
  create a key with **Media Services (MusicKit)** enabled. Note the Key ID, download the `.p8` once, and use
  your Team ID from the membership page. The backend signs an ES256 developer token itself.
- **Spotify** (optional): create an app at https://developer.spotify.com/dashboard and copy the client ID/secret.

Without Apple Music, the play buttons resolve to "no preview" and the panel still offers Apple Music / Spotify /
YouTube links. Without Spotify credentials, the Spotify link falls back to a search URL. MusicBrainz link data
(`url-rels`) is used first whenever an artist has an MBID, so real Spotify/Apple links often appear with no
extra keys at all.

## Deploy to Vercel

One Vercel project serves both halves of the app: the Vite build as static files, and the FastAPI
app as a Python serverless function mounted at `/api/*`. The frontend already calls relative
`/api/...` paths, so nothing in `frontend/src` changes between local dev and production.

```
vercel.json        build + output config, the /api/* rewrite, function settings
api/index.py       ASGI entrypoint; puts backend/ on sys.path and re-exports app.main:app
requirements.txt   the function's Python dependencies (pyproject minus uvicorn)
```

1. Push the repo to GitHub and import it at https://vercel.com/new. Leave **Root Directory** at the
   repository root — `vercel.json` points the build at `frontend/` and the function at `api/`.
2. Add the environment variables under *Project Settings → Environment Variables*. The names are
   exactly the ones in the configuration table above; `backend/.env` is never uploaded.
   `LASTFM_API_KEY` and `MUSICBRAINZ_USER_AGENT` are the ones worth setting first.
3. Deploy, then check `https://<your-app>.vercel.app/api/health` — it reports which providers are on.

The CLI equivalent is `npm i -g vercel`, then `vercel` for a preview and `vercel --prod` to promote.

Two variables behave differently in production:

- `APPLE_MUSIC_PRIVATE_KEY_PATH` cannot work — there is no `.p8` on disk. Paste the key contents into
  `APPLE_MUSIC_PRIVATE_KEY` instead, with newlines written as literal `\n`.
- `CORS_ORIGINS` no longer matters for the app itself, since the browser calls the API on its own
  origin. Set it only if something else needs cross-origin access to the API.

Set `TUNEGRAPH_MOCK=1` to put a deployment on fixture data with no keys at all.

### What changes on serverless

- **The cache is per-instance and short-lived.** `cache/cache.py` holds entries in memory, so every
  cold start begins empty and concurrent instances do not share work. The app is correct either way,
  it just makes more provider calls than local dev does. Point the cache at Redis (Vercel KV, Upstash)
  if that becomes a problem.
- **The MusicBrainz throttle is per-instance too.** `services/musicbrainz.py` spaces requests one
  second apart within a single process; several instances running at once can exceed MusicBrainz's
  limit and get throttled back, which surfaces as a `429`/`503` from `/release-date`.
- **Startup and shutdown hooks may not run.** Nothing depends on them: the HTTP client is created
  lazily on first use, and the lifespan handler only logs and closes the client.

## API

```
GET /api/health
GET /api/artists/search?q=radiohead
GET /api/artists/{id}
GET /api/artists/{id}/similar?limit=8
GET /api/artists/{id}/tracks?limit=5
GET /api/artists/{id}/tracks/{track}/preview
GET /api/tracks/search?q=creep
GET /api/tracks/{id}
GET /api/tracks/{id}/release-date
GET /api/tracks/{id}/similar?limit=8
GET /api/tracks/{id}/preview
```

Artist ids are self-describing so no persistence is needed:
`mb:<musicbrainz id>` → `lf:<last.fm slug>` → `nm:<normalized name>` (identity hierarchy from the MVP §9).
Track ids are `tr:<normalized artist>|<normalized track>`. `/api/tracks/{id}` is everything Last.fm knows about a
song (album + art, duration, listeners, top tags as the genre signal, wiki summary); `/similar` is Last.fm's
similar *songs*, de-duplicated. `/release-date` comes from MusicBrainz (Last.fm has no release dates): the album's
release group first, then official non-live recordings matched on title and length, then the recording MBID.
It is a separate call because MusicBrainz is throttled to ~1 request/second.
Provider rate limits are surfaced as `429` with `Retry-After`; missing keys are `503`.

## Layout

```
backend/app/
  api/routes/artists.py   HTTP surface (artists)
  api/routes/tracks.py    HTTP surface (song-seeded maps)
  services/lastfm.py      relationships, tags, tracks (primary engine)
  services/musicbrainz.py identity + streaming links, throttled to 1 req/s
  services/apple_music.py developer token + catalog preview lookup
  services/spotify.py     optional artist links
  services/preview.py     PreviewProvider abstraction
  services/links.py       outbound link resolution with fallbacks
  services/mock.py        fixture data for TUNEGRAPH_MOCK=1
  models/                 internal shapes (providers never leak through)
  cache/cache.py          TTL cache with in-flight coalescing
frontend/src/
  graph/useMusicGraph.ts  client-side graph state, dedupe by id / deterministic edge ids
  components/ForceGraph.tsx  D3 simulation: zoom, pan, drag, animate-in, selection dimming
  components/ArtistPanel.tsx tags, top tracks, preview player, expand, outbound links
  components/SearchBar.tsx   debounced artist / song search with keyboard navigation
  components/JourneyTrail.tsx breadcrumb of expanded nodes: jump to a stop or collapse its branch
```

## Interaction

- Click a node to select it, double-click (or Shift+Enter with focus) to expand.
- Drag nodes, scroll to zoom, drag the background to pan, Esc to deselect.
- Node size grows with connection count; edge weight follows Last.fm similarity.
- Search by **Artist** or **Song** (toggle in the search field, or press Tab in the empty field). A song map is
  song-to-song: every node is a song (teal ♪, labelled with its artist) and expanding one fans out to similar songs.
  The song panel shows album, release date, length, listeners, tags, a description, a preview and outbound links,
  plus an "open artist map" link to switch to that artist's graph.
- **Collapse** (panel or the × on a journey stop) undoes an expansion: everything explored from that node goes.
  **Remove** (panel, or Delete/Backspace with a node selected) drops the node and its branch too. Leaves that
  another expanded node also discovered are kept and re-homed to it. Both are undoable from the toast or with ⌘Z.
- The **journey trail** along the bottom lists every expanded node in order; click a stop to jump to it.
