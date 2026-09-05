import type { Artist, ArtistRef, PreviewResult, SimilarArtist, SimilarTrack, Track, TrackDetails, TrackRef } from './types'

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

  trackSimilar: (id: string, limit = 7, signal?: AbortSignal) =>
    get<{ track: TrackRef | null; tracks: SimilarTrack[] }>(`/api/tracks/${enc(id)}/similar?limit=${limit}`, signal),

  trackReleaseDate: (id: string, signal?: AbortSignal) =>
    get<{ release_date: string | null }>(`/api/tracks/${enc(id)}/release-date`, signal).then((r) => r.release_date),

  trackPreview: (id: string, signal?: AbortSignal) => get<PreviewResult>(`/api/tracks/${enc(id)}/preview`, signal),
}
