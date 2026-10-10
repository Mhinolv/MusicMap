import { useEffect, useState, type FormEvent } from 'react'
import type { TasteProfile } from '../types'
import { TASTE_LIMIT } from '../taste'
import { beginSpotifyImport } from '../spotifyImport'

type Props = {
  profile: TasteProfile
  onSave: (profile: TasteProfile) => void
  onClear: () => void
  onClose: () => void
}

const lines = (values: string[]) => values.join('\n')
const parse = (value: string) => [...new Set(value.split('\n').map((s) => s.trim()).filter(Boolean))].slice(0, TASTE_LIMIT)

export function TastePreferences({ profile, onSave, onClear, onClose }: Props) {
  const [artists, setArtists] = useState(lines(profile.liked_artists))
  const [tracks, setTracks] = useState(lines(profile.liked_tracks))
  const [genres, setGenres] = useState(lines(profile.liked_genres))
  const [disliked, setDisliked] = useState(lines(profile.disliked))
  const [notes, setNotes] = useState(profile.notes)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: TasteProfile = {
      liked_artists: parse(artists).map((s) => s.slice(0, 120)),
      liked_tracks: parse(tracks).map((s) => s.slice(0, 120)),
      liked_genres: parse(genres).map((s) => s.slice(0, 120)),
      disliked: parse(disliked).map((s) => s.slice(0, 120)),
      notes: notes.trim().slice(0, 500),
    }
    if (!(next.liked_artists.length || next.liked_tracks.length || next.liked_genres.length || next.notes)) {
      setError('Add at least one artist, song, genre, or note you like.')
      return
    }
    onSave(next)
  }

  const importSpotify = async () => {
    setImporting(true)
    setError('')
    try {
      await beginSpotifyImport()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Spotify import.')
      setImporting(false)
    }
  }

  return (
    <div className="taste-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="taste-dialog" role="dialog" aria-modal="true" aria-labelledby="taste-title">
        <div className="taste-dialog__head">
          <div>
            <h2 id="taste-title">Your music taste</h2>
            <p>One entry per line. Saved in this browser; sent to JEV only when you check a song or artist.</p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close preferences">×</button>
        </div>
        <div className="taste-import">
          <div>
            <strong>Import from Spotify</strong>
            <p>Copy your top artists and songs into this editable profile. Spotify will ask for read access. Save any manual edits first.</p>
          </div>
          <button className="btn btn--ghost" type="button" onClick={importSpotify} disabled={importing}>
            {importing ? 'Opening Spotify…' : 'Import top music'}
          </button>
        </div>
        <form onSubmit={submit} className="taste-form">
          <label>Artists you like<textarea autoFocus value={artists} onChange={(e) => setArtists(e.target.value)} maxLength={TASTE_LIMIT * 121} rows={3} placeholder={'Radiohead\nPortishead'} /></label>
          <label>Songs you like<textarea value={tracks} onChange={(e) => setTracks(e.target.value)} maxLength={TASTE_LIMIT * 121} rows={2} placeholder={'Glory Box — Portishead'} /></label>
          <label>Genres or sounds you like<textarea value={genres} onChange={(e) => setGenres(e.target.value)} maxLength={TASTE_LIMIT * 121} rows={2} placeholder={'Dream pop\nWarm, layered guitars'} /></label>
          <label>Music you dislike<textarea value={disliked} onChange={(e) => setDisliked(e.target.value)} maxLength={TASTE_LIMIT * 121} rows={2} placeholder={'Harsh vocals'} /></label>
          <label>Anything else<textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} placeholder="I prefer slower songs with atmospheric production." /></label>
          {error && <p className="panel__error" role="alert">{error}</p>}
          <div className="taste-form__actions">
            <button className="btn btn--ghost" type="button" onClick={onClear}>Clear profile</button>
            <button className="btn btn--primary" type="submit">Save preferences</button>
          </div>
        </form>
      </section>
    </div>
  )
}
