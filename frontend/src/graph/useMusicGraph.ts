import { useCallback, useMemo, useReducer } from 'react'
import {
  edgeId,
  type ArtistEdge,
  type ArtistNode,
  type ArtistRef,
  type MusicGraph,
  type PruneMode,
  type TrackRef,
} from '../types'

type Action =
  | { type: 'reset'; root: ArtistNode }
  | { type: 'select'; id?: string }
  | { type: 'expand:start'; id: string }
  | { type: 'expand:success'; id: string; children: ExpandedChild[] }
  | { type: 'expand:failure'; id: string; error: string }
  | { type: 'node:tags'; id: string; tags: string[] }
  | { type: 'prune'; id: string; mode: PruneMode }
  | { type: 'undo' }

/** A node discovered by an expansion, with how strongly it relates to the expanded node. */
export type ExpandedChild = { node: ArtistNode; similarity?: number; sharedTags?: string[] }

const empty: MusicGraph = { nodes: new Map(), edges: new Map(), journey: [] }

export function artistNode(ref: ArtistRef, parentId?: string): ArtistNode {
  return {
    parentId,
    kind: 'artist',
    id: ref.id,
    mbid: ref.mbid ?? undefined,
    name: ref.name,
    expanded: false,
    loading: false,
    imageUrl: ref.image_url ?? undefined,
  }
}

export function trackNode(track: TrackRef, parentId?: string): ArtistNode {
  return {
    parentId,
    kind: 'track',
    subtitle: track.artist.name,
    id: track.id,
    mbid: track.mbid ?? undefined,
    name: track.name,
    artist: track.artist,
    expanded: false,
    loading: false,
  }
}

/** Every node that descends from `id` through the "discovered by" (parentId) chain. */
function descendants(nodes: Map<string, ArtistNode>, id: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const n of nodes.values()) {
    if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  }
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const c of children.get(cur) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

export type PrunePlan = {
  /** Node ids that will leave the graph. */
  removed: string[]
  /** Nodes kept because another surviving hub also discovered them, re-homed to that hub. */
  rescued: Map<string, string>
}

/**
 * Work out what collapsing or removing `id` would do, without doing it.
 * Collapse keeps the node and forgets the branch it opened; remove drops the node too.
 *
 * Leaves in the branch are rescued when an expanded node outside the branch links to
 * them: a leaf only ever gets an edge from a hub that listed it as similar, so it is
 * part of that hub's cluster too and is re-homed there. Expanded nodes inside the
 * branch always go: they are the exploration path being undone.
 */
export function planPrune(graph: MusicGraph, id: string, mode: PruneMode): PrunePlan | null {
  const target = graph.nodes.get(id)
  if (!target) return null
  if (mode === 'remove' && id === graph.rootId) return null
  const doomed = descendants(graph.nodes, id)
  if (mode === 'remove') doomed.add(id)

  const rescued = new Map<string, string>()
  for (const e of graph.edges.values()) {
    for (const [inside, outside] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      if (inside === id || !doomed.has(inside) || doomed.has(outside) || outside === id) continue
      const leaf = graph.nodes.get(inside)
      const hub = graph.nodes.get(outside)
      if (leaf && !leaf.expanded && hub?.expanded && !rescued.has(inside)) rescued.set(inside, outside)
    }
  }

  const removed = [...doomed].filter((n) => !rescued.has(n))
  if (removed.length === 0 && mode === 'collapse' && !target.expanded) return null
  return { removed, rescued }
}

function prune(state: MusicGraph, id: string, mode: PruneMode, seq: number): MusicGraph {
  const plan = planPrune(state, id, mode)
  const target = state.nodes.get(id)
  if (!plan || !target) return state

  const nodes = new Map(state.nodes)
  for (const r of plan.removed) nodes.delete(r)
  for (const [n, parent] of plan.rescued) {
    const node = nodes.get(n)
    if (node) nodes.set(n, { ...node, parentId: parent })
  }
  if (mode === 'collapse') nodes.set(id, { ...target, expanded: false, loading: false, error: undefined })

  const edges = new Map<string, ArtistEdge>()
  for (const e of state.edges.values()) {
    if (nodes.has(e.source) && nodes.has(e.target)) edges.set(e.id, e)
  }

  const journey = state.journey.filter((j) => {
    const n = nodes.get(j)
    return !!n && (n.expanded || j === state.rootId)
  })
  const focusId =
    state.focusId && nodes.get(state.focusId)?.expanded
      ? state.focusId
      : [...journey].reverse().find((j) => nodes.get(j)?.expanded) ?? state.rootId
  const selectedNodeId =
    state.selectedNodeId && nodes.has(state.selectedNodeId)
      ? state.selectedNodeId
      : mode === 'remove' && target.parentId && nodes.has(target.parentId)
        ? target.parentId
        : undefined

  const count = plan.removed.length
  const unit = target.kind === 'track' ? ['song', 'songs'] : ['artist', 'artists']
  const noun = (n: number) => `${n} ${n === 1 ? unit[0] : unit[1]}`
  const summary =
    mode === 'remove'
      ? `Removed ${target.name}${count > 1 ? ` and ${noun(count - 1)}` : ''}`
      : count > 0
        ? `Collapsed ${target.name}, removing ${noun(count)}`
        : `Collapsed ${target.name}`

  const { undo: _prev, ...snapshot } = state
  void _prev
  return { ...state, nodes, edges, journey, focusId, selectedNodeId, undo: { graph: snapshot, summary, seq } }
}

let pruneSeq = 0

function reducer(state: MusicGraph, action: Action): MusicGraph {
  switch (action.type) {
    case 'reset': {
      const nodes = new Map<string, ArtistNode>()
      nodes.set(action.root.id, action.root)
      return {
        nodes,
        edges: new Map(),
        selectedNodeId: action.root.id,
        rootId: action.root.id,
        focusId: action.root.id,
        journey: [action.root.id],
      }
    }
    case 'select':
      return state.selectedNodeId === action.id ? state : { ...state, selectedNodeId: action.id }

    case 'expand:start': {
      const node = state.nodes.get(action.id)
      if (!node || node.loading) return state
      const nodes = new Map(state.nodes)
      nodes.set(action.id, { ...node, loading: true, error: undefined })
      return { ...state, nodes }
    }
    case 'expand:failure': {
      const node = state.nodes.get(action.id)
      if (!node) return state
      const nodes = new Map(state.nodes)
      nodes.set(action.id, { ...node, loading: false, error: action.error })
      return { ...state, nodes }
    }
    case 'expand:success': {
      const source = state.nodes.get(action.id)
      if (!source) return state
      const nodes = new Map(state.nodes)
      const edges = new Map(state.edges)
      nodes.set(action.id, { ...source, loading: false, expanded: true, error: undefined })
      for (const { node: child, similarity, sharedTags } of action.children) {
        if (child.id === action.id) continue
        // Reuse existing nodes rather than duplicating (MVP §9).
        if (!nodes.has(child.id)) nodes.set(child.id, { ...child, parentId: action.id })
        const eid = edgeId(action.id, child.id)
        const existing = edges.get(eid)
        if (!existing) {
          edges.set(eid, { id: eid, source: action.id, target: child.id, similarity, sharedTags })
        } else if (similarity !== undefined && (existing.similarity ?? 0) < similarity) {
          edges.set(eid, { ...existing, similarity, sharedTags: sharedTags ?? existing.sharedTags })
        }
      }
      // The most recently expanded node becomes the focus; older generations recede.
      const journey = state.journey.includes(action.id) ? state.journey : [...state.journey, action.id]
      // The graph moved on: an older undo snapshot would silently discard this expansion.
      return { ...state, nodes, edges, focusId: action.id, journey, undo: undefined }
    }
    case 'node:tags': {
      const node = state.nodes.get(action.id)
      if (!node) return state
      const nodes = new Map(state.nodes)
      nodes.set(action.id, { ...node, tags: action.tags })
      return { ...state, nodes }
    }
    case 'prune':
      return prune(state, action.id, action.mode, ++pruneSeq)
    case 'undo':
      return state.undo ? { ...state.undo.graph, undo: undefined } : state
  }
}

export function useMusicGraph() {
  const [graph, dispatch] = useReducer(reducer, empty)

  const nodes = useMemo(() => [...graph.nodes.values()], [graph.nodes])
  const edges = useMemo(() => [...graph.edges.values()], [graph.edges])

  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of graph.edges.values()) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1)
      d.set(e.target, (d.get(e.target) ?? 0) + 1)
    }
    return d
  }, [graph.edges])

  const resetArtist = useCallback((root: ArtistRef) => dispatch({ type: 'reset', root: artistNode(root) }), [])
  const resetTrack = useCallback((root: TrackRef) => dispatch({ type: 'reset', root: trackNode(root) }), [])
  const select = useCallback((id?: string) => dispatch({ type: 'select', id }), [])
  const expandStart = useCallback((id: string) => dispatch({ type: 'expand:start', id }), [])
  const expandSuccess = useCallback(
    (id: string, children: ExpandedChild[]) => dispatch({ type: 'expand:success', id, children }),
    [],
  )
  const expandFailure = useCallback((id: string, error: string) => dispatch({ type: 'expand:failure', id, error }), [])
  const setTags = useCallback((id: string, tags: string[]) => dispatch({ type: 'node:tags', id, tags }), [])
  const prune = useCallback((id: string, mode: PruneMode) => dispatch({ type: 'prune', id, mode }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])

  return {
    graph,
    nodes,
    edges,
    degree,
    resetArtist,
    resetTrack,
    select,
    expandStart,
    expandSuccess,
    expandFailure,
    setTags,
    prune,
    undo,
  }
}

export type GraphEdges = ArtistEdge[]
