import type { MapSession, SessionMeta } from './history'
import type { Bookmark } from './bookmarks'
import type { ExcludedSong } from './exclusions'
import type { LibraryList } from './librarySync'
import type { Artist, ArtistRef, AuthConfig, AuthUser, PreviewResult, SimilarArtist, SimilarTrack, TasteConnections, TasteEvaluation, TasteMerge, TasteProfile, TasteSteer, Track,TrackDetails, TrackRankingContext, TrackRef } from './types'

export class ApiError extends Error {
  status: number
  retryAfter?: number
  constructor(message: string, status: number, retryAfter?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError('Network error', 0)
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    let retryAfter: number | undefined
    try {
      const body = await res.json()
      if (body?.error) message = body.error
      if (typeof body?.retry_after === 'number') retryAfter = body.retry_after
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, retryAfter)
  }
  return (await res.json()) as T
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError('Network error', 0)
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    let retryAfter: number | undefined
    try {
      const response = await res.json()
      if (response?.error) message = response.error
      if (typeof response?.retry_after === 'number') retryAfter = response.retry_after
    } catch { /* non-JSON error body */ }
    throw new ApiError(message, res.status, retryAfter)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const api = {
  search: (q: string, signal?: AbortSignal) =>
    get<{ artists: ArtistRef[] }>(`/api/artists/search?q=${enc(q)}&limit=8`, signal).then((r) => r.artists),

  artist: (id: string, signal?: AbortSignal) => get<Artist>(`/api/artists/${enc(id)}`, signal),

  similar: (id: string, limit = 7, signal?: AbortSignal) =>
    get<{ artists: SimilarArtist[] }>(`/api/artists/${enc(id)}/similar?limit=${limit}`, signal).then(
      (r) => r.artists,
    ),

  tracks: (id: string, limit = 5, signal?: AbortSignal) =>
    get<{ tracks: Track[] }>(`/api/artists/${enc(id)}/tracks?limit=${limit}`, signal).then((r) => r.tracks),

  preview: (id: string, track: string, signal?: AbortSignal) =>
    get<PreviewResult>(`/api/artists/${enc(id)}/tracks/${enc(track)}/preview`, signal),

  // ---- songs (song-seeded maps) ----
  searchTracks: (q: string, signal?: AbortSignal) =>
    get<{ tracks: TrackRef[] }>(`/api/tracks/search?q=${enc(q)}&limit=8`, signal).then((r) => r.tracks),

  track: (id: string, signal?: AbortSignal) => get<TrackDetails>(`/api/tracks/${enc(id)}`, signal),

  trackSimilar: (id: string, limit = 7, signal?: AbortSignal, trail?: string[], excluded?: string[], emphasizedTags?: string[]) => {
    const query = new URLSearchParams({ limit: String(limit) })
    trail?.forEach((stop) => query.append('trail', stop))
    excluded?.forEach((id) => query.append('excluded', id))
    emphasizedTags?.forEach((tag) => query.append('emphasized_tags', tag))
    return get<{ track: TrackRef | null; tracks: SimilarTrack[]; excluded_count: number; ranking: TrackRankingContext }>(
      `/api/tracks/${enc(id)}/similar?${query}`, signal,
    )
  },

  trackReleaseDate: (id: string, signal?: AbortSignal) =>
    get<{ release_date: string | null }>(`/api/tracks/${enc(id)}/release-date`, signal).then((r) => r.release_date),

  trackPreview: (id: string, signal?: AbortSignal) => get<PreviewResult>(`/api/tracks/${enc(id)}/preview`, signal),

  tasteEvaluate: (kind: 'artist' | 'track', itemId: string, profile: TasteProfile, signal?: AbortSignal) =>
    post<TasteEvaluation>('/api/taste/evaluate', { kind, item_id: itemId, profile }, signal),

  tasteConnections: (itemIds: string[], profile: TasteProfile, signal?: AbortSignal) =>
    post<TasteConnections>('/api/taste/connections/evaluate', { item_ids: itemIds, profile }, signal),

  tasteSteer: (itemId: string, text: string, tags: string[], signal?: AbortSignal) =>
    post<TasteSteer>('/api/taste/steer-tags', { item_id: itemId, text, tags }, signal),

  spotifyConfig: () => get<{ client_id: string }>('/api/spotify/config'),

  // ---- account (#75): the HttpOnly session cookie rides along on same-origin requests ----
  authConfig: () => get<AuthConfig>('/api/auth/config'),
  authMe: (signal?: AbortSignal) => get<{ user: AuthUser }>('/api/auth/me', signal).then((r) => r.user),
  authGoogle: (credential: string) => post<{ user: AuthUser }>('/api/auth/google', { credential }).then((r) => r.user),
  authMock: () => post<{ user: AuthUser }>('/api/auth/mock', {}).then((r) => r.user),
  authSignOut: () => post<{ ok: boolean }>('/api/auth/signout', {}),

  // ---- account copy of the taste profile (#76); null means no profile ----
  userTaste: (signal?: AbortSignal) => get<{ profile: TasteProfile | null }>('/api/user/taste', signal).then((r) => r.profile),
  putUserTaste: (profile: TasteProfile | null) =>
    post<{ profile: TasteProfile | null }>('/api/user/taste', profile ?? {}, undefined, 'PUT').then((r) => r.profile),
  mergeUserTaste: (profile: TasteProfile | null) => post<TasteMerge>('/api/user/taste/merge', profile ?? {}),

  // ---- map session history (#77): signed-in users only; signed-out history stays in the browser ----
  historyList: (signal?: AbortSignal) => get<{ sessions: SessionMeta[] }>('/api/history', signal).then((r) => r.sessions),
  historyGet: (id: string) => get<SessionMeta & { map: string }>(`/api/history/${enc(id)}`).then((r) => r.map),
  historySave: (session: MapSession) =>
    post<{ sessions: SessionMeta[] }>(`/api/history/${enc(session.id)}`, { seed: session.seed, mode: session.mode, stops: session.stops, updated_at: session.updatedAt, map: session.map }, undefined, 'PUT'),
  historyDelete: (id: string) => post<{ sessions: SessionMeta[] }>(`/api/history/${enc(id)}`, {}, undefined, 'DELETE'),
  historyClear: () => post<{ sessions: SessionMeta[] }>('/api/history', {}, undefined, 'DELETE'),

  // ---- Library lists (#79): signed-in users only; the payloads match the local storage shape.
  // Answers are raw: useLibrarySync decodes them with the tolerant local decoders.
  userLibrary: () => get<unknown>('/api/user/library'),
  putUserBookmarks: (items: Bookmark[]) => post<unknown>('/api/user/library/bookmarks', { version: 1, items }, undefined, 'PUT'),
  putUserExclusions: (items: ExcludedSong[]) => post<unknown>('/api/user/library/exclusions', { version: 1, items }, undefined, 'PUT'),
  mergeUserLibrary: (bookmarks: Bookmark[], exclusions: ExcludedSong[]) =>
    post<{ added?: number; capped?: LibraryList[] }>('/api/user/library/merge', { bookmarks: { version: 1, items: bookmarks }, exclusions: { version: 1, items: exclusions } }),
}
