/** One-time Spotify PKCE import. Tokens are kept only in this function's memory. */

import { api } from './api'
import { TASTE_LIMIT } from './taste'
import type { TasteProfile } from './types'

const PENDING_KEY = 'tunegraph:spotify-pkce'
const CALLBACK_PATH = '/spotify/callback'

type Pending = { verifier: string; state: string }
type SpotifyArtist = { name: string }
type SpotifyTrack = { name: string; artists: SpotifyArtist[] }

function randomText(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (v) => alphabet[v % alphabet.length]).join('')
}

function callbackUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export async function beginSpotifyImport(): Promise<void> {
  const { client_id } = await api.spotifyConfig()
  const pending: Pending = { verifier: randomText(64), state: randomText(32) }
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  const url = new URL('https://accounts.spotify.com/authorize')
  url.search = new URLSearchParams({
    client_id,
    response_type: 'code',
    redirect_uri: callbackUri(),
    scope: 'user-top-read',
    state: pending.state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(pending.verifier),
  }).toString()
  window.location.assign(url.toString())
}

function names(items: string[], existing: string[]): string[] {
  const seen = new Set<string>()
  return [...existing, ...items].filter((name) => {
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, TASTE_LIMIT)
}

async function topItems<T>(token: string, type: 'artists' | 'tracks'): Promise<T[]> {
  const url = new URL(`https://api.spotify.com/v1/me/top/${type}`)
  url.search = new URLSearchParams({ time_range: 'medium_term', limit: '15' }).toString()
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(response.status === 403
    ? 'Spotify denied access. Check your app’s development-mode user allowlist.'
    : `Spotify could not return your top ${type} (${response.status}).`)
  const body = await response.json()
  return Array.isArray(body.items) ? body.items as T[] : []
}

export async function finishSpotifyImport(current: TasteProfile | null): Promise<TasteProfile | null> {
  if (window.location.pathname !== CALLBACK_PATH) return null
  const params = new URLSearchParams(window.location.search)
  // Remove the one-use authorization code from browser history immediately.
  window.history.replaceState({}, '', '/')
  const raw = sessionStorage.getItem(PENDING_KEY)
  sessionStorage.removeItem(PENDING_KEY)
  if (!raw) throw new Error('Spotify sign-in expired. Please start the import again.')
  const pending = JSON.parse(raw) as Pending
  if (!pending.state || pending.state !== params.get('state')) {
    throw new Error('Spotify sign-in could not be verified. Please try again.')
  }
  if (params.get('error')) throw new Error('Spotify access was not granted.')
  const code = params.get('code')
  if (!code) throw new Error('Spotify did not return an authorization code.')

  const { client_id } = await api.spotifyConfig()
  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUri(),
      code_verifier: pending.verifier,
    }),
  })
  if (!tokenResponse.ok) throw new Error(`Spotify sign-in failed (${tokenResponse.status}). Check the registered redirect URI.`)
  const tokenBody = await tokenResponse.json()
  if (typeof tokenBody.access_token !== 'string') throw new Error('Spotify did not return an access token.')
  const [artists, tracks] = await Promise.all([
    topItems<SpotifyArtist>(tokenBody.access_token, 'artists'),
    topItems<SpotifyTrack>(tokenBody.access_token, 'tracks'),
  ])
  if (!artists.length && !tracks.length) throw new Error('Spotify has no top artists or tracks available for this account yet.')

  const previous = current ?? { liked_artists: [], liked_tracks: [], liked_genres: [], disliked: [], notes: '' }
  return {
    ...previous,
    liked_artists: names(artists.map((artist) => artist.name).filter(Boolean), previous.liked_artists),
    liked_tracks: names(tracks.map((track) => `${track.name} — ${track.artists?.[0]?.name ?? 'Unknown artist'}`), previous.liked_tracks),
  }
}
