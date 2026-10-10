import type { ArtistNode, TasteProfile } from './types'

export const TASTE_STORAGE_KEY = 'tunegraph:taste:v1'
export const TASTE_LIMIT = 15
export type TasteList = 'liked_artists' | 'liked_tracks' | 'disliked'
export const emptyTaste = (): TasteProfile => ({ liked_artists: [], liked_tracks: [], liked_genres: [], disliked: [], notes: '' })
const matchKey = (value: string) => value.trim().toLowerCase()

export function hasPositiveTaste(profile: TasteProfile | null): boolean {
  return !!profile && !!(profile.liked_artists.length || profile.liked_tracks.length || profile.liked_genres.length || profile.notes.trim())
}

export function isEmptyTaste(profile: TasteProfile): boolean {
  return !hasPositiveTaste(profile) && !profile.disliked.length
}

export function tasteEntry(node: Pick<ArtistNode, 'kind' | 'name' | 'artist'>): string {
  const title = node.name.trim()
  const artist = node.artist?.name.trim()
  return (node.kind === 'track' && artist ? `${title} — ${artist}` : title).slice(0, 120).trim()
}

export function storedTasteEntry(profile: TasteProfile | null, list: TasteList, entry: string): string | undefined {
  return profile?.[list].find((value) => matchKey(value) === matchKey(entry))
}

// null clears the profile; a full list returns the original profile unchanged.
export function toggleTaste(profile: TasteProfile | null, list: TasteList, entry: string): TasteProfile | null {
  const value = entry.trim().slice(0, 120).trim()
  if (!value) return profile
  const previous = profile ?? emptyTaste()
  const stored = storedTasteEntry(previous, list, value)
  if (stored === undefined && previous[list].length >= TASTE_LIMIT) return profile
  const next = { ...previous, [list]: stored === undefined
    ? [...previous[list], value]
    : previous[list].filter((item) => matchKey(item) !== matchKey(value)) }
  return isEmptyTaste(next) ? null : next
}

export function readTaste(): TasteProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(TASTE_STORAGE_KEY) ?? 'null')
    if (!value || !['liked_artists', 'liked_tracks', 'liked_genres', 'disliked'].every((key) =>
      Array.isArray(value[key]) && value[key].every((entry: unknown) => typeof entry === 'string'))
      || typeof value.notes !== 'string') return null
    return isEmptyTaste(value) ? null : value as TasteProfile
  } catch { return null }
}

export function writeTaste(profile: TasteProfile | null): boolean {
  try {
    if (!profile || isEmptyTaste(profile)) localStorage.removeItem(TASTE_STORAGE_KEY)
    else localStorage.setItem(TASTE_STORAGE_KEY, JSON.stringify(profile))
    return true
  } catch { return false }
}
