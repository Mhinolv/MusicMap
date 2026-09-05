import { useEffect, useId, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { ArtistRef, TrackRef } from '../types'

export type SearchMode = 'artist' | 'song'

type Result = { kind: 'artist'; id: string; artist: ArtistRef } | { kind: 'track'; id: string; track: TrackRef }

type Props = {
  onSelect: (artist: ArtistRef) => void
  onSelectTrack: (track: TrackRef) => void
  mode: SearchMode
  onModeChange: (mode: SearchMode) => void
  compact?: boolean
  autoFocus?: boolean
}

export function SearchBar({ onSelect, onSelectTrack, mode, onModeChange, compact = false, autoFocus = false }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const abortRef = useRef<AbortController | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const q = query.trim()
    abortRef.current?.abort()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const found: Result[] =
          mode === 'song'
            ? (await api.searchTracks(q, ctrl.signal)).map((track) => ({ kind: 'track', id: track.id, track }))
            : (await api.search(q, ctrl.signal)).map((artist) => ({ kind: 'artist', id: artist.id, artist }))
        if (ctrl.signal.aborted) return
        setResults(found)
        setActive(0)
        setOpen(true)
        setError(null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setResults([])
        setError(
          err instanceof ApiError && err.status === 503
            ? 'Backend is missing an API key. See README.'
            : "Couldn't search right now. Try again.",
        )
        setOpen(true)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [query, mode])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (r: Result) => {
    if (r.kind === 'artist') onSelect(r.artist)
    else onSelectTrack(r.track)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  const switchMode = (next: SearchMode) => {
    if (next === mode) return
    onModeChange(next)
    setResults([])
    setOpen(false)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Tab flips between artist and song search without leaving the field.
    if (e.key === 'Tab' && !e.shiftKey && query.trim().length === 0) {
      e.preventDefault()
      switchMode(mode === 'artist' ? 'song' : 'artist')
      return
    }
    if (!open || results.length === 0) {
      if (e.key === 'Escape') setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className={`search ${compact ? 'search--compact' : ''}`}>
      <div className="search__field">
        <svg className="search__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={mode === 'song' ? 'Search for a song' : 'Search for an artist'}
          aria-activedescendant={open && results.length > 0 ? `${listId}-${active}` : undefined}
          placeholder={mode === 'song' ? 'Search for a song…' : 'Search for an artist…'}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <span className="spinner spinner--sm" aria-label="Searching" />}
        <div className="search__mode" role="radiogroup" aria-label="Search by">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'artist'}
            className={mode === 'artist' ? 'is-on' : ''}
            onClick={() => switchMode('artist')}
          >
            Artist
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'song'}
            className={mode === 'song' ? 'is-on' : ''}
            onClick={() => switchMode('song')}
          >
            Song
          </button>
        </div>
      </div>
      {open && (results.length > 0 || error) && (
        <ul id={listId} role="listbox" className="search__results">
          {error && <li className="search__error">{error}</li>}
          {results.map((r, i) => (
            <li
              key={r.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search__item ${i === active ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(r)}
            >
              {r.kind === 'artist' ? (
                <span className="search__name">{r.artist.name}</span>
              ) : (
                <>
                  <span className="search__name">
                    <span className="search__glyph" aria-hidden="true">
                      ♪
                    </span>
                    {r.track.name}
                  </span>
                  <span className="search__sub">{r.track.artist.name}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
