# AGENTS.md

Brief for every agent working in this repo (MusicMap, product name **TuneGraph**).

## Product Overview

TuneGraph is an interactive map for discovering music. A listener searches an artist or song, sees it as a node in a D3 force graph, and expands outward through related artists or songs, listening to 30-second previews on the way.

- **Artist mode:** artist-to-artist graph from Last.fm similar artists; expand on double-click (long-press on touch); artist panel with tags, top tracks, preview and outbound links.
- **Song mode:** song-to-song graph. Edge weight blends Last.fm track match (0.6, `COLLAB_WEIGHT`) with a tag-vector cosine (0.4); shared tags show on edge hover. Song panel shows the first release date from MusicBrainz. Journey-trail breadcrumb, branch pruning (collapse / remove with one-level undo).
- **Taste profile:** "Add your music taste" (liked artists, songs, genres, dislikes, notes) kept in browser local storage (`tunegraph:taste:v1`); no accounts, no profile database. "Import top music" uses Spotify PKCE (`user-top-read`, token in memory only). "Check my taste" posts the profile plus item metadata to the backend, which calls JevLab `/systemone` once (fit Score + evidence Noul); the panel shows a named fit band or "Not enough information" / "Uncertain estimate", never a percent, and it is not the graph's similarity score.
- **Mobile:** bottom-sheet panel, long-press to expand, safe-area and `dvh` sizing.
- Production: https://music-map-lovat.vercel.app (one Vercel project serves the Vite build and the FastAPI function via `api/index.py`).

## Architecture Map

| Area | Files |
|---|---|
| App shell, mode switch, taste profile storage | `frontend/src/App.tsx`, `frontend/src/index.css` |
| API client and shared types | `frontend/src/api.ts`, `frontend/src/types.ts` |
| Graph state: expand, prune (`planPrune`), journey | `frontend/src/graph/useMusicGraph.ts` |
| Force graph rendering, gestures | `frontend/src/components/ForceGraph.tsx` |
| Side / bottom-sheet panel for artists and songs | `frontend/src/components/ArtistPanel.tsx` |
| Search, journey breadcrumb | `frontend/src/components/SearchBar.tsx`, `frontend/src/components/JourneyTrail.tsx` |
| Taste profile UI and taste check | `frontend/src/components/TastePreferences.tsx`, `frontend/src/components/TasteCheck.tsx` |
| Spotify PKCE import | `frontend/src/spotifyImport.ts` |
| HTTP routes | `backend/app/api/routes/{artists,tracks,taste,spotify_auth}.py` |
| Response models | `backend/app/models/{artist,graph,track,taste}.py` |
| Providers | `backend/app/services/{lastfm,musicbrainz,apple_music,spotify,jev,links,preview}.py` |
| Song similarity blend | `backend/app/services/similarity.py` |
| Fixture data for mock mode | `backend/app/services/mock.py` |
| Cache (in-memory TTL) and settings | `backend/app/cache/cache.py`, `backend/app/config.py` |
| Tests | `backend/tests/` (pytest). The frontend has no unit-test runner; its gate is typecheck + build + lint. |

## Build and test

- Backend tests: `cd backend && python -m pytest -q` (local venv: `backend/.venv`).
- Frontend: `cd frontend && npm run build` (runs `tsc -b` then `vite build`) and `npm run lint` (oxlint).
- Run locally: `./dev.sh --mock` serves fixture data with no keys (`TUNEGRAPH_MOCK=1`).
- CI (`.github/workflows/ci.yml`) runs both; `CI / ci-gate` and `PR template / check` are required on `main`.

## Rules

- All secrets stay on the backend; the frontend only calls `/api/*`. Never put keys in frontend code or commits.
- Keep artist mode behaviour intact when extending song mode.
- Do not propose the Spotify audio-features or recommendations APIs (closed to new apps since Nov 2024) or Pandora genome data (unobtainable).
- MusicBrainz allows about 1 request per second; route calls through the existing service and cache.
- The Vercel function has a small bundle and time budget: heavy native dependencies (for example audio analysis libraries) need a plan for that limit.
- Local-storage format: changes to `tunegraph:taste:v1` must keep previously saved profiles loading (bump the key and migrate if the shape changes).
- New backend behaviour needs pytest coverage, and mock mode must keep working for any new endpoint.

## Team Roadmap Workflow (multi-agent, GitHub)

A multi-agent team works the release milestone in GitHub (`Mhinolv/MusicMap`). GitHub Issues are the single source of truth; every change ships as a pull request into `main`. Roles:

| Role | Responsibility | Output |
|---|---|---|
| Orchestrator | Supervises, prioritizes, creates issue branches, commits/pushes for the engineer, opens PRs, final approver | Merges PRs, closes issues |
| Product Research | Competitor analysis and gap finding | `research.md` |
| Product Manager | Turns gaps/requests into issues (Problem, Scope & Boundaries, Acceptance criteria) | Issues + `**PM review**` comments |
| UI/UX | `## Design notes` section of each issue | Body section + `**UX notes**` comment |
| Engineer | Implements one issue on its linked branch; regression test first for bugs | Changes + `PR BODY` / `COMMIT FILES` blocks |
| QA | Reviews the PR against the issue's acceptance criteria, design notes and owner decisions | Inline review comments + `QA RESULT: PASS/FAIL` PR comment |

Issue flow labels (exactly one at a time): `needs-pm` → `needs-ux` → `ready` → `in-progress` → `in-review` → (`needs-owner-check`) → closed. Also: `bug`/`feature`, `P0`–`P3`, `owner-request`, `redesign`, `blocked`; PR labels `qa-pass`/`qa-fail`.

Rules:
- Issue bodies use the sections `## Problem / Request`, `## Scope & Boundaries`, `## Acceptance criteria`, `## Design notes`, `## Owner decisions`. Edit one section at a time; never drop the others.
- Product-owner decisions are posted as `**Owner decision:** …` comments and mirrored in `## Owner decisions`; they override earlier wording.
- One issue = one branch (`<n>-<slug>`, created with `gh issue develop`) = one PR into `main`. Commits: `#<n>: <summary>`, with no Co-Authored-By trailer. Stage only the files changed for that issue. Never `git add -A`. Never commit directly to main.
- PRs must satisfy the PR template (Issue / What changed / How it was tested / Screenshots). `Refs #n` instead of `Closes #n` while the owner still has to check it.
- CI (build + tests) and the PR-template check must be green before merge.
- The Engineer does not commit, push, open PRs or close issues. QA does not modify source. Only the Orchestrator merges PRs and closes issues.
- For milestone v1, **QA PASS + green CI + Orchestrator approval replaces the manual user-test gate** (delegated by the product owner on 2026-10-10), except issues labelled `needs-owner-check`.
- No agent may use browser/Chrome/computer-use/GUI automation tools.
