import type { ArtistEdge, ArtistNode, MusicGraph } from '../types'

export const MAP_STORAGE_KEY = 'tunegraph:map:v1'
export const MAP_NODE_LIMIT = 500
export const MAP_BYTE_LIMIT = 1024 * 1024
export type MapSnapshot = { graph: MusicGraph; followJourney: boolean }
export type SavedMap = { status: 'none' | 'invalid' } | { status: 'ready'; snapshot: MapSnapshot }

const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const optionalText = (v: unknown) => typeof v === 'string' ? v : undefined
const tags = (v: unknown): string[] | undefined => Array.isArray(v) && v.every((t) => typeof t === 'string') ? v : undefined
const bytes = (raw: string) => new TextEncoder().encode(raw).length

/** Validate structural references; tolerate missing optional metadata and transient state. */
export function decodeMap(raw: string | null): SavedMap {
  if (raw === null) return { status: 'none' }
  try {
    if (raw.length > MAP_BYTE_LIMIT || bytes(raw) > MAP_BYTE_LIMIT) return { status: 'invalid' }
    const v = JSON.parse(raw)
    if (v?.version !== 1 || !Array.isArray(v.nodes) || !v.nodes.length || v.nodes.length > MAP_NODE_LIMIT
      || !Array.isArray(v.edges) || !text(v.rootId)) return { status: 'invalid' }
    const nodes = new Map<string, ArtistNode>()
    for (const n of v.nodes) {
      if (!n || !text(n.id) || !text(n.name) || !['artist', 'track'].includes(n.kind) || nodes.has(n.id)) return { status: 'invalid' }
      if (n.kind === 'track' && (!text(n.artist?.id) || !text(n.artist?.name))) return { status: 'invalid' }
      nodes.set(n.id, {
        id: n.id, name: n.name, kind: n.kind, expanded: n.expanded === true, loading: false,
        parentId: optionalText(n.parentId), mbid: optionalText(n.mbid), imageUrl: optionalText(n.imageUrl),
        tags: tags(n.tags), subtitle: optionalText(n.subtitle),
        artist: n.kind === 'track' ? { id: n.artist.id, name: n.artist.name, mbid: optionalText(n.artist.mbid) } : undefined,
        ranking: n.ranking && ['parent', 'journey'].includes(n.ranking.mode) && Number.isInteger(n.ranking.stop_count)
          && n.ranking.stop_count >= 0 && [null, 'cap_exceeded', 'timeout', 'missing_tags'].includes(n.ranking.fallback_reason)
          ? n.ranking : undefined,
      })
    }
    const root = nodes.get(v.rootId)
    if (!root || root.parentId) return { status: 'invalid' }
    for (const n of nodes.values()) {
      if (n.kind !== root.kind || (n.parentId && !nodes.has(n.parentId))) return { status: 'invalid' }
      const seen = new Set([n.id])
      let parent = n.parentId
      while (parent) {
        if (seen.has(parent)) return { status: 'invalid' }
        seen.add(parent)
        parent = nodes.get(parent)?.parentId
      }
    }
    const edges = new Map<string, ArtistEdge>()
    for (const e of v.edges) {
      if (!e || !text(e.id) || !nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target || edges.has(e.id)) return { status: 'invalid' }
      edges.set(e.id, { id: e.id, source: e.source, target: e.target,
        similarity: typeof e.similarity === 'number' && Number.isFinite(e.similarity) ? e.similarity : undefined,
        sharedTags: tags(e.sharedTags) })
    }
    const journey: string[] = Array.isArray(v.journey)
      ? [...new Set<string>(v.journey.filter((id: unknown) => typeof id === 'string' && nodes.has(id)))] : [v.rootId]
    const graph: MusicGraph = { nodes, edges, rootId: v.rootId,
      focusId: nodes.has(v.focusId) ? v.focusId : v.rootId,
      selectedNodeId: nodes.has(v.selectedNodeId) ? v.selectedNodeId : undefined, journey }
    return { status: 'ready', snapshot: { graph, followJourney: v.followJourney === true } }
  } catch { return { status: 'invalid' } }
}

export function readMap(): SavedMap {
  try { return decodeMap(localStorage.getItem(MAP_STORAGE_KEY)) } catch { return { status: 'none' } }
}

export function clearMap(): void {
  try { localStorage.removeItem(MAP_STORAGE_KEY) } catch { /* Storage may be disabled. */ }
}

/** A single bounded snapshot as JSON text; no simulation coordinates, undo history, or API caches. */
export function encodeMap(graph: MusicGraph, followJourney: boolean): string | 'too-large' | 'unavailable' {
  if (!graph.rootId || !graph.nodes.size) return 'unavailable'
  if (graph.nodes.size > MAP_NODE_LIMIT) return 'too-large'
  const raw = JSON.stringify({ version: 1, rootId: graph.rootId, focusId: graph.focusId,
    selectedNodeId: graph.selectedNodeId, journey: graph.journey, followJourney,
    nodes: [...graph.nodes.values()].map(({ loading: _loading, error: _error, ...node }) => node),
    edges: [...graph.edges.values()] })
  return bytes(raw) > MAP_BYTE_LIMIT ? 'too-large' : raw
}

/** `raw` lets a caller that already encoded the map (history, #77) skip a second encode. */
export function saveMap(graph: MusicGraph, followJourney: boolean, raw = encodeMap(graph, followJourney)): 'saved' | 'too-large' | 'unavailable' {
  if (raw === 'unavailable') return raw
  if (raw === 'too-large') { clearMap(); return raw }
  try { localStorage.setItem(MAP_STORAGE_KEY, raw); return 'saved' } catch { clearMap(); return 'unavailable' }
}
