// Account copy of the Library lists (#79). `tunegraph:bookmarks:v1` and `tunegraph:exclusions:v1`
// stay the local cache; this module holds the pure rules, so they run in node tests with no browser.
import { bookmarkKey, BOOKMARK_LIMIT, decodeBookmarks, type Bookmark } from './bookmarks'
import { decodeExclusions, EXCLUSION_LIMIT, type ExcludedSong } from './exclusions'
import type { SyncStep } from './tasteSync'

export type LibraryList = 'bookmarks' | 'exclusions'
export type LibraryLists = { bookmarks: Bookmark[]; exclusions: ExcludedSong[] }
/** `POST /api/user/library/merge`: the account lists after the first sign-in on a device. */
export type LibraryMerge = LibraryLists & { added: number; capped: LibraryList[] }

export const LIBRARY_MERGE_ADDED = 'Added your Library from this device to your account.'
export const LIBRARY_MERGE_CAPPED = `Some items didn't fit. Saved keeps ${BOOKMARK_LIMIT} and Not suggested keeps ${EXCLUSION_LIMIT}.`
export const LIBRARY_SYNC_FAILED_TOAST = "Couldn't sync your Library. It's saved on this device."
export const libraryNote = (signedIn: boolean) =>
  `${signedIn ? 'Synced to your account.' : 'Kept on this device.'} Songs marked "Don't suggest again" move to Not suggested, where you can restore them.`

/** Which account this device's lists belong to, and which lists have edits the account lacks. */
export const LIBRARY_SYNC_KEY = 'tunegraph:library-sync:v1'
export type LibraryMarker = { user: string; bookmarks: boolean; exclusions: boolean }

export function readLibraryMarker(): LibraryMarker | null {
  try {
    const value = JSON.parse(localStorage.getItem(LIBRARY_SYNC_KEY) ?? 'null')
    if (!value || typeof value.user !== 'string' || !value.user) return null
    return { user: value.user, bookmarks: value.bookmarks === true, exclusions: value.exclusions === true }
  } catch { return null }
}

export function writeLibraryMarker(marker: LibraryMarker | null): void {
  try {
    if (marker) localStorage.setItem(LIBRARY_SYNC_KEY, JSON.stringify(marker))
    else localStorage.removeItem(LIBRARY_SYNC_KEY)
  } catch { /* blocked storage: the next sync merges again, which is safe */ }
}

/** A local edit marks that list pending on a linked device; an unlinked device merges at sign-in anyway. */
export const editedLibraryMarker = (marker: LibraryMarker | null, list: LibraryList): LibraryMarker | null =>
  marker && { ...marker, [list]: true }

/** First sign-in on this device (or another account's lists) merges; a pending edit pushes; else pull. */
export function nextLibraryStep(marker: LibraryMarker | null, userId: string): SyncStep {
  if (marker?.user !== userId) return 'merge'
  return marker.bookmarks || marker.exclusions ? 'push' : 'pull'
}

/** The same entries in the same order, with the same save times. */
export function sameEntries(a: Bookmark[], b: Bookmark[]): boolean {
  return a.length === b.length && a.every((entry, i) => bookmarkKey(entry) === bookmarkKey(b[i]) && entry.savedAt === b[i].savedAt)
}

/** The server answer goes through the tolerant local decoders, so bad rows never reach the UI. */
export function decodeLibrary(value: unknown): LibraryLists {
  const lists = (value ?? {}) as Record<string, unknown>
  return {
    bookmarks: decodeBookmarks(JSON.stringify(lists.bookmarks ?? null)),
    exclusions: decodeExclusions(JSON.stringify(lists.exclusions ?? null)),
  }
}

export function decodeLibraryMerge(value: unknown): LibraryMerge {
  const r = (value ?? {}) as { added?: unknown; capped?: unknown }
  return {
    ...decodeLibrary(value),
    added: typeof r.added === 'number' && r.added > 0 ? r.added : 0,
    capped: Array.isArray(r.capped) ? r.capped.filter((list): list is LibraryList => list === 'bookmarks' || list === 'exclusions') : [],
  }
}

/** No toast when the merge added nothing and nothing was cut off. */
export function libraryMergeToast(result: { added: number; capped: string[] }): { msg: string; lines?: string[] } | null {
  if (result.added > 0) return result.capped.length ? { msg: LIBRARY_MERGE_ADDED, lines: [LIBRARY_MERGE_CAPPED] } : { msg: LIBRARY_MERGE_ADDED }
  return result.capped.length ? { msg: LIBRARY_MERGE_CAPPED } : null
}
