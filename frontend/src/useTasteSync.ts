import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { api, ApiError } from './api'
import type { AuthUser, TasteMerge, TasteProfile } from './types'
import { editedMarker, failureStatus, nextSyncStep, readSyncMarker, sameTaste, writeSyncMarker, type SyncStatus } from './tasteSync'

type Options = {
  user: AuthUser | null
  /** The local cache, always current (App updates it before React state). */
  tasteRef: RefObject<TasteProfile | null>
  /** Replace the local cache with no sync and no toast. */
  apply: (profile: TasteProfile | null) => void
  /** True while the taste dialog is open: a pulled profile waits until it closes. */
  holdRemote: boolean
  onMerged: (result: TasteMerge) => void
  onPushFailed: () => void
}

/** Background sync of the taste profile while signed in (#76). Signed out, it does nothing. */
export function useTasteSync({ user, tasteRef, apply, holdRemote, onMerged, onPushFailed }: Options) {
  // The status belongs to one account; a new sign-in starts at Synced.
  const [state, setState] = useState<{ user: string; status: SyncStatus } | null>(null)
  const userRef = useRef(user)
  const holdRef = useRef(holdRemote)
  const callbacks = useRef({ apply, onMerged, onPushFailed })
  useLayoutEffect(() => {
    userRef.current = user
    holdRef.current = holdRemote
    callbacks.current = { apply, onMerged, onPushFailed }
  })
  const running = useRef(false)
  const again = useRef(false)
  const held = useRef<{ profile: TasteProfile | null } | null>(null)

  // One request at a time; a trigger during a request runs one more pass after it.
  const run = useCallback(async () => {
    if (running.current) { again.current = true; return }
    running.current = true
    try {
      do {
        again.current = false
        const who = userRef.current
        if (!who) break
        const setStatus = (status: SyncStatus) => setState({ user: who.id, status })
        const step = nextSyncStep(readSyncMarker(), who.id)
        const local = tasteRef.current
        if (step !== 'pull') setStatus('saving')
        try {
          if (step === 'merge') {
            const result = await api.mergeUserTaste(local)
            if (userRef.current?.id !== who.id) break
            // An edit during the merge: merge again with the newer cache.
            if (tasteRef.current !== local) { again.current = true; continue }
            callbacks.current.apply(result.profile)
            writeSyncMarker({ user: who.id, pending: false })
            callbacks.current.onMerged(result)
          } else if (step === 'push') {
            await api.putUserTaste(local)
            if (userRef.current?.id !== who.id) break
            if (tasteRef.current === local) writeSyncMarker({ user: who.id, pending: false })
            else again.current = true
          } else {
            const remote = await api.userTaste()
            if (userRef.current?.id !== who.id) break
            // A local edit during the pull wins: push it on the next pass.
            if (readSyncMarker()?.pending || tasteRef.current !== local) { again.current = true; continue }
            if (!sameTaste(remote, local)) {
              if (holdRef.current) held.current = { profile: remote }
              else callbacks.current.apply(remote)
            }
          }
          setStatus('synced')
        } catch (err) {
          if (userRef.current?.id !== who.id) break
          setStatus(failureStatus(navigator.onLine, err instanceof ApiError ? err.status : 0))
          if (step === 'push') callbacks.current.onPushFailed()
          // Try again on the next edit, the `online` event or window focus.
          if (!again.current) break
        }
      } while (again.current)
    } finally {
      running.current = false
    }
  }, [tasteRef])

  /** Call after every local write while signed in (dialog, panel toggle, Spotify import, clear). */
  const edited = useCallback(() => {
    writeSyncMarker(editedMarker(readSyncMarker()))
    held.current = null
    if (userRef.current) void run()
  }, [run])

  useEffect(() => {
    held.current = null
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

  // Keep the open form; apply the pulled profile once the dialog closes.
  useEffect(() => {
    if (holdRemote || !held.current) return
    const { profile } = held.current
    held.current = null
    if (!readSyncMarker()?.pending) callbacks.current.apply(profile)
  }, [holdRemote])

  return { status: state && state.user === user?.id ? state.status : 'synced' as SyncStatus, edited }
}
