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
  /** Start screen layout: FIND box, mode switch and a MAP IT button outside the field. */
  start?: boolean
  /** MAP IT is the screen's one amber primary unless a resumable map is offered. */
  primary?: boolean
}

export function SearchBar({ onSelect, onSelectTrack, mode, onModeChange, compact = false, autoFocus = false, start = false, primary = false }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // MAP IT or Enter before suggestions arrive picks the first one when they do.
  const pendingPick = useRef(false)
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
      pendingPick.current = false
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
        if (pendingPick.current && found.length) {
          pendingPick.current = false
          choose(found[0])
          return
        }
        pendingPick.current = false
        setResults(found)
        setActive(0)
        setOpen(true)
        setError(null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        pendingPick.current = false
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

  /** The same pick as Enter: the highlighted (by default the first) suggestion for the current text. */
  const mapIt = () => {
    if (loading) pendingPick.current = true
    else if (results.length) choose(results[active] ?? results[0])
    else inputRef.current?.focus()
  }

  const switchMode = (next: SearchMode) => {
    if (next === mode) return
    pendingPick.current = false
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
      if (e.key === 'Enter' && start) {
        e.preventDefault()
        mapIt()
      }
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

  const modeSwitch = (
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
  )
  const field = (
    <div className="search__field">
      {compact && <span className="search__find" aria-hidden="true">Find</span>}
      {start && <label className="search__label" htmlFor={`${listId}-input`}>Find</label>}
      <svg className="search__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        id={`${listId}-input`}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={mode === 'song' ? 'Search for a song' : 'Search for an artist'}
        aria-activedescendant={open && results.length > 0 ? `${listId}-${active}` : undefined}
        placeholder={compact || start ? (mode === 'song' ? 'song title or artist' : 'artist name') : (mode === 'song' ? 'Search for a song…' : 'Search for an artist…')}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {loading && <span className="spinner spinner--sm" aria-label="Searching" />}
      {!start && modeSwitch}
    </div>
  )
  const list = open && (results.length > 0 || error) && (
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
  )

  if (start) {
    return (
      <div ref={wrapRef} className="search search--start">
        <div className="search__anchor">{field}{list}</div>
        {modeSwitch}
        <button type="button" className={`btn search__map-it ${primary ? 'btn--primary' : ''}`} onClick={mapIt}>Map it</button>
      </div>
    )
  }
  return (
    <div ref={wrapRef} className={`search ${compact ? 'search--compact' : ''}`}>
      {field}
      {list}
    </div>
  )
}
