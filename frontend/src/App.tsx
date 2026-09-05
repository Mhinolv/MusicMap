import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { ArtistPanel } from './components/ArtistPanel'
import { ForceGraph } from './components/ForceGraph'
import { JourneyTrail } from './components/JourneyTrail'
import { SearchBar, type SearchMode } from './components/SearchBar'
import { artistNode, planPrune, trackNode, useMusicGraph } from './graph/useMusicGraph'
import type { ArtistRef, PruneMode, TrackRef } from './types'

const EXPAND_LIMIT = 7

type Toast = { msg: string; action?: { label: string; run: () => void } }

export default function App() {
  const g = useMusicGraph()
  const [resetKey, setResetKey] = useState(0)
  const [toast, setToast] = useState<Toast | null>(null)
  const [searchMode, setSearchMode] = useState<SearchMode>('artist')
  const [centerRequest, setCenterRequest] = useState<{ id: string; nonce: number }>()
  const inflight = useRef(new Set<string>())
  const toastTimer = useRef<number>(0)

  const showToast = useCallback((t: Toast, ms = 4000) => {
    window.clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), ms)
  }, [])

  const expand = useCallback(
    async (id: string) => {
      if (inflight.current.has(id)) return
      const node = g.graph.nodes.get(id)
      if (!node || node.expanded) return
      inflight.current.add(id)
      g.expandStart(id)
      try {
        // Song maps stay song-to-song; artist maps stay artist-to-artist.
        const children =
          node.kind === 'track'
            ? (await api.trackSimilar(id, EXPAND_LIMIT)).tracks.map((t) => ({
                node: trackNode(t, id),
                similarity: t.similarity ?? undefined,
                sharedTags: t.shared_tags?.length ? t.shared_tags : undefined,
              }))
            : (await api.similar(id, EXPAND_LIMIT)).map((a) => ({ node: artistNode(a, id), similarity: a.similarity ?? undefined }))
        g.expandSuccess(id, children)
        if (children.length === 0) showToast({ msg: `No known connections for ${node.name}.` })
      } catch (err) {
        const msg =
          err instanceof ApiError && err.status === 429
            ? 'Rate limited. Try again in a moment.'
            : "Couldn't load more connections."
        g.expandFailure(id, msg)
      } finally {
        inflight.current.delete(id)
      }
    },
    // g.graph changes every render; we only need the stable callbacks + current nodes map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g.graph.nodes, g.expandStart, g.expandSuccess, g.expandFailure, showToast],
  )

  // After a reset, expand the root once it exists in state.
  const pendingRoot = useRef<string | null>(null)
  const onSelectSearch = (artist: ArtistRef) => {
    pendingRoot.current = artist.id
    inflight.current.clear()
    g.resetArtist(artist)
    setResetKey((k) => k + 1)
  }
  const onSelectTrack = (track: TrackRef) => {
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
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape') {
        g.select(undefined)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selected && selected.id !== g.graph.rootId) {
        e.preventDefault()
        prune(selected.id, 'remove')
      } else if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !typing && g.graph.undo) {
        e.preventDefault()
        g.undo()
        setToast(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [g, selected, prune])

  const jumpTo = (id: string) => {
    g.select(id)
    setCenterRequest({ id, nonce: Date.now() })
  }

  const hasGraph = g.nodes.length > 0
  const rootKind = g.graph.rootId ? g.graph.nodes.get(g.graph.rootId)?.kind : undefined
  const searchProps = { onSelect: onSelectSearch, onSelectTrack, mode: searchMode, onModeChange: setSearchMode }

  return (
    <div className={`app ${hasGraph ? 'app--graph' : 'app--empty'}`}>
      {!hasGraph ? (
        <main className="hero">
          <h1 className="hero__title">Explore music</h1>
          <p className="hero__sub">Start from an artist or a song, then wander outward through who they're connected to.</p>
          <SearchBar {...searchProps} autoFocus />
          <p className="hero__hint">
            {searchMode === 'song' ? 'Try “Creep”, “Glory Box”, or “Teardrop”.' : 'Try “Radiohead”, “Portishead”, or “Björk”.'}
          </p>
        </main>
      ) : (
        <>
          <header className="topbar">
            <button className="brand" onClick={() => window.location.reload()} title="Start over">
              TuneGraph
            </button>
            <SearchBar {...searchProps} compact />
            <div className="topbar__stats" aria-live="polite">
              {g.nodes.length} {rootKind === 'track' ? 'songs' : 'artists'} · {g.edges.length} links
            </div>
          </header>
          <div className="stage">
            {/* DOM order: the panel comes before the graph so keyboard Tab reaches
                its controls (close, expand, tracks, links) before the graph's
                per-node tab stops. Visual position is set by CSS, not DOM order. */}
            {selected && (
              <ArtistPanel
                node={selected}
                isRoot={selected.id === g.graph.rootId}
                impact={impact}
                onExpand={expand}
                onPrune={prune}
                onClose={() => g.select(undefined)}
                onTags={g.setTags}
                onOpenArtist={onSelectSearch}
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
              onSelect={g.select}
              onExpand={expand}
              resetKey={resetKey}
              centerRequest={centerRequest}
            />
            <JourneyTrail
              journey={g.graph.journey}
              nodes={g.graph.nodes}
              focusId={g.graph.focusId}
              selectedId={g.graph.selectedNodeId}
              onJump={jumpTo}
              onCollapse={(id) => prune(id, 'collapse')}
            />
            <div className="stage__help">
              Click a node to inspect · double-click to expand · Delete removes a branch · scroll or use +/− to zoom
            </div>
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
                toast.action!.run()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
