import { bandFor, type FitBand } from './fitBand'
import type { ArtistNode, TasteConnectionResult } from './types'

// "Check these connections" (#37): pure helpers for the song panel's batch taste check.

/** Same cap as one song expansion (EXPAND_LIMIT) and the backend batch. */
export const CONNECTIONS_LIMIT = 7

export type ConnectionItem = { id: string; name: string; artist: string }

/** The songs this node's expansion brought onto the map that are still there, in graph
 *  (match) order. Never re-sorted by fit. Artist nodes have no connections check. */
export function expansionChildren(nodes: Map<string, ArtistNode>, parentId: string): ConnectionItem[] {
  if (nodes.get(parentId)?.kind !== 'track') return []
  const items: ConnectionItem[] = []
  for (const node of nodes.values()) {
    if (node.parentId !== parentId || node.kind !== 'track') continue
    items.push({ id: node.id, name: node.name, artist: node.artist?.name ?? '' })
    if (items.length === CONNECTIONS_LIMIT) break
  }
  return items
}

export function connectionLabel(item: ConnectionItem): string {
  return item.artist ? `${item.name} — ${item.artist}` : item.name
}

/** The #36 fit band, or null for an unknown row ("Couldn't check"). */
export function connectionBand(result: TasteConnectionResult): FitBand | null {
  return result.outcome === 'unknown' ? null : bandFor({ outcome: result.outcome, level: result.level })
}

/** Rows to send on "Check again": only the misses, or every row when nothing is missing
 *  (served from the server cache). */
export function idsToCheck(items: ConnectionItem[], results: Record<string, TasteConnectionResult>): string[] {
  const misses = items.filter((item) => !results[item.id] || results[item.id].outcome === 'unknown')
  return (misses.length ? misses : items).map((item) => item.id)
}

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`

/** Summary over the visible rows; null until at least one row has a result. */
export function connectionsSummary(items: ConnectionItem[], results: Record<string, TasteConnectionResult>): string | null {
  const shown = items.map((item) => results[item.id]).filter((result) => result !== undefined)
  if (!shown.length) return null
  const bands = shown.map(connectionBand)
  const unknown = bands.filter((band) => band === null).length
  const fits = bands.filter((band) => band?.key === 'likely' || band?.key === 'strong').length
  const thin = bands.filter((band) => band?.key === 'insufficient').length
  const summary = `Checked ${songs(shown.length - unknown)}: ${fits} likely or strong fit, ${thin} not enough information.`
  return unknown ? `${summary} ${songs(unknown)} couldn't be checked.` : summary
}
