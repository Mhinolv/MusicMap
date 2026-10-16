// Account copy of the taste profile (#76). `tunegraph:taste:v1` stays the local cache;
// this module holds the pure rules, so they run in node tests with no browser.
import type { TasteProfile } from './types'
import { isEmptyTaste, TASTE_LIMIT } from './taste'

export type SyncStatus = 'synced' | 'saving' | 'offline' | 'failed'
export const SYNC_TEXT: Record<SyncStatus, string> = {
  synced: 'Synced',
  saving: 'Saving…',
  offline: 'Offline. Saved on this device.',
  failed: "Couldn't sync. Saved on this device.",
}
export const syncWarns = (status: SyncStatus) => status === 'offline' || status === 'failed'
const SYNC_RANK: SyncStatus[] = ['synced', 'saving', 'offline', 'failed']
/** The account popover shows the worst state of taste, history and Library (#79). */
export const worstSync = (...statuses: SyncStatus[]): SyncStatus =>
  statuses.reduce((worst, status) => (SYNC_RANK.indexOf(status) > SYNC_RANK.indexOf(worst) ? status : worst), 'synced')

export const MERGE_ADDED = 'Added your taste from this device to your account.'
export const MERGE_CAPPED = `Some entries didn't fit. Each list keeps ${TASTE_LIMIT}.`
export const SYNC_FAILED_TOAST = "Couldn't sync your taste. It's saved on this device."
export const CLEARED_ALL_TOAST = 'Taste cleared on all your devices.'
export const CLEAR_ALL_CONFIRM = 'This clears your profile on all your devices.'

/** Which account this device's cache belongs to, and whether it has edits the account lacks. */
export const TASTE_SYNC_KEY = 'tunegraph:taste-sync:v1'
export type SyncMarker = { user: string; pending: boolean }

export function readSyncMarker(): SyncMarker | null {
  try {
    const value = JSON.parse(localStorage.getItem(TASTE_SYNC_KEY) ?? 'null')
    if (!value || typeof value.user !== 'string' || !value.user) return null
    return { user: value.user, pending: value.pending === true }
  } catch { return null }
}

export function writeSyncMarker(marker: SyncMarker | null): void {
  try {
    if (marker) localStorage.setItem(TASTE_SYNC_KEY, JSON.stringify(marker))
    else localStorage.removeItem(TASTE_SYNC_KEY)
  } catch { /* blocked storage: the next sync merges again, which is safe */ }
}

/** A local edit marks a linked cache as pending; an unlinked cache merges at sign-in anyway. */
export const editedMarker = (marker: SyncMarker | null): SyncMarker | null => marker && { ...marker, pending: true }

export type SyncStep = 'merge' | 'push' | 'pull'
/** First sign-in on this device (or another account's cache) merges; a pending edit pushes; else pull. */
export function nextSyncStep(marker: SyncMarker | null, userId: string): SyncStep {
  if (marker?.user !== userId) return 'merge'
  return marker.pending ? 'push' : 'pull'
}

const lists = ['liked_artists', 'liked_tracks', 'liked_genres', 'disliked'] as const
export function sameTaste(a: TasteProfile | null, b: TasteProfile | null): boolean {
  const empty = (p: TasteProfile | null) => !p || isEmptyTaste(p)
  if (empty(a) || empty(b)) return empty(a) && empty(b)
  return lists.every((name) => a![name].length === b![name].length && a![name].every((v, i) => v === b![name][i]))
    && a!.notes === b!.notes
}

/** No toast when the merge added nothing and nothing was cut off. */
export function mergeToast(result: { added: number; capped: string[] }): { msg: string; lines?: string[] } | null {
  if (result.added > 0) return result.capped.length ? { msg: MERGE_ADDED, lines: [MERGE_CAPPED] } : { msg: MERGE_ADDED }
  return result.capped.length ? { msg: MERGE_CAPPED } : null
}

/** A network error (status 0) or an offline browser is Offline; any server error is Failed. */
export const failureStatus = (online: boolean, status: number): SyncStatus => (!online || status === 0 ? 'offline' : 'failed')
