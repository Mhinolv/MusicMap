import { decodeBookmarks, type Bookmark } from './bookmarks'

export const EXCLUSION_STORAGE_KEY = 'tunegraph:exclusions:v1'
export const EXCLUSION_LIMIT = 100
export const EXCLUSION_FULL_MESSAGE = 'Not suggested list is full (100). Remove some or reset it to exclude more.'
export type ExcludedSong = Extract<Bookmark, { kind: 'track' }>

/** Reuse tolerant reference decoding; keep Saved and taste storage unchanged. */
export function decodeExclusions(raw: string | null): ExcludedSong[] {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value?.version !== 1 || !Array.isArray(value.items)) return []
    const songs = value.items.filter((v: unknown) => !!v && typeof v === 'object' && 'kind' in v && v.kind === 'track')
    return decodeBookmarks(JSON.stringify({ version: 1, items: songs }))
      .filter((entry): entry is ExcludedSong => entry.kind === 'track').slice(0, EXCLUSION_LIMIT)
  } catch { return [] }
}

export function readExclusions(): ExcludedSong[] {
  try { return decodeExclusions(localStorage.getItem(EXCLUSION_STORAGE_KEY)) } catch { return [] }
}

export function writeExclusions(entries: ExcludedSong[]): boolean {
  try {
    localStorage.setItem(EXCLUSION_STORAGE_KEY, JSON.stringify({ version: 1, items: entries }))
    return true
  } catch { return false }
}

export function addExclusion(entries: ExcludedSong[], entry: ExcludedSong): ExcludedSong[] {
  if (entries.length >= EXCLUSION_LIMIT || entries.some((song) => song.item.id === entry.item.id)) return entries
  return [entry, ...entries]
}

export function restoreExclusions(entries: ExcludedSong[], removed: ExcludedSong[]): ExcludedSong[] {
  const ids = new Set(entries.map((entry) => entry.item.id))
  const missing = removed.filter((entry) => !ids.has(entry.item.id))
  if (entries.length + missing.length > EXCLUSION_LIMIT) return entries
  return [...entries, ...missing].sort((a, b) => b.savedAt - a.savedAt)
}
