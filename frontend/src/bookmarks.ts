import type { ArtistNode, ArtistRef, TrackRef } from './types'

export const BOOKMARK_STORAGE_KEY = 'tunegraph:bookmarks:v1'
export const BOOKMARK_LIMIT = 200
export const BOOKMARK_FULL_MESSAGE = 'Saved list is full (200). Remove some to save more.'
export type Bookmark = (
  | { kind: 'artist'; item: ArtistRef }
  | { kind: 'track'; item: TrackRef }
) & { savedAt: number }

export const bookmarkKey = (entry: Bookmark) => `${entry.kind}:${entry.item.id}`

function artistRef(value: unknown): ArtistRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id.trim() || typeof v.name !== 'string' || !v.name.trim()) return null
  return {
    id: v.id, name: v.name,
    mbid: typeof v.mbid === 'string' ? v.mbid : undefined,
    image_url: typeof v.image_url === 'string' ? v.image_url : undefined,
  }
}

/** Skip corrupt entries and default optional fields without discarding valid discoveries. */
export function decodeBookmarks(raw: string | null): Bookmark[] {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value?.version !== 1 || !Array.isArray(value.items)) return []
    const entries: Bookmark[] = []
    const seen = new Set<string>()
    for (const v of value.items) {
      const item = artistRef(v?.item)
      if (!item || (v.kind !== 'artist' && v.kind !== 'track')) continue
      const savedAt = typeof v.savedAt === 'number' && Number.isFinite(v.savedAt) && v.savedAt >= 0 ? v.savedAt : 0
      let entry: Bookmark
      if (v.kind === 'track') {
        const artist = artistRef(v.item.artist)
        if (!artist) continue
        entry = { kind: 'track', item: { ...item, artist }, savedAt }
      } else entry = { kind: 'artist', item, savedAt }
      const key = bookmarkKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
      if (entries.length === BOOKMARK_LIMIT) break
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt)
  } catch { return [] }
}

export function readBookmarks(): Bookmark[] {
  try { return decodeBookmarks(localStorage.getItem(BOOKMARK_STORAGE_KEY)) } catch { return [] }
}

export function writeBookmarks(entries: Bookmark[]): boolean {
  try {
    localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify({ version: 1, items: entries }))
    return true
  } catch { return false }
}

export function nodeBookmark(node: ArtistNode, savedAt = Date.now()): Bookmark | null {
  const item: ArtistRef = { id: node.id, name: node.name, mbid: node.mbid, image_url: node.imageUrl }
  if (node.kind === 'track') return node.artist ? { kind: 'track', item: { ...item, artist: node.artist }, savedAt } : null
  return { kind: 'artist', item, savedAt }
}

export function addBookmark(entries: Bookmark[], entry: Bookmark): Bookmark[] {
  if (entries.some((v) => bookmarkKey(v) === bookmarkKey(entry)) || entries.length >= BOOKMARK_LIMIT) return entries
  return [entry, ...entries]
}

/** Undo restores removed entries while retaining subsequent saves and respecting the cap. */
export function restoreBookmarks(entries: Bookmark[], removed: Bookmark[]): Bookmark[] {
  const keys = new Set(entries.map(bookmarkKey))
  const missing = removed.filter((v) => !keys.has(bookmarkKey(v)))
  if (entries.length + missing.length > BOOKMARK_LIMIT) return entries
  return [...entries, ...missing].sort((a, b) => b.savedAt - a.savedAt)
}
