import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { Artist, ArtistNode, ArtistRef, PreviewResult, PruneMode, Track, TrackDetails } from '../types'

type Props = {
  node: ArtistNode
  isRoot: boolean
  /** How many artists collapsing / removing this node would take with it (null = not possible). */
  impact: Record<PruneMode, number | null>
  onExpand: (id: string) => void
  onPrune: (id: string, mode: PruneMode) => void
  onClose: () => void
  onTags: (id: string, tags: string[]) => void
  /** Song nodes: start a fresh artist-rooted map from the song's artist. */
  onOpenArtist: (artist: ArtistRef) => void
}

type Details = { artist?: Artist; tracks?: Track[]; error?: string }

function fmt(n?: number | null): string {
  if (n == null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function PruneActions({ node, isRoot, impact, onPrune }: Pick<Props, 'node' | 'isRoot' | 'impact' | 'onPrune'>) {
  const collapse = impact.collapse
  const remove = impact.remove
  if (collapse == null && remove == null) return null
  const unit = node.kind === 'track' ? ['song', 'songs'] : ['artist', 'artists']
  const branch = (n: number) => (n === 0 ? '' : ` · ${n} ${n === 1 ? unit[0] : unit[1]}`)
  return (
    <div className="panel__prune">
      {collapse != null && (
        <button
          className="btn btn--ghost"
          onClick={() => onPrune(node.id, 'collapse')}
          title="Undo this expansion: remove everything explored from here"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M6 3L2.5 6.5 6 10M3 6.5h6a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Collapse{branch(collapse)}
        </button>
      )}
      {remove != null && !isRoot && (
        <button
          className="btn btn--ghost btn--danger"
          onClick={() => onPrune(node.id, 'remove')}
          title="Remove this node and the branch explored from it (Delete)"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M3 4h10M6 4V2.5h4V4M5 4l.6 9h4.8L11 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Remove{branch(remove - 1)}
        </button>
      )}
    </div>
  )
}

function ExpandButton({ node, onExpand }: Pick<Props, 'node' | 'onExpand'>) {
  return (
    <>
      <button className="btn btn--primary" disabled={node.loading || node.expanded} onClick={() => onExpand(node.id)}>
        {node.loading ? (
          <>
            <span className="spinner spinner--sm" /> Expanding…
          </>
        ) : node.expanded ? (
          'Connections expanded'
        ) : (
          'Expand connections'
        )}
      </button>
      {node.error && (
        <div className="panel__error" role="alert">
          {node.error}{' '}
          <button className="link-btn" onClick={() => onExpand(node.id)}>
            Retry
          </button>
        </div>
      )}
    </>
  )
}

function fmtDuration(s?: number | null): string {
  if (s == null) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** "1992-09-21" -> "21 Sep 1992"; partial dates pass through as-is. */
function fmtDate(d?: string | null): string {
  if (!d) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return d
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** Panel for a song node: album, release date, duration, tags, description, preview. */
function TrackPanel({ node, isRoot, impact, onExpand, onPrune, onClose, onOpenArtist }: Omit<Props, 'onTags'>) {
  const [details, setDetails] = useState<TrackDetails | null>(null)
  // undefined = still looking it up, null = unknown.
  const [releaseDate, setReleaseDate] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [state, setState] = useState<'idle' | 'resolving' | 'playing' | 'unavailable'>('idle')
  const audioRef = useRef<HTMLAudioElement>(null)
  const artistName = node.artist?.name ?? ''

  useEffect(() => {
    const ctrl = new AbortController()
    api
      .track(node.id, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return
        setDetails(d)
        setLoading(false)
        if (d.release_date) {
          setReleaseDate(d.release_date)
        } else {
          // MusicBrainz is slow and throttled: let the panel render first, then fill this in.
          api
            .trackReleaseDate(node.id, ctrl.signal)
            .then((date) => !ctrl.signal.aborted && setReleaseDate(date))
            .catch(() => !ctrl.signal.aborted && setReleaseDate(null))
        }
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        setError(
          err instanceof ApiError && err.status === 429
            ? 'Rate limited by the music provider. Try again shortly.'
            : "Couldn't load song details.",
        )
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [node.id])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (state === 'playing' && preview?.preview_url) {
      el.src = preview.preview_url
      el.play().catch(() => setState('idle'))
    } else {
      el.pause()
      el.removeAttribute('src')
    }
  }, [state, preview])

  const toggle = async () => {
    if (state === 'playing') return setState('idle')
    if (preview?.available) return setState('playing')
    setState('resolving')
    try {
      const p = await api.trackPreview(node.id)
      setPreview(p)
      setState(p.available && p.preview_url ? 'playing' : 'unavailable')
    } catch {
      setState('unavailable')
    }
  }

  const links = details?.external_urls
  const q = encodeURIComponent(`${artistName} ${node.name}`)
  const art = details?.album?.image_url ?? preview?.artwork_url

  return (
    <aside className="panel" aria-label={`${node.name} details`}>
      <header className="panel__header">
        <div>
          <div className="panel__kicker">Song</div>
          <h2 className="panel__title">{node.name}</h2>
          <div className="panel__meta">
            by {artistName}
            {node.artist && (
              <>
                {' · '}
                <button className="link-btn" onClick={() => onOpenArtist(node.artist!)} title={`Start a new map from ${artistName}`}>
                  open artist map
                </button>
              </>
            )}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      <div className="panel__actions">
        <ExpandButton node={node} onExpand={onExpand} />
        <PruneActions node={node} isRoot={isRoot} impact={impact} onPrune={onPrune} />
      </div>

      {loading ? (
        <div className="panel__loading">
          <span className="spinner" /> Loading…
        </div>
      ) : error ? (
        <div className="panel__error" role="alert">
          {error}
        </div>
      ) : (
        details && (
          <>
            <section className="panel__section">
              <div className="facts">
                {art && <img className="facts__art" src={art} alt="" width={64} height={64} />}
                <dl className="facts__list">
                  {details.album && (
                    <div>
                      <dt>Album</dt>
                      <dd>{details.album.title}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Released</dt>
                    <dd title={releaseDate ?? undefined}>
                      {releaseDate === undefined ? (
                        <span className="facts__dim">Looking up…</span>
                      ) : releaseDate ? (
                        fmtDate(releaseDate)
                      ) : (
                        <span className="facts__dim">Unknown</span>
                      )}
                    </dd>
                  </div>
                  {details.duration_seconds != null && (
                    <div>
                      <dt>Length</dt>
                      <dd>{fmtDuration(details.duration_seconds)}</dd>
                    </div>
                  )}
                  {details.listeners != null && (
                    <div>
                      <dt>Listeners</dt>
                      <dd>
                        {fmt(details.listeners)}
                        {details.playcount != null && <span className="facts__dim"> · {fmt(details.playcount)} plays</span>}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </section>

            <section className="panel__section">
              <h3>Tags</h3>
              {details.tags.length > 0 ? (
                <ul className="tags">
                  {details.tags.map((t) => (
                    <li key={t} className="tag">
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="panel__empty">No tags listed for this song.</p>
              )}
            </section>

            {details.summary && (
              <section className="panel__section">
                <h3>About</h3>
                <p className="panel__bio">{details.summary}</p>
              </section>
            )}
          </>
        )
      )}

      <section className="panel__section">
        <h3>Preview</h3>
        <div className={`track ${state === 'playing' ? 'is-playing' : ''}`}>
          <button
            className="track__play"
            onClick={toggle}
            disabled={state === 'unavailable' || state === 'resolving'}
            aria-label={state === 'playing' ? `Pause ${node.name}` : `Play preview of ${node.name}`}
            title={state === 'unavailable' ? 'No preview available' : state === 'playing' ? 'Pause' : 'Play 30s preview'}
          >
            {state === 'resolving' ? <span className="spinner spinner--sm" /> : state === 'playing' ? '❚❚' : state === 'unavailable' ? '·' : '▶'}
          </button>
          <span className="track__name">{node.name}</span>
          {state === 'unavailable' && <span className="track__meta">no preview</span>}
        </div>
        {state === 'playing' && preview && (
          <div className="now-playing__meta" style={{ marginTop: 6 }}>
            30s preview · {preview.provider?.replace('_', ' ')}
          </div>
        )}
      </section>

      <section className="panel__section">
        <h3>Open in</h3>
        <div className="links">
          <a href={links?.apple_music ?? `https://music.apple.com/us/search?term=${q}`} target="_blank" rel="noreferrer">
            Apple Music
          </a>
          <a href={links?.spotify ?? `https://open.spotify.com/search/${q}`} target="_blank" rel="noreferrer">
            Spotify
          </a>
          <a href={links?.youtube ?? `https://www.youtube.com/results?search_query=${q}`} target="_blank" rel="noreferrer">
            YouTube
          </a>
        </div>
      </section>
      <audio ref={audioRef} onEnded={() => setState('idle')} onError={() => setState('idle')} preload="none" />
    </aside>
  )
}

export function ArtistPanel(props: Props) {
  if (props.node.kind === 'track') return <TrackPanel key={props.node.id} {...props} />
  return <ArtistDetails {...props} />
}

function ArtistDetails({ node, isRoot, impact, onExpand, onPrune, onClose, onTags }: Omit<Props, 'onOpenArtist'>) {
  const [details, setDetails] = useState<Details>({})
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState<{ track: string; preview: PreviewResult } | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setDetails({})
    setPlaying(null)
    setUnavailable(new Set())
    Promise.allSettled([api.artist(node.id, ctrl.signal), api.tracks(node.id, 5, ctrl.signal)]).then(
      ([a, t]) => {
        if (ctrl.signal.aborted) return
        const next: Details = {}
        if (a.status === 'fulfilled') {
          next.artist = a.value
          onTags(node.id, a.value.tags)
        }
        if (t.status === 'fulfilled') next.tracks = t.value
        if (a.status === 'rejected' && t.status === 'rejected') {
          const err = a.reason
          next.error =
            err instanceof ApiError && err.status === 429
              ? 'Rate limited by the music provider. Try again shortly.'
              : "Couldn't load artist details."
        }
        setDetails(next)
        setLoading(false)
      },
    )
    return () => ctrl.abort()
  }, [node.id, onTags])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (playing?.preview.preview_url) {
      el.src = playing.preview.preview_url
      el.play().catch(() => setPlaying(null))
    } else {
      el.pause()
      el.removeAttribute('src')
    }
  }, [playing])

  const togglePreview = async (track: Track) => {
    if (playing?.track === track.name) {
      setPlaying(null)
      return
    }
    setResolving(track.name)
    try {
      const preview = await api.preview(node.id, track.name)
      if (preview.available && preview.preview_url) {
        setPlaying({ track: track.name, preview })
      } else {
        setUnavailable((s) => new Set(s).add(track.name))
      }
    } catch {
      setUnavailable((s) => new Set(s).add(track.name))
    } finally {
      setResolving(null)
    }
  }

  const artist = details.artist
  const name = artist?.name ?? node.name
  const links = artist?.external_urls
  const q = encodeURIComponent(name)

  return (
    <aside className="panel" aria-label={`${name} details`}>
      <header className="panel__header">
        <div>
          <h2 className="panel__title">{name}</h2>
          {artist?.listeners != null && <div className="panel__meta">{fmt(artist.listeners)} listeners on Last.fm</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      <div className="panel__actions">
        <ExpandButton node={node} onExpand={onExpand} />
        <PruneActions node={node} isRoot={isRoot} impact={impact} onPrune={onPrune} />
      </div>

      {loading ? (
        <div className="panel__loading">
          <span className="spinner" /> Loading…
        </div>
      ) : details.error ? (
        <div className="panel__error" role="alert">
          {details.error}
        </div>
      ) : (
        <>
          {artist && (
            <section className="panel__section">
              <h3>Tags</h3>
              {artist.tags.length > 0 ? (
                <ul className="tags">
                  {artist.tags.map((t) => (
                    <li key={t} className="tag">
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="panel__empty">No tags listed for this artist.</p>
              )}
            </section>
          )}

          {artist?.summary && (
            <section className="panel__section">
              <h3>Profile</h3>
              <p className="panel__bio">{artist.summary}</p>
            </section>
          )}

          {details.tracks && details.tracks.length > 0 && (
            <section className="panel__section">
              <h3>Top tracks</h3>
              <ul className="tracks">
                {details.tracks.map((t) => {
                  const isPlaying = playing?.track === t.name
                  const noPreview = unavailable.has(t.name)
                  return (
                    <li key={t.name} className={`track ${isPlaying ? 'is-playing' : ''}`}>
                      <button
                        className="track__play"
                        onClick={() => togglePreview(t)}
                        disabled={noPreview || resolving === t.name}
                        aria-label={isPlaying ? `Pause ${t.name}` : `Play preview of ${t.name}`}
                        title={noPreview ? 'No preview available' : isPlaying ? 'Pause' : 'Play 30s preview'}
                      >
                        {resolving === t.name ? <span className="spinner spinner--sm" /> : isPlaying ? '❚❚' : noPreview ? '·' : '▶'}
                      </button>
                      <span className="track__name">{t.name}</span>
                      {t.listeners != null && <span className="track__meta">{fmt(t.listeners)}</span>}
                    </li>
                  )
                })}
              </ul>
              {playing && (
                <div className="now-playing">
                  {playing.preview.artwork_url && <img src={playing.preview.artwork_url} alt="" width={40} height={40} />}
                  <div>
                    <div className="now-playing__title">{playing.track}</div>
                    <div className="now-playing__meta">30s preview · {playing.preview.provider?.replace('_', ' ')}</div>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="panel__section">
            <h3>Open in</h3>
            <div className="links">
              <a href={links?.apple_music ?? `https://music.apple.com/us/search?term=${q}`} target="_blank" rel="noreferrer">
                Apple Music
              </a>
              <a href={links?.spotify ?? `https://open.spotify.com/search/${q}`} target="_blank" rel="noreferrer">
                Spotify
              </a>
              <a href={links?.youtube ?? `https://www.youtube.com/results?search_query=${q}`} target="_blank" rel="noreferrer">
                YouTube
              </a>
            </div>
          </section>
        </>
      )}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} onError={() => setPlaying(null)} preload="none" />
    </aside>
  )
}
