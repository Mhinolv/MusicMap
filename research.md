# TuneGraph product research

Research date: 2026-10-10. Scope: this checkout, live web search and text retrieval; no browser or GUI automation. Competitor features are documented capabilities, not hands-on acceptance tests. Prices are as displayed by the cited sources, excluding promotions and taxes; regional and store differences apply.

## Executive Summary

TuneGraph should own **deliberate, visible music exploration**: choose a song, follow connections, steer the next expansion, and keep worthwhile discoveries. Its strongest direct comparators are Music-Map/Gnoosic, Musicroamer, Liveplasma, and now Chosic's artist map. Spotify, Pandora, Last.fm, genre atlases, and collectors' tools compete for the same discovery session through different interfaces. This is a workflow comparison, not a verified market-share ranking.

Recommend **features 1–6 for milestone v1**, in order: local bookmarks, resume the last map, whole-trail song re-ranking, persistent song exclusions, tag steering, and artist diversity within song expansions. These are six focused PRs requiring no new service, account, database, or inaccessible recommendation API. They improve discovery continuity and control while retaining the graph as the main experience. If only five fit, defer #6.

The owner-requested **journey re-ranking is genuinely missing** and ranks #3. Existing scoring uses only the parent song. It also truncates the candidates before re-ranking; changing scores without widening the bounded candidate pool would merely reorder the same seven results. The owner-requested **acoustic analysis of Apple previews is also absent**, but is not ready for a production v1 commitment. Candidate #11 scopes it to a single-PR feasibility prototype; preview-analysis permission, decoding, deployment size, cold starts, and measured relevance remain unverified. Ten user-facing features are feasible without that experiment.

Evidence limitations:

- `AGENTS.md` does not exist at the repo root. A repository Markdown-file inventory found `README.md` and `Product_MVP.md`, but no release/review documents. Both available documents were read. The implementation has outgrown several original MVP non-goals, notably song maps, Spotify import and tag-vector scoring; current code and this mission govern the recommendations.
- The supplied GitHub issue list is empty. A text fetch of [the issue page](https://github.com/Mhinolv/MusicMap/issues) failed. **Open-issue deduplication is unverified.** No existing issue numbers were available to reference as `#N`, and no numbers are invented. No duplicates were identified in the supplied snapshot; reconcile these candidates with the live backlog before creating tickets.
- No TuneGraph usage data or user interviews were supplied. Priority is a product judgment based on code, workflow friction, and competitor precedent, not measured conversion or retention uplift.
- Source access does not prove playback, login or export works today. Unknowns are explicit below, especially on older map sites.

## Competitors

“Relative weakness” describes fit against TuneGraph's branching artist/song exploration. Where absence cannot be established from documentation, it is marked **unverified** rather than asserted as fact.

| Competitor / relationship | Platform and price | Target user and standout capabilities | Relative weakness / TuneGraph opportunity |
| --- | --- | --- | --- |
| **Music-Map + Gnoosic — direct** | Web. Public search is accessible; a definitive current pricing statement was not found (**free pricing unverified**). | Fast artist discovery. Music-Map offers an artist-seeded spatial map; Gnoosic accepts three liked bands for discovery. [Music-Map](https://www.music-map.com/?trk=public_post-text), [Gnoosic](https://www.gnoosic.com/faves.php). | Artist-first entry versus TuneGraph's song nodes, detailed song panel and retained exploration branches. Comparable song graphs, preview player and branch undo were not verified. |
| **Musicroamer — direct** | Web; current price **unverified**. Saving maps requires registration/login according to its homepage. | Visual explorers; related-artist graph, top-track previews, save/update maps. [Product page](https://www.musicroamer.com/). | TuneGraph can deliver local persistence without registration. Song-to-song expansion and pruning are **unverified**. Search-index evidence is old; current player and account functionality were not tested. |
| **Liveplasma — direct** | Web; public discovery page, current price **unverified**. | Casual explorers of music and books; artist-seeded map discovery. [Product page](https://www.liveplasma.com/index.php). | Song graphs, save/share, playback and branch controls are **unverified** in current evidence; do not carry historical Liveplasma features forward as current facts. TuneGraph's verified song workflow is the clearer differentiator. |
| **Chosic — direct and adjacent** | Web; artist map explicitly free with unlimited searches and no signup. Paid/ad-free pricing for other tools **unverified**. | Playlist builders and visual explorers. Artist map exposes similarity, genre grouping, popularity tiers and previews. Separate generator takes songs, artists, genres, moods or playlist links, with Spotify saving documented. [Artist map](https://www.chosic.com/music-artists-map/), [generator](https://www.chosic.com/playlist-generator/), [save/preview documentation](https://www.chosic.com/playlist-generator/?track=1jgTiNob5cVyXeJ3WgX5bL). | Strongest breadth competitor. A unified branching song graph with trail/pruning was **not verified**. Generator text was search-index accessible, but direct retrieval returned 403; runtime/export reliability remains unverified. |
| **Every Noise at Once — adjacent visual discovery** | Web; public map/index; current paid pricing **unverified**, no paid plan verified. | Genre explorers; genre-space map, scan/list/playlist navigation and Spotify links. [Creator-hosted index](https://www.furia.com/everynoise_public/), [list example](https://www.furia.com/everynoise_public/everynoise1d-bigroom.html). | A genre atlas rather than a personal song journey. Reporting describes loss of updating access after December 2023; **current dataset freshness and playable samples unverified**. [Background](https://en.wikipedia.org/wiki/Every_Noise_at_Once). |
| **Spotify Radio / Discover — adjacent** | Web, desktop, mobile and connected devices. Free tier; US Premium Individual **$12.99/month**. | Mainstream listeners wanting immediate listening. Artist/album/song Radio, personalized discovery, saved music and shared listening. [Radio](https://support.spotify.com/sb/article/spotify-radio/), [plans/platforms](https://www.spotify.com/us/premium/). | Account/service-centric listening rather than an inspectable branching journey. Comparable user-prunable discovery graph **unverified**. TuneGraph should complement its playback, not recreate it. |
| **Pandora — adjacent** | Web/mobile; ad-supported tier; direct-web Plus **$4.99/month**, Premium **$10.99/month** in retrieved FAQ. | Radio listeners; thumbs feedback, station seeds and modes such as Discovery, Deep Cuts and Newly Released. [Plans](https://help.pandora.com/s/article/000001089), [station controls](https://help.pandora.com/s/article/Tips-to-improve-stations-1519949305949?language=en_US), [modes](https://help.pandora.com/s/article/Pandora-Modes?language=en%5C_US). | Passive station flow versus selecting visible alternatives and pruning branches. Genome data is unavailable to this project; imitate controllability, not its proprietary model. Current checkout prices beyond the retrieved FAQ are unverified. |
| **Last.fm — adjacent and underlying provider** | Web plus desktop/mobile scrobbling tools. Public browsing; Pro page rendered **€4.99/month** (not a verified US price). | Listening-history enthusiasts; scrobbling profiles, reports, library tools and recommendation ecosystem. [Tracking](https://www.last.fm/about/trackmymusic?showplatform=Windows), [Pro](https://www.last.fm/pro), [recommendation background](https://blog.last.fm/2013/06/24/welcome-to-your-new-home). | Profile/history centered. TuneGraph makes Last.fm relationships spatial and offers a browser-local profile. Comparable branch exploration is **unverified**; TuneGraph's use of the same provider also limits recommendation differentiation. |
| **Radiooooo — adjacent** | Web, verified iPhone/iPad app. Free download; US App Store lists unlimited-access purchases **$4.49 / $45.99**, but billing periods and current web price are **unverified**. | Adventurous listeners; human-curated discovery by country and decade. [App listing](https://apps.apple.com/us/app/radiooooo/id893151807), [web entry](https://radiooooo.com/). | Geographic/era exploration rather than similarity between selected songs. Good steering precedent, but importing its global catalog or curation is out of scope. |
| **Musicmap.info — adjacent educational atlas** | Web; public content, definitive current price **unverified**. | Genre learners; genealogy, influence links, historical context and example-song playlists. [Official explanation](https://musicmap.info/). | A researched genre taxonomy rather than individually seeded song discovery. TuneGraph can make tags actionable without undertaking genre genealogy or copying editorial content. |
| **Discogs — adjacent collecting/discovery** | Web; verified free iOS app. Record purchases cost extra; other platform availability not independently checked here. | Record collectors; catalog, collection management, hidden-record discovery, pricing and marketplace. [Official app listing](https://apps.apple.com/us/app/discogs/id1036449551?platform=watch). | Collection/release focus rather than an immediately expandable song graph. Account-backed collecting is heavier than a local discovery shortlist. |
| **FilterMyDiscogs — additional adjacent competitor** | Web, explicitly free; Discogs connection for personal collection, public crates viewable without signin. | Collectors/DJs; collection search/filter, previews, track queues, reorderable crates and public sharing. [Official product page](https://www.filtermydisco.gs/). | Designed around records already owned and a Discogs connection. TuneGraph can adopt lightweight keeping/sharing without adding that dependency. |
| **Rate Your Music / Sonemic — adjacent** | Web; public discovery plus subscriptions; current subscription amount **unverified**. | Album enthusiasts; community discovery and configurable charts using genres, descriptors, languages, labels and popularity; diverse charts avoid repeated artists. [Official Sonemic overview](https://sonemic.com/). | Chart/list-centered discovery versus immediate graph traversal. Comparable song-journey graph **unverified**. Subscription price and current per-tier boundaries were not verified; the official overview may lag current releases. |
| **Bandcamp Discover — additional adjacent competitor** | Web; public discovery, music purchases priced per release; app availability/current paid fan offerings not verified here. | Independent-music fans; combinable genre/location tags and direct artist support. [Discover announcement](https://blog.bandcamp.com/2024/04/25/new-in-discover-search-and-filter-by-combining-tags/), [artist guide](https://bandcamp.com/guide?from=artistmenu). | Discovery stays within Bandcamp's artist catalog. TuneGraph can borrow tag steering while keeping its existing providers and outbound listening choices. |

## Feature Matrix

**Y** = documented capability; **P** = partial/adjacent equivalent; **U** = unverified, not a claim of absence; **No** is used only for TuneGraph capabilities checked in source. “Keep” includes playlists, collections or saved maps; it does not imply graph persistence. “Steer” means an explicit user control affecting discovery beyond picking a new seed. Rows inherit citations from the competitor table.

| Product | Artist seed | Song seed | Relationship map | Preview/listening | Tags/genre discovery | Explicit steering | Keep discoveries | Share/export | Multi-input context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **TuneGraph today** | Y | Y | Y: both modes | Y: optional previews | P: labels/explanations | P: pruning only | No: taste ≠ shortlist | No | P: taste check only |
| Music-Map / Gnoosic | Y | U | Y: artists | U | U | P: seeds | U | U | Y: three bands |
| Musicroamer | Y | U | Y: artists | Y: previews | U | U | Y: maps/account | U | U |
| Liveplasma | Y | U | Y: artists | U | U | U | U | U | U |
| Chosic | Y | Y | Y: artists | Y: previews | Y | Y: seed/category | Y: Spotify playlist | Y: Spotify save | P: playlist input |
| Every Noise | P: artist lookup | U | Y: genre/artist space | P: documented samples; current U | Y | Y: genre choice | P: playlist links | P: playlist links | U |
| Spotify | Y | Y | U | Y | Y | P: seed/profile | Y | Y | P: personalization |
| Pandora | Y | Y | U | Y | Y | Y: thumbs/modes | Y: stations/playlists | Y: Premium playlists | Y: seeds/feedback |
| Last.fm | Y | Y | U | P: integrations | Y | P: listening profile | Y: library | U | Y: history |
| Radiooooo | U | U | P: geography | Y | P: country/era | Y: country/decade | P: saved tracks reported | U | U |
| Musicmap.info | U | U | Y: genealogy | P: example playlists | Y | Y: genres | U | P: playlists | U |
| Discogs | P: catalog search | U | U | U | P: catalog | P: catalog discovery | Y: collection | U | U |
| FilterMyDiscogs | P: collection search | P: tracklists | U | Y: previews | Y: filters | Y: filters | Y: crates | Y: public crates | P: collection |
| RYM / Sonemic | P: catalog | P: song charts | U | U | Y | Y: chart controls | Y: charts/bookmarks | P: chart URLs | P: combined filters |
| Bandcamp Discover | P: artist catalog | P: release tracks | U | Y: catalog listening | Y | Y: combined tags | P: purchased collection | U | Y: combined tags |

No researched competitor was verified to implement **TuneGraph's exact whole-trail song re-ranking**. Multi-input features are precedents for the problem, not proof of that algorithm. Likewise, a consumer product using musical attributes does not establish access to its acoustic features or preview-analysis rights.

## Gap Analysis

Verification used `rg --files`, `rg -n` across **all of `frontend/src` and `backend/app`**, and direct reads of matching components, graph state, routes, models, provider adapters, requirements and deployment settings. Useful search terms included `localStorage|sessionStorage|bookmark|favorite|download|export|URLSearchParams|queue|onEnded|filter|tag|similarity|cosine|candidate`. Negative searches were checked against the actual call paths below, not treated alone as proof.

| Gap / recommendation | Verified source evidence | Existing behavior that must not be misrepresented |
| --- | --- | --- |
| G1: Keep individual discoveries (#1) | `frontend/src/App.tsx:15–25,138–156` persists only taste; `types.ts` has graph and taste models, no saved-discovery collection. Full panel controls contain no bookmark action. | Manual liked artists/tracks already persist. The gap is canonical-ID bookmarks and a reopenable shortlist, not “no favorites data.” |
| G2: Resume graph (#2) | `graph/useMusicGraph.ts:25,167–178,234` initializes an empty in-memory reducer. No serialization/rehydration action. App's brand reloads at line 185. | Journey breadcrumbs and one-step prune undo already exist, but disappear on reload. |
| G3: Whole-trail ranking (#3) | `App.tsx:54` sends only ID/limit. `api/routes/tracks.py:get_similar` accepts no trail. `services/similarity.py:rerank_similar_tracks` compares seed tags to each candidate. `lastfm.py:504–543` slices to limit before re-ranking. | Tag cosine, 60/40 collaborative/content blending, fail-soft tags and shared-tag explanations already exist. |
| G4: Durable negative feedback (#4) | `TasteProfile.disliked` exists; `TasteCheck`/taste route consume preferences. Neither `/tracks/.../similar` nor the graph expansion call consumes dislikes or excluded IDs. Prune removes current nodes only. | Dislike text and branch removal exist. What is missing is explicit exact-song exclusion from future expansions. |
| G5: Steer by tags (#5) | `ArtistPanel.tsx:322–331,499–508` renders tags as text list items. Similar route accepts ID/limit only; blend has fixed weight. | Tags already influence ranking automatically; user-selectable emphasis is absent. Artist fallback tags in `lastfm.py:433–455` are not necessarily song-level evidence. |
| G6: Diverse song artists (#6) | `lastfm.py:504–543` deduplicates song IDs, not performing artists. `similarity.py` sorts by score only. | Duplicate-song removal exists; limiting repeated performers is a different capability. |
| G7: Share a seed (#7) | `App.tsx` has no graph URL initialization/share action. The `URLSearchParams` and history use in `spotifyImport.ts` handles OAuth only. | Spotify callback URLs are not discovery links. External listening links already exist. |
| G8: Portable journey list (#8) | `JourneyTrail.tsx` offers jump/collapse; `MusicGraph.journey` holds expanded-node IDs. No clipboard/download/export workflow in source. | A breadcrumb already exists; export should reuse it rather than introduce a second history model. |
| G9: Artist top track → song map (#9) | `ArtistPanel.tsx:524–572` top tracks are preview rows. Only the reverse bridge, song → artist map, exists at line 249. `Track` rows lack canonical track IDs. | Artist and song search modes already exist; this is a contextual shortcut between them. |
| G10: List alternative to moving graph (#10) | App renders `ForceGraph` and the expanded-stop `JourneyTrail`; no list of all graph nodes. ForceGraph already has tab-focusable nodes, Enter/Space selection, Shift+Enter expansion and zoom/fit. | Keyboard support is present. Gap is a stable, searchable/list-like overview of all currently discovered nodes, especially leaves. |
| G11: Preview-derived acoustic signal (#11) | `preview.py` and `apple_music.py` resolve preview URLs; they do not decode audio. `similarity.py` uses tags only. `requirements.txt` contains no librosa/Essentia or decoding stack. `vercel.json` sets `maxDuration: 30`. | Audio playback and content-based tag re-ranking exist; true acoustic extraction does not. |

**Do not file as missing:** artist/song search; preview fallback; Spotify/Apple/YouTube links; song release-date lookup; branch collapse/remove; prune undo; journey jump; zoom/fit; basic keyboard navigation; local taste entry; Spotify top-music import; on-demand taste estimate; edge similarity styling/shared-tag tooltip. These are implemented.

**Demand confidence:** saving and steering have clear competitor precedents. A [Radiooooo review](https://apps.apple.com/us/app/radiooooo/id893151807) requests better saved-track organization; a [song-discovery discussion](https://www.reddit.com/r/MusicRecommendations/comments/1efh2as/is_there_a_better_way_to_find_similar_songs/) asks for closer musical matches. These are qualitative anecdotes, not evidence of TuneGraph demand prevalence. Persistence and contextual navigation are code-grounded friction hypotheses to validate with users.

## Recommended Features

Scope estimates: **S** ≈ 1–2 engineering days; **M** ≈ 3–5; **L** ≈ 6–10, including focused validation, assuming familiarity with the app. These are estimates, not delivery promises. All new paths must preserve artist ranking and existing branch/undo semantics. New filenames below are proposed. No additional credentials are required for #1–10.

### 1. Local discovery bookmarks — P1 / M / v1

- **Problem:** A listener finds a useful song or artist but has nowhere to keep it without manually editing taste notes or leaving the app.
- **Precedent:** Musicroamer saves maps; Discogs/FilterMyDiscogs keep collections/crates; Spotify keeps music. Bookmarking individual nodes is TuneGraph's smaller adaptation.
- **Behavior / PR boundary:** Add Save/Unsave to both panels and a compact Saved drawer. Store up to 200 records with version, kind, canonical ID, label and artist reference in local storage. Reopen as the correct root mode. Keep bookmarks separate from taste preferences: saving is not automatically a positive training signal. Provide clear-all and a storage-failure notice. No folders, sync or playlist playback.
- **Likely files:** `frontend/src/App.tsx`, `components/ArtistPanel.tsx`, `types.ts`, `index.css`; new `savedDiscoveries.ts`, `components/SavedDiscoveries.tsx`.
- **Acceptance:** Artist/song bookmarks survive refresh, cannot duplicate by ID, can be removed, and reopen correctly; corrupt or unavailable storage does not break discovery.

### 2. Resume the last map locally — P1 / M / v1

- **Problem:** Reloading or returning later discards the exploration even though the taste profile survives.
- **Precedent:** Musicroamer's saved maps. Scope down to one local snapshot, not a map library.
- **Behavior / PR boundary:** Persist one bounded, versioned snapshot of nodes, edges, root, selection, focus and journey. Offer Resume / Start fresh on entry. Deserialize Maps explicitly; clear loading/error/undo state and reject invalid or oversized snapshots. Restore topology without replaying provider requests; refresh details only when selected. Preserve the existing Start over intent by clearing the snapshot before resetting. No coordinates, screenshot, named saves or cross-device sync.
- **Likely files:** `frontend/src/graph/useMusicGraph.ts`, `App.tsx`, `types.ts`; new `graph/graphStorage.ts`.
- **Acceptance:** Reload after expansion/pruning resumes the same topology and journey; no dangling edges, spurious loading state or mass API replay; Start fresh stays fresh.

### 3. Whole-trail song re-ranking — P1 / M / v1; owner backlog

- **Problem:** Following several songs can drift away from the accumulated exploration intent because each expansion considers only its parent.
- **Precedent:** Gnoosic's multi-band input and Pandora's seeds/feedback; exact whole-trail implementation in competitors is **unverified**.
- **Behavior / PR boundary:** Add an explicit song-only “Follow journey” toggle, off by default. Send the ordered, unique expanded song IDs plus current seed through a bounded request schema. Use all stops within a documented 50-stop context cap; do not silently reduce this to the latest few songs. Beyond the cap, keep ordinary expansion and disclose why trail mode is unavailable. Form a normalized, recency-weighted aggregate of available tag vectors; blend candidate similarity to that vector with the original Last.fm match. Treat it as session context across explored branches, not as a false single ancestry path. Keep the existing pairwise score on graph edges and expose a separate ranking score/context label, so edge meaning stays accurate.
- **Candidate selection:** Fetch at most 20 Last.fm candidates, score first and choose seven afterward; bounded tag concurrency, cache reuse and a deadline fall back to existing parent ranking. Missing trail tags are unknown, not negative evidence. No MusicBrainz enrichment or acoustic calls in this path. Toggle-off behavior remains unchanged.
- **Likely files:** `frontend/src/App.tsx`, `api.ts`, `types.ts`; `backend/app/api/routes/tracks.py`, `models/track.py`, `services/similarity.py`, `services/lastfm.py`, `services/mock.py`; `backend/tests/test_similarity.py`, `test_api.py`.
- **Acceptance:** A fixture where a candidate outside the initial seven fits several trail stops must change membership, not just order. Single-stop, missing-tag, timeout and toggle-off cases behave predictably; artist responses remain identical.

### 4. “Don't suggest this song” across future expansions — P1 / M / v1

- **Problem:** Removing a branch tidies the map but does not prevent an unwanted song returning later.
- **Precedent:** Pandora thumbs affect station recommendations. This PR uses transparent exact-ID exclusion, not inferred dislike modeling.
- **Behavior / PR boundary:** Song-panel action adds the song to a bounded local exclusion set. Exclude it from future song expansions before selecting the final seven; overfetch a bounded pool to refill. Show undo and a small exclusions list with reset. Keep current graph topology intact; existing Remove remains the branch-edit action. Do not parse free-form taste dislikes into guessed artist/song IDs, and do not alter artist mode.
- **Likely files:** `frontend/src/App.tsx`, `components/ArtistPanel.tsx`, `api.ts`; new `songExclusions.ts`; `backend/app/api/routes/tracks.py`, `models/track.py`, `services/lastfm.py`; API fixtures/tests.
- **Acceptance:** An excluded ID never returns in later expansions or after reload, while undo restores eligibility. Exhausted candidates yield fewer results with an explanation, not an unbounded fetch loop.

### 5. Tag steering for the next song expansion — P2 / M / v1

- **Problem:** Seeing “trip-hop” or “ambient” explains a connection but gives no way to request more of that aspect.
- **Precedent:** Bandcamp's combined tags; Chosic's genre/mood inputs; RYM's descriptor filters.
- **Behavior / PR boundary:** Let a listener emphasize up to three displayed tags for the next song expansion. Soft-boost candidates with those tags within at most 20 existing Last.fm candidates, then choose seven. Display active chips and clear action. Missing tags do not exclude songs; show when no candidates match. The control affects only the next expansion, resets afterward, and does not pretend to search a complete genre catalog. Keep shared-tag edge explanations separate from user steering.
- **Likely files:** `frontend/src/components/ArtistPanel.tsx`, `App.tsx`, `api.ts`, `types.ts`, `index.css`; `backend/app/api/routes/tracks.py`, `services/similarity.py`, `models/track.py`; similarity/API tests.
- **Acceptance:** Fixtures show matching candidates promoted; empty tag data remains usable; no artist endpoint or algorithm changes. Avoid describing artist-fallback tags as acoustically measured properties.

### 6. Diverse performers in song expansions — P2 / S–M / v1

- **Problem:** Seven related songs can still expose very few new artists.
- **Precedent:** RYM/Sonemic documents diverse charts with one appearance per artist; Pandora Discovery is an adjacent novelty control, not the same algorithm.
- **Behavior / PR boundary:** Add a song-only “More artists” toggle. Within a bounded 20-candidate pool, select the highest-ranked song per normalized artist identity before adding second songs; cap at two per artist. Prefer fewer than seven to violating the cap, with explanatory text. Use existing IDs and normalized names—no identity calls to MusicBrainz. Default off to preserve existing behavior.
- **Likely files:** `frontend/src/App.tsx`, `api.ts`; `backend/app/services/similarity.py`, `api/routes/tracks.py`, `models/track.py`; similarity/API tests.
- **Acceptance:** Stable ranking on ties, explicit fewer-results behavior, no duplicate songs, and an unchanged default/artist path. Can ship independently by reusing or introducing the bounded pool helper.

### 7. Share a selected artist or song as a map seed — P2 / S

- **Problem:** A listener cannot send another person directly to the discovery they are looking at.
- **Precedent:** Chosic's track query URLs and FilterMyDiscogs' public links; TuneGraph's scope is a seed, not a server-hosted shared crate.
- **Behavior / PR boundary:** Copy a versioned root-page fragment containing only kind and canonical ID. Opening it resolves the seed and starts a fresh map in the matching mode; explicit shared seed takes precedence over local Resume. Label “Share this song/artist,” not “Share this exact map.” Validate length/type and show a useful missing-seed error. Exclude taste, tokens, preview URLs and other local state.
- **Likely files:** `frontend/src/App.tsx`, `components/ArtistPanel.tsx`, `api.ts`; new `shareSeed.ts`. Existing root route avoids a new hosting rewrite.
- **Acceptance:** Round-trip IDs with spaces, Unicode and delimiter characters; malformed fragments do not crash; OAuth callback remains unaffected.

### 8. Export the song journey as a text list — P2 / S

- **Problem:** Useful discoveries cannot leave TuneGraph together for later listening or manual playlist assembly.
- **Precedent:** Chosic's Spotify saving and FilterMyDiscogs' shared crates. Plain-text portability is a smaller provider-independent implementation.
- **Behavior / PR boundary:** Song-mode “Copy journey” exports the currently expanded stops in trail order as artist — title plus an existing/fallback listening URL. Add text-file download fallback if clipboard fails. Describe it as an exploration list, not a playable playlist or an exact path through every graph edge. No Spotify write scopes, graph-wide selection UI or audio downloading.
- **Likely files:** `frontend/src/components/JourneyTrail.tsx`, `App.tsx`; new `exportJourney.ts` using existing identities/link conventions.
- **Acceptance:** Correct Unicode/order, no removed stops or duplicates, graceful clipboard fallback, and no provider request per exported row.

### 9. Open a song map from an artist's top-track row — P2 / S–M

- **Problem:** Listeners hearing an artist preview must retype the track in Song search to explore its neighbors.
- **Precedent:** Spotify offers song-seeded Radio; Chosic accepts song seeds. This is TuneGraph's contextual entry point to an existing capability.
- **Behavior / PR boundary:** Add a separate Explore song action beside each top track. Return canonical `TrackRef` identity from the existing top-tracks backend response using its current normalization, then reuse `onSelectTrack`. Do not construct potentially inconsistent IDs in the UI. Start a fresh song-only graph; leave preview and ordinary artist expansion unchanged.
- **Likely files:** `frontend/src/components/ArtistPanel.tsx`, `App.tsx`, `types.ts`; `backend/app/models/track.py`, `services/lastfm.py`, `services/mock.py`; top-track response tests.
- **Acceptance:** Same-name songs by different artists select correctly; preview button behavior remains unchanged; the new graph contains only songs. Does not depend on bookmarks or persistence.

### 10. Stable list view of the current graph — P2 / M

- **Problem:** Moving spatial nodes are awkward when a listener wants to scan names, reach a leaf reliably, or use a narrow screen.
- **Precedent:** Every Noise's list mode and FilterMyDiscogs' table/grid views; an App Store Radiooooo review also requests a country-list alternative, an anecdotal navigation signal.
- **Behavior / PR boundary:** Add a Graph / List toggle over the same in-memory nodes. List discovery order, title/artist and expanded status; row selection opens the existing panel. Reuse its Expand/Remove actions rather than building another graph engine. Keep selection synchronized and retain graph state when switching. No new sorting algorithms or network calls.
- **Likely files:** `frontend/src/App.tsx`, `index.css`; new `components/DiscoveryList.tsx`.
- **Acceptance:** All nodes including leaves are reachable by keyboard; switching views preserves selection, pruning and journey. This augments existing keyboard access rather than claiming to introduce it.

### 11. Acoustic preview features: bounded feasibility prototype — P3 / M prototype; production L+ / owner backlog

- **Problem:** Artist-derived tags and co-listening may miss a song's rhythm/timbre, especially when tags are sparse.
- **Precedent:** Pandora's musical-attribute positioning is the conceptual precedent supplied in the brief; **equivalent Apple-preview extraction by competitors is unverified**, and Pandora data is not available.
- **Code gap:** URL resolution and tag vectors exist, but there is no audio fetch/decode/feature pipeline, acoustic model, dependency stack or calibration data.
- **Single-PR deliverable:** An isolated offline Python evaluation harness with synthetic/licensed local 30-second fixtures, extracting a small fixed vector (e.g. RMS, spectral centroid, onset statistics) using librosa; compare acoustic distances and an experimental blend with the current tag baseline. Keep the dependency in an optional development group and out of deployed requirements. Report cold/warm extraction time, peak memory, codec support and prospective bundle size. This is an implementable investigation PR, **not a claim that production preview augmentation is already feasible**.
- **Conditional Apple experiment:** Use the existing Apple catalog account only if its applicable terms permit automated analysis. That permission is **unverified** here; do not infer it from having a playable URL. Without verification, the harness still ships using licensed fixtures, and the Apple-specific candidate remains deferred. No new account or persistent audio store is proposed.
- **Why outside v1:** The checkout's Vercel function has a 30-second maximum; cold imports, downloading and decoding a seed plus 20 candidates compete with existing provider calls. Vercel documents a 500 MB uncompressed Python bundle limit; audio/scientific dependencies and codec packaging must be measured, not assumed to fit. Per-instance TTL caches vanish at cold start and cannot guarantee low latency. [Vercel Python runtime](https://vercel.com/docs/functions/runtimes/python), [limits](https://vercel.com/docs/functions/limitations), [librosa installation](https://librosa.org/doc/latest/install.html).
- **Likely files for prototype:** new `backend/experiments/acoustic_similarity.py`, licensed/synthetic fixtures and evaluation notes; optional dependency group in `backend/pyproject.toml`. A later production PR would touch `services/preview.py`, new `services/acoustic.py`, `services/similarity.py`, `models/track.py` and deployment dependencies, but is explicitly not bundled into the prototype.
- **Exit decision:** Demonstrate useful comparisons on diverse fixtures and missing/failed audio; distinguish clip-level descriptors from full-song attributes. Do not enable user-facing ranking without verified permissions, measured deployment fit and convincing relevance evidence. Essentia is an alternative to evaluate later, not a second stack to bundle in this PR.

### Delivery constraints and exclusions

For the six-PR v1 sequence, implement ranking operations in one consistent order: bounded candidate retrieval → explicit exclusions → baseline or trail/tag scoring → optional artist diversity → seven displayed results. Each PR needs a default-preserving path and fixture coverage for its specific behavior, with existing backend tests guarding artist mode. Reuse request schemas/helpers as later PRs land; do not turn any single ticket into a generic recommendation framework.

Keep MusicBrainz release-date lookup on the existing selected-song slow path. None of these ranking ideas should make per-candidate MusicBrainz calls: the roughly one-request-per-second constraint and per-instance throttle already described in README make that unsuitable.

Excluded from this milestone: Spotify recommendations/audio-features endpoints; Pandora genome acquisition; accounts/profile database; full-track streaming; automatic Spotify playlist writes; world/decade catalogs; full genre genealogy; trained embeddings; distributed background workers. Spotify's November 2024 announcement explicitly restricts new access to recommendations and audio features. [Official API change](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api?trk=public_post_comment-text). Provider access is not interchangeable with a competitor having an integration.

No issues were created, no source code was changed, and no commit was made for this research.

## Sources

All web sources were queried on 2026-10-10; some results are indexed snapshots. Primary product pages establish advertised functionality, not runtime verification. The links above are placed beside their claims; this index makes the research reusable.

1. Music-Map: https://www.music-map.com/?trk=public_post-text
2. Gnoosic multi-band input: https://www.gnoosic.com/faves.php
3. Musicroamer: https://www.musicroamer.com/ — old crawl; current operation unverified.
4. Liveplasma: https://www.liveplasma.com/index.php
5. Chosic artist map: https://www.chosic.com/music-artists-map/
6. Chosic generator: https://www.chosic.com/playlist-generator/ — indexed text; direct 403.
7. Chosic preview/save documentation: https://www.chosic.com/playlist-generator/?track=1jgTiNob5cVyXeJ3WgX5bL
8. Every Noise creator-hosted index: https://www.furia.com/everynoise_public/ — indexed text; direct 403.
9. Every Noise list example: https://www.furia.com/everynoise_public/everynoise1d-bigroom.html
10. Every Noise background, secondary source: https://en.wikipedia.org/wiki/Every_Noise_at_Once
11. Spotify Radio: https://support.spotify.com/sb/article/spotify-radio/
12. Spotify plans and devices: https://www.spotify.com/us/premium/
13. Pandora subscription FAQ: https://help.pandora.com/s/article/000001089
14. Pandora station controls: https://help.pandora.com/s/article/Tips-to-improve-stations-1519949305949?language=en_US
15. Pandora modes: https://help.pandora.com/s/article/Pandora-Modes?language=en%5C_US
16. Pandora playlist capability: https://www.pandora.com/premiumsignup1/
17. Last.fm tracking: https://www.last.fm/about/trackmymusic?showplatform=Windows
18. Last.fm Pro: https://www.last.fm/pro
19. Last.fm recommendation background, historical: https://blog.last.fm/2013/06/24/welcome-to-your-new-home
20. Radiooooo web entry: https://radiooooo.com/
21. Radiooooo official app listing, prices, versions and user reviews: https://apps.apple.com/us/app/radiooooo/id893151807
22. Musicmap.info official explanation: https://musicmap.info/
23. Discogs official app listing: https://apps.apple.com/us/app/discogs/id1036449551?platform=watch
24. FilterMyDiscogs: https://www.filtermydisco.gs/
25. RYM/Sonemic official overview: https://sonemic.com/ — current tier details unverified.
26. Bandcamp combined tags: https://blog.bandcamp.com/2024/04/25/new-in-discover-search-and-filter-by-combining-tags/
27. Bandcamp artist guide: https://bandcamp.com/guide?from=artistmenu
28. Qualitative song-similarity discussion: https://www.reddit.com/r/MusicRecommendations/comments/1efh2as/is_there_a_better_way_to_find_similar_songs/
29. Spotify API restriction: https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api?trk=public_post_comment-text
30. Vercel Python runtime: https://vercel.com/docs/functions/runtimes/python
31. Vercel function limits: https://vercel.com/docs/functions/limitations
32. librosa installation: https://librosa.org/doc/latest/install.html
33. Attempted backlog verification: https://github.com/Mhinolv/MusicMap/issues — retrieval failed.

Local primary evidence: `README.md`, `Product_MVP.md`, all files under `frontend/src` and `backend/app` inventoried/searched, with direct inspection of `App.tsx`, `types.ts`, `ArtistPanel.tsx`, `ForceGraph.tsx`, `JourneyTrail.tsx`, `graph/useMusicGraph.ts`, `api/routes/tracks.py`, `models/track.py`, `services/similarity.py`, `services/lastfm.py`, `services/preview.py`, `services/apple_music.py`, plus `vercel.json`, `requirements.txt` and the existing test inventory. Line references describe this checkout and may move after implementation.
