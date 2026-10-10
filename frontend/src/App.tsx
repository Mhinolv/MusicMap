import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { ArtistPanel } from './components/ArtistPanel'
import { ForceGraph } from './components/ForceGraph'
import { JourneyTrail } from './components/JourneyTrail'
import { SearchBar, type SearchMode } from './components/SearchBar'
import { SavedDiscoveries } from './components/SavedDiscoveries'
import { addBookmark, bookmarkKey, BOOKMARK_FULL_MESSAGE, nodeBookmark, readBookmarks, restoreBookmarks, writeBookmarks, type Bookmark } from './bookmarks'
import { TastePreferences } from './components/TastePreferences'
import { emptyTaste, isEmptyTaste, readTaste, writeTaste, toggleTaste, TASTE_LIMIT, type TasteList } from './taste'
import { TasteToggle } from './components/TasteToggle'
import { finishSpotifyImport } from './spotifyImport'
import { artistNode, planPrune, trackNode, useMusicGraph, type ExpandedChild } from './graph/useMusicGraph'
import { JOURNEY_CAP, journeyContext } from './graph/journey'
import type { ArtistRef, PruneMode, TasteProfile, TrackRankingContext, TrackRef } from './types'
import { addExclusion, EXCLUSION_FULL_MESSAGE, readExclusions, restoreExclusions, writeExclusions, type ExcludedSong } from './exclusions'

import { clearMap, readMap, saveMap } from './graph/mapSnapshot'

const EXPAND_LIMIT = 7

type Toast = { source?: 'bookmarks' | 'exclusions' | 'taste'; msg: string; action?: { label: string; run: () => void } }
export default function App() {
  const g = useMusicGraph()
  const [savedMap, setSavedMap] = useState(readMap)
  const warnedMapSize = useRef(false)
  const persistenceStopped = useRef(false)
  const [resumeFit, setResumeFit] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const [followJourney, setFollowJourney] = useState(false)
  const [steering, setSteering] = useState<{ id: string; tags: string[] } | null>(null)
  const steeringRef = useRef(steering)
  const updateSteering = useCallback((next: typeof steering) => {
    steeringRef.current = next
    setSteering(next)
  }, [])
  const selectNode = g.select
  const selectionId = g.graph.selectedNodeId
  const select = useCallback((id?: string) => {
    if (id !== selectionId) updateSteering(null)
    selectNode(id)
  }, [selectNode, selectionId, updateSteering])
  // Pruning and reset can change selection without going through select().
  useEffect(() => {
    if (steeringRef.current?.id !== g.graph.selectedNodeId) {
      steeringRef.current = null
      setSteering(null)
    }
  }, [g.graph.selectedNodeId])
  const mapEpoch = useRef(0)
  const [toast, setToast] = useState<Toast | null>(null)
  const [searchMode, setSearchMode] = useState<SearchMode>('artist')
  const [centerRequest, setCenterRequest] = useState<{ id: string; nonce: number }>()
  const [taste, setTaste] = useState<TasteProfile | null>(readTaste)
  const tasteRef = useRef(taste)
  const [tasteOpen, setTasteOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState(readBookmarks)
  const bookmarksRef = useRef(bookmarks)
  const [exclusions, setExclusions] = useState(readExclusions)
  const exclusionsRef = useRef(exclusions)
  const [savedOpen, setSavedOpen] = useState(false)
  const closeSaved = useCallback(() => setSavedOpen(false), [])
  const inflight = useRef(new Set<string>())
  const toastTimer = useRef<number>(0)

  const showToast = useCallback((t: Toast, ms = 4000) => {
    window.clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), ms)
  }, [])

  // Save only reducer changes, never force-simulation ticks. Flush the latest state on exit.
  useEffect(() => {
    if (!g.graph.nodes.size || persistenceStopped.current) return
    const save = () => {
      if (persistenceStopped.current) return
      const result = saveMap(g.graph, followJourney)
      if (result === 'too-large' && !warnedMapSize.current) {
        warnedMapSize.current = true
        showToast({ msg: 'This map is too large to keep for next time.' }, 7000)
      }
    }
    const timer = window.setTimeout(save, 300)
    const flush = () => { if (!persistenceStopped.current) save() }
    window.addEventListener('pagehide', flush)
    return () => { window.clearTimeout(timer); window.removeEventListener('pagehide', flush) }
  }, [g.graph, followJourney, showToast])

  const startFresh = () => { clearMap(); setSavedMap({ status: 'none' }) }
  const resume = () => {
    if (savedMap.status !== 'ready') return
    pendingRoot.current = null
    mapEpoch.current += 1
    inflight.current.clear()
    g.restore(savedMap.snapshot.graph)
    setFollowJourney(savedMap.snapshot.followJourney)
    setSearchMode(savedMap.snapshot.graph.nodes.get(savedMap.snapshot.graph.rootId!)?.kind === 'track' ? 'song' : 'artist')
    setSavedMap({ status: 'none' })
    setResumeFit(true)
    setResetKey((k) => k + 1)
    showToast({ msg: 'Map restored.' }, 4000)
  }

  const updateBookmarks = (next: Bookmark[]) => {
    if (!writeBookmarks(next)) {
      showToast({ source: 'bookmarks', msg: "Couldn't save: this browser is blocking local storage." }, 7000)
      return false
    }
    bookmarksRef.current = next
    setBookmarks(next)
    return true
  }
  const removeBookmarks = (removed: Bookmark[]) => {
    const keys = new Set(removed.map(bookmarkKey))
    const next = bookmarksRef.current.filter((entry) => !keys.has(bookmarkKey(entry)))
    if (!updateBookmarks(next)) return
    showToast({ source: 'bookmarks', msg: removed.length === 1 ? `Removed “${removed[0].item.name}” from saved.` : `Cleared ${removed.length} saved discoveries.`, action: { label: 'Undo', run: () => {
      const restored = restoreBookmarks(bookmarksRef.current, removed)
      if (restored === bookmarksRef.current) showToast({ source: 'bookmarks', msg: BOOKMARK_FULL_MESSAGE }, 7000)
      else updateBookmarks(restored)
    } } }, 7000)
  }

  const updateExclusions = (next: ExcludedSong[]) => {
    if (!writeExclusions(next)) {
      showToast({ source: 'exclusions', msg: "Couldn't save: this browser is blocking local storage." }, 7000)
      return false
    }
    exclusionsRef.current = next
    setExclusions(next)
    return true
  }
  const restoreExcluded = (removed: ExcludedSong[]) => {
    const next = restoreExclusions(exclusionsRef.current, removed)
    if (next === exclusionsRef.current) showToast({ source: 'exclusions', msg: EXCLUSION_FULL_MESSAGE }, 7000)
    else updateExclusions(next)
  }
  const removeExclusions = (removed: ExcludedSong[]) => {
    const ids = new Set(removed.map((entry) => entry.item.id))
    if (!updateExclusions(exclusionsRef.current.filter((entry) => !ids.has(entry.item.id)))) return
    showToast({ source: 'exclusions', msg: removed.length === 1 ? `Will suggest “${removed[0].item.name}” again.` : 'Reset not suggested songs.',
      action: { label: 'Undo', run: () => restoreExcluded(removed) } }, 7000)
  }

  const expand = useCallback(
    async (id: string) => {
      if (inflight.current.has(id)) return
      const node = g.graph.nodes.get(id)
      if (!node || node.expanded) return
      const emphasis = steeringRef.current?.id === id ? steeringRef.current : null
      const epoch = mapEpoch.current
      inflight.current.add(id)
      g.expandStart(id)
      try {
        // Song maps stay song-to-song; artist maps stay artist-to-artist.
        let children: ExpandedChild[]
        let ranking: TrackRankingContext | undefined
        if (node.kind === 'track') {
          const trail = followJourney ? journeyContext(g.graph.journey, g.graph.nodes, id) : undefined
          const overCap = !!trail && trail.length > JOURNEY_CAP
          const result = await api.trackSimilar(id, EXPAND_LIMIT, undefined, overCap ? undefined : trail, exclusionsRef.current.map((entry) => entry.item.id), emphasis?.tags)
          if (epoch !== mapEpoch.current) return
          ranking = overCap ? { mode: 'parent', stop_count: trail.length, fallback_reason: 'cap_exceeded' } : result.ranking
          // Honor exclusions changed while the request was in flight, too.
          const excludedIds = new Set(exclusionsRef.current.map((entry) => entry.item.id))
          const tracks = result.tracks.filter((track) => !excludedIds.has(track.id))
          children = tracks.map((t) => ({
            node: trackNode(t, id),
            similarity: t.similarity ?? undefined,
            sharedTags: t.shared_tags?.length ? t.shared_tags : undefined,
          }))
          if (result.ranking.steering_matched === false && emphasis?.tags.length) {
            showToast({ msg: `No new songs matched ${emphasis.tags.join(', ')}; showing the closest matches.` }, 7000)
          } else if (children.length < EXPAND_LIMIT && (result.excluded_count > 0 || tracks.length < result.tracks.length)) {
            showToast({ msg: children.length ? `Only ${children.length} connections remain after not suggested songs were excluded.` : 'No connections remain after not suggested songs were excluded. Manage them in Saved → Not suggested.' }, 7000)
          } else if (!children.length) showToast({ msg: `No known connections for ${node.name}.` })
          else if (ranking.fallback_reason) showToast({ msg: ranking.fallback_reason === 'cap_exceeded'
            ? 'Journey is over 50 stops, so this expansion used only this song.'
            : "Couldn't follow the whole journey this time; ranked by this song." })
        } else {
          children = (await api.similar(id, EXPAND_LIMIT)).map((a) => ({ node: artistNode(a, id), similarity: a.similarity ?? undefined }))
        }
        if (epoch !== mapEpoch.current) return
        g.expandSuccess(id, children, ranking)
        if (steeringRef.current === emphasis) {
          steeringRef.current = null
          setSteering(null)
        }
        if (children.length === 0 && node.kind !== 'track') showToast({ msg: `No known connections for ${node.name}.` })
      } catch (err) {
        const msg =
          err instanceof ApiError && err.status === 429
            ? 'Rate limited. Try again in a moment.'
            : "Couldn't load more connections."
        if (epoch === mapEpoch.current) g.expandFailure(id, msg)
      } finally {
        if (epoch === mapEpoch.current) inflight.current.delete(id)
      }
    },
    // g.graph changes every render; we only need the stable callbacks + current nodes map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g.graph.nodes, g.graph.journey, followJourney, g.expandStart, g.expandSuccess, g.expandFailure, showToast],
  )

  // After a reset, expand the root once it exists in state.
  const pendingRoot = useRef<string | null>(null)
  const onSelectSearch = (artist: ArtistRef) => {
    updateSteering(null)
    startFresh()
    setResumeFit(false)
    mapEpoch.current += 1
    setFollowJourney(false)
    pendingRoot.current = artist.id
    inflight.current.clear()
    g.resetArtist(artist)
    setResetKey((k) => k + 1)
  }
  const onSelectTrack = (track: TrackRef) => {
    updateSteering(null)
    startFresh()
    setResumeFit(false)
    mapEpoch.current += 1
    setFollowJourney(false)
    pendingRoot.current = track.id
    inflight.current.clear()
    g.resetTrack(track)
    setResetKey((k) => k + 1)
  }
  useEffect(() => {
    const id = pendingRoot.current
    if (id && g.graph.rootId === id && g.graph.nodes.get(id) && !g.graph.nodes.get(id)!.expanded) {
      pendingRoot.current = null
      void expand(id)
    }
  }, [g.graph.rootId, g.graph.nodes, expand])

  // ---- pruning: collapse a branch or remove a node, with one-step undo ----------------
  const prune = useCallback((id: string, mode: PruneMode) => g.prune(id, mode), [g])
  const lastUndoSeq = useRef(0)
  useEffect(() => {
    const undo = g.graph.undo
    if (!undo || undo.seq === lastUndoSeq.current) return
    lastUndoSeq.current = undo.seq
    showToast({ msg: undo.summary, action: { label: 'Undo', run: () => g.undo() } }, 7000)
  }, [g.graph.undo, g, showToast])

  const selected = g.graph.selectedNodeId ? g.graph.nodes.get(g.graph.selectedNodeId) : undefined
  const impact = useMemo(() => {
    if (!selected) return { collapse: null, remove: null }
    return {
      collapse: planPrune(g.graph, selected.id, 'collapse')?.removed.length ?? null,
      remove: planPrune(g.graph, selected.id, 'remove')?.removed.length ?? null,
    }
  }, [g.graph, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tasteOpen || savedOpen) return
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape') {
        select(undefined)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selected && selected.id !== g.graph.rootId) {
        e.preventDefault()
        prune(selected.id, 'remove')
      } else if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !typing && g.graph.undo) {
        e.preventDefault()
        g.undo()
        setToast((current) => current?.source ? current : null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [g, selected, prune, tasteOpen, savedOpen, select])

  const updateTaste = (next: TasteProfile | null) => {
    const profile = next && !isEmptyTaste(next) ? next : null
    if (!writeTaste(profile)) {
      showToast({ source: 'taste', msg: "Couldn't save: this browser is blocking local storage." }, 7000)
      return false
    }
    tasteRef.current = profile
    setTaste(profile)
    // An editor change supersedes the previous panel undo.
    setToast((current) => current?.source === 'taste' ? null : current)
    return true
  }
  const saveTaste = (next: TasteProfile) => {
    if (updateTaste(next)) setTasteOpen(false)
  }
  const clearTaste = () => {
    if (updateTaste(null)) setTasteOpen(false)
  }
  const togglePanelTaste = (list: TasteList, entry: string) => {
    const previous = tasteRef.current
    const next = toggleTaste(previous, list, entry)
    if (next === previous) {
      showToast({ source: 'taste', msg: `This taste list is full (${TASTE_LIMIT}). Edit taste to make room.`,
        action: { label: 'Edit taste', run: () => setTasteOpen(true) } }, 7000)
      return
    }
    if (!updateTaste(next)) return
    const added = !!next?.[list].includes(entry)
    showToast({ source: 'taste', msg: `${added ? 'Added' : 'Removed'} “${entry}” ${added ? 'to' : 'from'} ${list === 'disliked' ? 'your dislikes' : 'your taste'}.`,
      action: { label: 'Undo', run: () => {
        if (tasteRef.current === next) updateTaste(previous)
      } } }, 7000)
  }

  useEffect(() => {
    void finishSpotifyImport(readTaste())
      .then((imported) => {
        if (!imported) return
        if (!writeTaste(imported)) {
          showToast({ source: 'taste', msg: "Couldn't save: this browser is blocking local storage." }, 7000)
          return
        }
        tasteRef.current = imported
        setTaste(imported)
        setTasteOpen(true)
        showToast({ msg: 'Spotify music imported. Review and save your preferences.' }, 7000)
      })
      .catch((err) => showToast({ msg: err instanceof Error ? err.message : 'Spotify import failed.' }, 7000))
  }, [showToast])

  const jumpTo = (id: string) => {
    select(id)
    setCenterRequest({ id, nonce: Date.now() })
  }

  const openBookmark = (entry: Bookmark) => {
    setSavedOpen(false)
    setSearchMode(entry.kind === 'track' ? 'song' : 'artist')
    if (entry.kind === 'track') onSelectTrack(entry.item)
    else onSelectSearch(entry.item)
  }
  const selectedBookmark = selected ? nodeBookmark(selected) : null
  const isSaved = !!selectedBookmark && bookmarks.some((entry) => bookmarkKey(entry) === bookmarkKey(selectedBookmark))
  const toggleSave = () => {
    if (!selectedBookmark) return
    const existing = bookmarksRef.current.find((entry) => bookmarkKey(entry) === bookmarkKey(selectedBookmark))
    if (existing) return removeBookmarks([existing])
    const next = addBookmark(bookmarksRef.current, selectedBookmark)
    if (next === bookmarksRef.current) return showToast({ source: 'bookmarks', msg: BOOKMARK_FULL_MESSAGE }, 7000)
    updateBookmarks(next)
  }

  const toggleExclusion = () => {
    if (selectedBookmark?.kind !== 'track') return
    const existing = exclusionsRef.current.find((entry) => entry.item.id === selectedBookmark.item.id)
    if (existing) return removeExclusions([existing])
    const next = addExclusion(exclusionsRef.current, selectedBookmark)
    if (next === exclusionsRef.current) return showToast({ source: 'exclusions', msg: EXCLUSION_FULL_MESSAGE }, 7000)
    if (!updateExclusions(next)) return
    showToast({ source: 'exclusions', msg: `Won't suggest “${selectedBookmark.item.name}” again. It stays on this map.`,
      action: { label: 'Undo', run: () => updateExclusions(exclusionsRef.current.filter((entry) => entry.item.id !== selectedBookmark.item.id)) } }, 7000)
  }

  const hasGraph = g.nodes.length > 0
  const rootKind = g.graph.rootId ? g.graph.nodes.get(g.graph.rootId)?.kind : undefined
  const searchProps = { onSelect: onSelectSearch, onSelectTrack, mode: searchMode, onModeChange: setSearchMode }
  const savedGraph = savedMap.status === 'ready' ? savedMap.snapshot.graph : undefined
  const savedRoot = savedGraph?.nodes.get(savedGraph.rootId!)
  const savedSongMap = savedRoot?.kind === 'track'

  return (
    <div className={`app ${hasGraph ? 'app--graph' : 'app--empty'}`}>
      {!hasGraph ? (
        <main className="hero">
          <h1 className="hero__title">Explore music</h1>
          <p className="hero__sub">Start from an artist or a song, then wander outward through who they're connected to.</p>
          {savedMap.status !== 'none' && (
            <section className="taste-import resume-card" aria-label="Resume last map">
              <div>
                <strong>{savedMap.status === 'ready' ? 'Pick up where you left off' : "Your last map couldn’t be restored"}</strong>
                <p>{savedGraph
                  ? `${savedSongMap ? 'Song' : 'Artist'} map from “${savedRoot?.name}” · ${savedGraph.nodes.size} ${savedSongMap ? 'songs' : 'artists'}${savedGraph.journey.length ? ` · ${savedGraph.journey.length} stops` : ''}`
                  : 'It was damaged or too large to load.'}</p>
              </div>
              <div className="resume-card__actions">
                {savedMap.status === 'ready' && <button className="btn btn--primary" onClick={resume}>Resume</button>}
                <button className="btn btn--ghost" onClick={startFresh}>Start fresh</button>
              </div>
            </section>
          )}
          <SearchBar {...searchProps} autoFocus />
          <button className="taste-entry" onClick={() => setTasteOpen(true)}>{taste ? 'Edit your music taste' : 'Add your music taste'}</button>
          {(bookmarks.length > 0 || exclusions.length > 0) && <button className="link-btn saved-entry" onClick={() => setSavedOpen(true)}>Open saved discoveries ({bookmarks.length})</button>}
          <p className="hero__hint">
            {searchMode === 'song' ? 'Try “Creep”, “Glory Box”, or “Teardrop”.' : 'Try “Radiohead”, “Portishead”, or “Björk”.'}
          </p>
        </main>
      ) : (
        <>
          <header className="topbar">
            <button className="brand" onClick={() => { persistenceStopped.current = true; clearMap(); window.location.reload() }} title="Start over" aria-label="TuneGraph: start over">
              <svg className="brand__mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
                <circle cx="16" cy="16" r="14" fill="#151a2c" />
                <path d="M9 11l4 3M23 20l-4-2" stroke="#6b7286" strokeWidth="1.5" />
                <circle cx="16" cy="16" r="6" fill="#f0b35b" />
                <circle cx="7" cy="9" r="3" fill="#4f7cff" />
                <circle cx="25" cy="22" r="3" fill="#4f7cff" />
              </svg>
              <span className="brand__name">TuneGraph</span>
            </button>
            <SearchBar {...searchProps} compact />
            <button className="taste-entry taste-entry--topbar" onClick={() => setTasteOpen(true)}>{taste ? 'My taste' : 'Add taste'}</button>
            <button className="taste-entry taste-entry--topbar saved-entry" aria-label="Saved discoveries" onClick={() => setSavedOpen(true)}>
              <span className="saved-entry__desktop">{bookmarks.length ? `Saved · ${bookmarks.length}` : 'Saved'}</span>
              <span className="saved-entry__mobile"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2h8v12l-4-3-4 3z" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>{bookmarks.length}</span>
            </button>
            <div className="topbar__stats" aria-live="polite">
              {g.nodes.length} {rootKind === 'track' ? 'songs' : 'artists'} · {g.edges.length} links
            </div>
          </header>
          <div className={`stage ${selected ? 'has-panel' : ''}`}>
            {/* DOM order: the panel comes before the graph so keyboard Tab reaches
                its controls (close, expand, tracks, links) before the graph's
                per-node tab stops. Visual position is set by CSS, not DOM order. */}
            {selected && (
              <ArtistPanel
                node={selected}
                emphasizedTags={steering?.id === selected.id ? steering.tags : []}
                onEmphasizedTags={(tags) => updateSteering(tags.length ? { id: selected.id, tags } : null)}
                excluded={exclusions.some((entry) => entry.item.id === selected.id)}
                onToggleExclusion={toggleExclusion}
                saved={isSaved}
                onToggleSave={toggleSave}
                isRoot={selected.id === g.graph.rootId}
                impact={impact}
                followJourney={followJourney}
                journeyStops={journeyContext(g.graph.journey, g.graph.nodes, selected.id).length}
                onExpand={expand}
                onPrune={prune}
                onClose={() => select(undefined)}
                onTags={g.setTags}
                onOpenArtist={onSelectSearch}
                taste={taste}
                tasteActions={<TasteToggle node={selected} profile={taste} onToggle={togglePanelTaste} />}
                onEditTaste={() => setTasteOpen(true)}
              />
            )}
            <ForceGraph
              nodes={g.nodes}
              edges={g.edges}
              degree={g.degree}
              selectedId={g.graph.selectedNodeId}
              rootId={g.graph.rootId}
              focusId={g.graph.focusId}
              journey={g.graph.journey}
              onSelect={select}
              onExpand={expand}
              resetKey={resetKey}
              fitOnMount={resumeFit}
              centerRequest={centerRequest}
            />
            <JourneyTrail
              songMode={rootKind === 'track'}
              followJourney={followJourney}
              onFollowJourney={() => setFollowJourney((on) => !on)}
              journey={rootKind === 'track' ? g.graph.journey.filter((id) => g.graph.nodes.get(id)?.expanded) : g.graph.journey}
              nodes={g.graph.nodes}
              focusId={g.graph.focusId}
              selectedId={g.graph.selectedNodeId}
              onJump={jumpTo}
              onCollapse={(id) => prune(id, 'collapse')}
            />
            <div className="stage__help stage__help--pointer">
              Click a node to inspect · double-click to expand · Delete removes a branch · scroll or use +/− to zoom
            </div>
            {g.graph.journey.length < 2 && (
              <div className="stage__help stage__help--touch">Tap to inspect · hold to expand · pinch to zoom</div>
            )}
          </div>
        </>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              className="toast__action"
              onClick={() => {
                setToast(null)
                toast.action!.run()
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {savedOpen && <SavedDiscoveries exclusions={exclusions} onRemoveExclusion={(entry) => removeExclusions([entry])} onResetExclusions={() => removeExclusions(exclusionsRef.current)} entries={bookmarks} onOpen={openBookmark} onRemove={(entry) => removeBookmarks([entry])} onClear={() => removeBookmarks(bookmarksRef.current)} onClose={closeSaved} />}
      {tasteOpen && <TastePreferences profile={taste ?? emptyTaste()} onSave={saveTaste} onClear={clearTaste} onClose={() => setTasteOpen(false)} />}
    </div>
  )
}
