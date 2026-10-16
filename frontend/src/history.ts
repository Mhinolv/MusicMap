// Map session history (#77): the last 5 maps, kept on this device and, when signed in, in the account.
import { decodeMap, MAP_STORAGE_KEY, type SavedMap } from './graph/mapSnapshot'
import { savedWhen } from './startScreen'
import type { MusicGraph } from './types'

export const HISTORY_STORAGE_KEY = 'tunegraph:history:v1'
export const HISTORY_LIMIT = 5
/** `map` is the `tunegraph:map:v1` JSON text. `pending` marks a signed-in save the cloud has not confirmed. */
export type MapSession = { id: string; seed: string; mode: 'artist' | 'track'; stops: number; updatedAt: number; map: string; pending?: boolean }
/** Cloud list rows carry no map; the client fetches each map by id. */
export type SessionMeta = { id: string; seed: string; mode: 'artist' | 'track'; stops: number; updated_at: number }
export type HistoryStatus = 'local' | 'loading' | 'synced' | 'failed'

export const HISTORY_EMPTY = 'No maps yet. Search an artist or song to start one.'
export const HISTORY_LOADING = 'Loading history…'
export const HISTORY_FAILED = "Couldn't load history. Showing maps from this device."
export const HISTORY_BAD_MAP = "Couldn't restore this map."
const LEGACY_SEED = 'Last map'
export const historyNote = (signedIn: boolean) =>
  `${signedIn ? 'Synced to your account.' : 'Kept on this device.'} The last 5 maps save on their own.`

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

export const newSessionId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const newestFirst = (sessions: MapSession[]) => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

function decodeSession(v: unknown): MapSession | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (typeof s.id !== 'string' || !SESSION_ID.test(s.id) || typeof s.seed !== 'string' || !s.seed.trim()
    || (s.mode !== 'artist' && s.mode !== 'track') || typeof s.map !== 'string') return null
  return {
    id: s.id, seed: s.seed, mode: s.mode === 'track' ? 'track' : 'artist', map: s.map,
    stops: typeof s.stops === 'number' && Number.isInteger(s.stops) && s.stops >= 0 ? s.stops : 0,
    updatedAt: typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) && s.updatedAt >= 0 ? s.updatedAt : 0,
    ...(s.pending === true ? { pending: true } : {}),
  }
}

/** Skip corrupt rows and keep rows whose map is bad, so the list can say it couldn't restore them. */
export function decodeHistory(raw: string | null): MapSession[] {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value?.version !== 1 || !Array.isArray(value.sessions)) return []
    const seen = new Set<string>()
    const sessions: MapSession[] = []
    for (const v of value.sessions) {
      const session = decodeSession(v)
      if (!session || seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
    }
    return newestFirst(sessions).slice(0, HISTORY_LIMIT)
  } catch { return [] }
}

const rootOf = (map: string) => {
  const saved = decodeMap(map)
  return saved.status === 'ready' ? saved.snapshot.graph.rootId : undefined
}

/**
 * Fold the single-map save (`tunegraph:map:v1`, #5) into the list. A legacy map becomes the newest
 * session. A newer copy of the newest session's map replaces it, so an interrupted history write loses nothing.
 */
export function foldLegacyMap(sessions: MapSession[], raw: string | null, now = Date.now()): MapSession[] {
  if (raw === null || sessions[0]?.map === raw) return sessions
  const saved = decodeMap(raw)
  // With no history yet, a damaged map still shows as "couldn't be restored", as before #77.
  if (saved.status !== 'ready') return sessions.length ? sessions
    : [{ id: newSessionId(), seed: LEGACY_SEED, mode: 'artist', stops: 0, updatedAt: now, map: raw }]
  const graph = saved.snapshot.graph
  const latest = sessions[0]
  if (latest && rootOf(latest.map) === graph.rootId) return [{ ...latest, map: raw, stops: graph.journey.length }, ...sessions.slice(1)]
  return upsertSession(sessions, sessionFromGraph(newSessionId(), graph, raw, now))
}

/** Reads the list; a folded legacy map is written back so its session id stays the same. */
export function readHistory(): MapSession[] {
  try {
    const stored = decodeHistory(localStorage.getItem(HISTORY_STORAGE_KEY))
    const sessions = foldLegacyMap(stored, localStorage.getItem(MAP_STORAGE_KEY))
    if (sessions !== stored) writeHistory(sessions)
    return sessions
  } catch { return [] }
}

/** If storage is full, drop the oldest maps until the rest fit. */
export function writeHistory(sessions: MapSession[]): boolean {
  try {
    if (!sessions.length) { localStorage.removeItem(HISTORY_STORAGE_KEY); return true }
  } catch { return false }
  for (let keep = sessions.length; keep > 0; keep--) {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, sessions: sessions.slice(0, keep) }))
      return true
    } catch { /* Quota: try with one map fewer. */ }
  }
  return false
}

export function sessionFromGraph(id: string, graph: MusicGraph, map: string, updatedAt = Date.now()): MapSession {
  const root = graph.rootId ? graph.nodes.get(graph.rootId) : undefined
  return { id, seed: root?.name ?? '', mode: root?.kind === 'track' ? 'track' : 'artist', stops: graph.journey.length, updatedAt, map }
}

/** Add or replace by id, newest first, at most 5: the oldest drops first. */
export function upsertSession(sessions: MapSession[], session: MapSession): MapSession[] {
  return newestFirst([session, ...sessions.filter((s) => s.id !== session.id)]).slice(0, HISTORY_LIMIT)
}

/** Union by id where the newer copy wins; used for sign-in merges and cloud pulls. */
export function mergeSessions(a: MapSession[], b: MapSession[]): MapSession[] {
  const byId = new Map<string, MapSession>()
  for (const s of [...a, ...b]) {
    const have = byId.get(s.id)
    if (!have || s.updatedAt > have.updatedAt) byId.set(s.id, s)
  }
  return newestFirst([...byId.values()]).slice(0, HISTORY_LIMIT)
}

/** Undo puts removed maps back, keeps later saves, and never goes over 5. */
export function restoreSessions(sessions: MapSession[], removed: MapSession[]): MapSession[] {
  const ids = new Set(sessions.map((s) => s.id))
  return newestFirst([...sessions, ...removed.filter((s) => !ids.has(s.id))]).slice(0, HISTORY_LIMIT)
}

/** History row time: `today, 14:32` on the same day, else the Library age words. */
export function historyWhen(updatedAt: number, now = Date.now()): string {
  const when = savedWhen(updatedAt, now)
  if (when !== 'today') return when
  const d = new Date(updatedAt)
  return `today, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const historySub = (session: MapSession, now = Date.now()) =>
  [session.mode === 'track' ? 'Song' : 'Artist', `${session.stops} ${session.stops === 1 ? 'stop' : 'stops'}`, historyWhen(session.updatedAt, now)]
    .filter(Boolean).join(' · ')

// Decoding a 1 MB map is not free, and history changes on every autosave: remember recent results.
const decoded = new Map<string, SavedMap>()
// One shared object, so an empty history gives the start screen the same savedMap on every render.
const NO_SESSION: SavedMap = { status: 'none' }
export function sessionMap(session: MapSession | undefined): SavedMap {
  if (!session) return NO_SESSION
  const key = `${session.id}@${session.updatedAt}@${session.map.length}`
  let saved = decoded.get(key)
  if (!saved) {
    saved = session.map ? decodeMap(session.map) : { status: 'invalid' }
    decoded.set(key, saved)
    if (decoded.size > HISTORY_LIMIT * 2) decoded.delete(decoded.keys().next().value!)
  }
  return saved
}

export const metaOf = (s: MapSession): SessionMeta => ({ id: s.id, seed: s.seed, mode: s.mode, stops: s.stops, updated_at: s.updatedAt })

/**
 * Cloud list → sessions. A local copy at least as new keeps its map; other maps come from `fetchMap`.
 * A map that fails to load stays as a row with no map, which the list shows as not restorable.
 */
export async function pullSessions(list: SessionMeta[], local: MapSession[], fetchMap: (id: string) => Promise<string>): Promise<MapSession[]> {
  const sessions = await Promise.all(list.slice(0, HISTORY_LIMIT).map(async (meta) => {
    const have = local.find((s) => s.id === meta.id)
    const base = { id: meta.id, seed: meta.seed, mode: meta.mode, stops: meta.stops, updatedAt: meta.updated_at }
    if (have?.map && have.updatedAt >= meta.updated_at) return { ...base, updatedAt: have.updatedAt, map: have.map }
    const map = await fetchMap(meta.id).catch(() => have?.map ?? '')
    return { ...base, map }
  }))
  return newestFirst(sessions)
}
