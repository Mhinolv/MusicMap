import type { ArtistNode, MusicGraph } from '../types'

type MatchNode = { id: string; parentId?: string }
type MatchEdge = { source: string; target: string; similarity?: number | null }

/**
 * Each node's match: the similarity of the edge to the node it was expanded from.
 * Nodes without a parent (the root, or legacy maps) take their strongest edge.
 * The graph sub-label and the On map list both read this, so they always agree.
 */
export function nodeMatches(nodes: Iterable<MatchNode>, edges: Iterable<MatchEdge>): Map<string, number> {
  const parents = new Map<string, string | undefined>()
  for (const n of nodes) parents.set(n.id, n.parentId)
  const matches = new Map<string, number>()
  for (const e of edges) {
    if (e.similarity == null) continue
    for (const [id, other] of [[e.source, e.target], [e.target, e.source]]) {
      if (!parents.get(id) || parents.get(id) === other) matches.set(id, Math.max(matches.get(id) ?? 0, e.similarity))
    }
  }
  return matches
}

export type OnMapRow = {
  id: string
  name: string
  /** Track rows only: who performs the song. */
  artist?: string
  match?: number
  loading: boolean
}

/** Every node on the map except the root, ranked by match (unknown last), then name. */
export function onMapRows(graph: Pick<MusicGraph, 'nodes' | 'edges' | 'rootId'>): { count: number; rows: OnMapRow[] } {
  const matches = nodeMatches(graph.nodes.values(), graph.edges.values())
  const rows: OnMapRow[] = []
  for (const n of graph.nodes.values()) {
    if (n.id === graph.rootId) continue
    rows.push({ id: n.id, name: n.name, artist: n.kind === 'track' ? n.artist?.name ?? n.subtitle : undefined, match: matches.get(n.id), loading: n.loading })
  }
  rows.sort((a, b) => (b.match ?? -1) - (a.match ?? -1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { count: graph.nodes.size, rows }
}

/** The integer shown in the score column: 0–100, `—` when unknown, `…` while loading. */
export function matchLabel(row: Pick<OnMapRow, 'match' | 'loading'>): string {
  if (row.loading) return '…'
  return row.match == null ? '—' : String(Math.round(matchFraction(row.match) * 100))
}

/** Bar fill as a 0–1 fraction; empty when unknown. */
export function matchFraction(match?: number): number {
  return match == null || !Number.isFinite(match) ? 0 : Math.min(1, Math.max(0, match))
}

export type MatchFact = { match?: number; parent: string; shared: string[] }

/** The inspector's MATCH and SHARED facts (#32): the edge to the node this one was expanded from; null without a parent. */
export function matchFact(graph: Pick<MusicGraph, 'nodes' | 'edges'>, id: string): MatchFact | null {
  const parentId = graph.nodes.get(id)?.parentId
  const parent = parentId ? graph.nodes.get(parentId) : undefined
  if (!parent) return null
  let edge: MatchEdge & { sharedTags?: string[] } | undefined
  for (const e of graph.edges.values()) {
    if ((e.source === id && e.target === parent.id) || (e.source === parent.id && e.target === id)) edge = e
  }
  return { match: edge?.similarity ?? undefined, parent: parent.name, shared: edge?.sharedTags ?? [] }
}

/** `82% to Creep`; null when the match is unknown so the row is omitted. */
export function matchText(fact: MatchFact | null | undefined): string | null {
  if (!fact || fact.match == null || !Number.isFinite(fact.match)) return null
  return `${Math.round(matchFraction(fact.match) * 100)}% to ${fact.parent}`
}

/** Journey stops in order; song maps only list expanded songs, as the floating trail does. */
export function journeyStops(graph: Pick<MusicGraph, 'nodes' | 'journey' | 'rootId'>): ArtistNode[] {
  const songMode = graph.rootId ? graph.nodes.get(graph.rootId)?.kind === 'track' : false
  return graph.journey.map((id) => graph.nodes.get(id)).filter((n): n is ArtistNode => !!n && (!songMode || n.expanded))
}

/** Two-digit stop number: 01, 02 … 99, then 100. */
export function stopNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}
