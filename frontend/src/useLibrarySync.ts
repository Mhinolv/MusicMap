import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api, ApiError } from './api'
import type { Bookmark } from './bookmarks'
import type { ExcludedSong } from './exclusions'
import type { AuthUser } from './types'
import { failureStatus, type SyncStatus } from './tasteSync'
import { decodeLibrary, decodeLibraryMerge, editedLibraryMarker, nextLibraryStep, readLibraryMarker, sameEntries, writeLibraryMarker,
  type LibraryList, type LibraryLists, type LibraryMerge } from './librarySync'

type Options = {
  user: AuthUser | null
  /** The local lists, always current (App updates them before React state). */
  bookmarksRef: RefObject<Bookmark[]>
  exclusionsRef: RefObject<ExcludedSong[]>
  /** Replace the local lists with no sync and no toast. An unchanged list keeps its array. */
  apply: (lists: LibraryLists) => void
  onMerged: (result: LibraryMerge) => void
  /** A merge or an edit could not reach the account. */
  onWriteFailed: () => void
}

/** Background sync of Saved and Not suggested while signed in (#79). Signed out, it does nothing. */
export function useLibrarySync({ user, bookmarksRef, exclusionsRef, apply, onMerged, onWriteFailed }: Options) {
  // The status belongs to one account; a new sign-in starts at Synced.
  const [state, setState] = useState<{ user: string; status: SyncStatus } | null>(null)
  const userRef = useRef(user)
  const callbacks = useRef({ apply, onMerged, onWriteFailed })
  useLayoutEffect(() => {
    userRef.current = user
    callbacks.current = { apply, onMerged, onWriteFailed }
  })
  const running = useRef(false)
  const again = useRef(false)

  // One request chain at a time; a trigger during a request runs one more pass after it.
  const run = useCallback(async () => {
    if (running.current) { again.current = true; return }
    running.current = true
    try {
      do {
        again.current = false
        const who = userRef.current
        if (!who) break
        const setStatus = (status: SyncStatus) => setState({ user: who.id, status })
        const marker = readLibraryMarker()
        const step = nextLibraryStep(marker, who.id)
        const local: LibraryLists = { bookmarks: bookmarksRef.current, exclusions: exclusionsRef.current }
        const changed = () => bookmarksRef.current !== local.bookmarks || exclusionsRef.current !== local.exclusions
        if (step !== 'pull') setStatus('saving')
        try {
          if (step === 'merge') {
            const result = decodeLibraryMerge(await api.mergeUserLibrary(local.bookmarks, local.exclusions))
            if (userRef.current?.id !== who.id) break
            // An edit during the merge: merge again with the newer lists.
            if (changed()) { again.current = true; continue }
            callbacks.current.apply(result)
            writeLibraryMarker({ user: who.id, bookmarks: false, exclusions: false })
            callbacks.current.onMerged(result)
          } else if (step === 'push') {
            if (marker!.bookmarks) await api.putUserBookmarks(local.bookmarks)
            if (marker!.exclusions) await api.putUserExclusions(local.exclusions)
            if (userRef.current?.id !== who.id) break
            // A list edited during the push stays pending for the next pass.
            const now = readLibraryMarker() ?? marker!
            const bookmarks = now.bookmarks && bookmarksRef.current !== local.bookmarks
            const exclusions = now.exclusions && exclusionsRef.current !== local.exclusions
            writeLibraryMarker({ user: who.id, bookmarks, exclusions })
            if (bookmarks || exclusions) again.current = true
          } else {
            const remote = decodeLibrary(await api.userLibrary())
            if (userRef.current?.id !== who.id) break
            // A local edit during the pull wins: push it on the next pass.
            const now = readLibraryMarker()
            if (now?.bookmarks || now?.exclusions || changed()) { again.current = true; continue }
            const sameSaved = sameEntries(remote.bookmarks, local.bookmarks)
            const sameExcluded = sameEntries(remote.exclusions, local.exclusions)
            if (!sameSaved || !sameExcluded) callbacks.current.apply({
              bookmarks: sameSaved ? local.bookmarks : remote.bookmarks,
              exclusions: sameExcluded ? local.exclusions : remote.exclusions,
            })
          }
          setStatus('synced')
        } catch (err) {
          if (userRef.current?.id !== who.id) break
          setStatus(failureStatus(navigator.onLine, err instanceof ApiError ? err.status : 0))
          if (step !== 'pull') callbacks.current.onWriteFailed()
          // Try again on the next edit, the `online` event or window focus.
          if (!again.current) break
        }
      } while (again.current)
    } finally {
      running.current = false
    }
  }, [bookmarksRef, exclusionsRef])

  /** Call after every local write of a list while signed in (save, remove, clear, Undo). */
  const edited = useCallback((list: LibraryList) => {
    writeLibraryMarker(editedLibraryMarker(readLibraryMarker(), list))
    if (userRef.current) void run()
  }, [run])

  useEffect(() => {
    if (user) void run()
  }, [user, run])

  useEffect(() => {
    if (!user) return
    const retry = () => { void run() }
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    return () => {
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
    }
  }, [user, run])

  return { status: state && state.user === user?.id ? state.status : 'synced' as SyncStatus, edited }
}
