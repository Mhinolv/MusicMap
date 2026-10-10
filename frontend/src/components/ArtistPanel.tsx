import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api'
import { TasteCheck } from './TasteCheck'
import { ConnectionsCheck } from './ConnectionsCheck'
import { SteerWords } from './SteerWords'
import type { ConnectionItem } from '../connections'
import { matchText, type MatchFact } from '../graph/onMap'
import type { Artist, ArtistNode, ArtistRef, ExternalUrls, PreviewResult, PruneMode, TasteProfile, Track, TrackDetails } from '../types'

type Props = {
  emphasizedTags?: string[]
  onEmphasizedTags?: (tags: string[]) => void
  followJourney?: boolean
  journeyStops?: number
  node: ArtistNode
  isRoot: boolean
  /** Two-digit journey stop number (`02`); only journey stops have one. */
  stop?: string
  /** MATCH / SHARED facts: the edge to the node this one was expanded from. */
  match?: MatchFact | null
  /** How many artists collapsing / removing this node would take with it (null = not possible). */
  impact: Record<PruneMode, number | null>
  onExpand: (id: string) => void
  onPrune: (id: string, mode: PruneMode) => void
  onClose: () => void
  onTags: (id: string, tags: string[]) => void
  /** Song nodes: start a fresh artist-rooted map from the song's artist. */
  onOpenArtist: (artist: ArtistRef) => void
  /** The YOUR TASTE add / not-my-taste controls (#27). */
  tasteActions: ReactNode
  taste: TasteProfile | null
  onEditTaste: () => void
  excluded: boolean
  onToggleExclusion: () => void
  saved: boolean
  onToggleSave: () => void
  /** Song nodes: the expansion's surviving children, for "Check these connections". */
  connections?: ConnectionItem[]
  onSelectNode?: (id: string) => void
  /** Changes on map reset/restore so per-map panel state never carries over. */
  mapKey?: number
}

type Details = { artist?: Artist; tracks?: Track[]; error?: string }

const MAX_STEERING = 3

type ShellProps = { label: string; kind: ArtistNode['kind']; stop?: string; onClose: () => void; children: ReactNode }

/** The inspector chrome (#32): a fixed head and a scrolling body of sections.
 *  The desktop dock and the INSPECTOR tab of the phone sheet (#34) both use it. */
function PanelShell({ label, kind, stop, onClose, children }: ShellProps) {
  return (
    <aside className="panel" aria-label={label}>
      <div className="panel__head">
        <span className="panel__head-label">Inspector · {kind === 'track' ? 'Song' : 'Artist'}{stop && ` · Stop ${stop}`}</span>
        <button type="button" className="panel__close" onClick={onClose} aria-label="Close inspector">×</button>
      </div>
      <div className="panel__body">{children}</div>
    </aside>
  )
}

function fmt(n?: number | null): string {
  if (n == null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function SaveActions({ node, saved, onToggleSave, excluded, onToggleExclusion }: Pick<Props, 'node' | 'saved' | 'onToggleSave' | 'excluded' | 'onToggleExclusion'>) {
  return (
    <div className={`panel__section panel__save${node.kind === 'track' ? ' panel__save--pair' : ''}`}>
      {/* #21: the saved state is amber text and border; hover only adds a background. */}
      <button type="button" className="btn save-toggle" aria-pressed={saved} onClick={onToggleSave} title={saved ? 'Saved: click to remove' : 'Save'}>
        {saved ? 'Saved' : 'Save'}
      </button>
      {node.kind === 'track' && (
        <button type="button" className="btn exclusion-toggle" aria-pressed={excluded} onClick={onToggleExclusion}>
          {excluded ? 'Suggest again' : "Don't suggest again"}
        </button>
      )}
    </div>
  )
}

function PruneActions({ node, isRoot, impact, onPrune }: Pick<Props, 'node' | 'isRoot' | 'impact' | 'onPrune'>) {
  const collapse = impact.collapse
  const remove = impact.remove
  if (collapse == null && (remove == null || isRoot)) return null
  return (
    <section className="panel__section" aria-labelledby={`branch-${node.id}`}>
      <h3 id={`branch-${node.id}`}>Branch</h3>
      <div className="panel__prune">
        {collapse != null && (
          <button className="btn" onClick={() => onPrune(node.id, 'collapse')} title="Undo this expansion: remove everything explored from here">
            Collapse · {collapse}
          </button>
        )}
        {remove != null && !isRoot && (
          <button className="btn btn--danger" onClick={() => onPrune(node.id, 'remove')} title="Remove this node and the branch explored from it (Delete)">
            Remove · {remove - 1}
          </button>
        )}
      </div>
    </section>
  )
}

function ExpandButton({ node, onExpand, steering = 0 }: Pick<Props, 'node' | 'onExpand'> & { steering?: number }) {
  return (
    <>
      <button className={`btn btn--primary panel__expand${node.expanded ? ' is-expanded' : ''}`} disabled={node.loading || node.expanded} onClick={() => onExpand(node.id)}>
        {node.loading ? (
          <>
            <span className="spinner spinner--sm" /> Expanding…
          </>
        ) : node.expanded ? (
          'Expanded'
        ) : steering > 0 ? (
          `Expand · ${steering} ${steering === 1 ? 'tag' : 'tags'}`
        ) : (
          'Expand'
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

function OpenIn({ links, q }: { links?: ExternalUrls; q: string }) {
  return (
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
  )
}

/** Roughly six lines of 12px mono in the 360px dock; shorter text needs no More link. */
const CLAMP_CHARS = 260

/** Long text clamped to six lines with a More / Less toggle. */
function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > CLAMP_CHARS
  return (
    <>
      <p className={`panel__bio${long && !open ? ' is-clamped' : ''}`}>{text}</p>
      {long && <button type="button" className="link-btn panel__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'More'}</button>}
    </>
  )
}

function fmtDuration(s?: number | null): string {
  if (s == null) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/** "1992-09-21" -> "21 Sep 1992"; partial dates pass through as-is. */
function fmtDate(d?: string | null): string {
  if (!d) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return d
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** The 32px amber-outline play button shared by the song preview row and artist top tracks. */
function PlayButton({ name, state, onClick }: { name: string; state: 'idle' | 'resolving' | 'playing' | 'unavailable'; onClick: () => void }) {
  return (
    <button
      type="button"
      className="track__play"
      onClick={onClick}
      disabled={state === 'unavailable' || state === 'resolving'}
      aria-label={state === 'playing' ? `Pause ${name}` : `Play preview of ${name}`}
      title={state === 'unavailable' ? 'No preview available' : state === 'playing' ? 'Pause' : 'Play 30s preview'}
    >
      {state === 'resolving' ? <span className="spinner spinner--sm" /> : state === 'playing' ? '❚❚' : '▶'}
    </button>
  )
}

/** Inspector for a song node, in the artboard's order. */
function TrackPanel({ emphasizedTags = [], onEmphasizedTags, excluded, onToggleExclusion, node, isRoot, stop, match, impact, onExpand, onPrune, onClose, onOpenArtist, taste, tasteActions, onEditTaste, followJourney, journeyStops, saved, onToggleSave, connections = [], onSelectNode, mapKey = 0 }: Omit<Props, 'onTags'>) {
  const [details, setDetails] = useState<TrackDetails | null>(null)
  // undefined = still looking it up, null = unknown.
  const [releaseDate, setReleaseDate] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [state, setState] = useState<'idle' | 'resolving' | 'playing' | 'unavailable'>('idle')
  // Whole seconds played: timeupdate fires a few times a second, so this re-renders at most once a second.
  const [elapsed, setElapsed] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const steerRef = useRef<HTMLElement>(null)
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
      setElapsed(0)
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
  const total = Math.round(preview?.duration_seconds ?? 30)
  const tags = details?.tags ?? []
  const atCap = emphasizedTags.length >= MAX_STEERING
  const matchRow = matchText(match)

  return (
    <PanelShell label={`${node.name} details`} kind="track" stop={stop} onClose={onClose}>
      <header className="panel__section panel__header">
        <h2 className="panel__title" title={node.name}>{node.name}</h2>
        <div className="panel__meta">
          {artistName}
          {node.artist && (
            <>
              {' · '}
              <button className="link-btn" onClick={() => onOpenArtist(node.artist!)} title={`Start a new map from ${artistName}`}>
                artist map
              </button>
            </>
          )}
        </div>
      </header>

      <div className={`panel__section panel__preview${state === 'playing' ? ' is-playing' : ''}`}
        title={state === 'playing' && preview?.provider ? `30s preview · ${preview.provider.replace('_', ' ')}` : undefined}>
        <PlayButton name={node.name} state={state} onClick={toggle} />
        <span className="panel__progress" aria-hidden="true">
          <span style={{ width: `${total ? Math.min(100, (elapsed / total) * 100) : 0}%` }} />
        </span>
        <span className="panel__time">{state === 'unavailable' ? 'no preview' : `${fmtDuration(elapsed)}/${fmtDuration(total)}`}</span>
      </div>

      <SaveActions node={node} saved={saved} onToggleSave={onToggleSave} excluded={excluded} onToggleExclusion={onToggleExclusion} />

      <section className="panel__section panel__steer" aria-labelledby={`steer-${node.id}`} ref={steerRef}>
        <div className="panel__section-head">
          <h3 id={`steer-${node.id}`}>{node.expanded ? 'Tags' : 'Steer next expand'}</h3>
          {!node.expanded && emphasizedTags.length > 0 && <span className="panel__count">{emphasizedTags.length}/{MAX_STEERING}</span>}
        </div>
        {!node.expanded && tags.length > 0 && onEmphasizedTags && (
          // Starting an expansion remounts it, which aborts and discards any interpretation.
          <SteerWords key={String(node.loading)} itemId={node.id} tags={tags} disabled={node.loading}
            onApply={(picked) => {
              onEmphasizedTags?.(picked)
              steerRef.current?.querySelector<HTMLButtonElement>('.btn--primary')?.focus()
            }} />
        )}
        {loading ? (
          <div className="panel__loading">
            <span className="spinner spinner--sm" /> Loading…
          </div>
        ) : tags.length > 0 ? (
          <ul className="tags">
            {tags.map((t) => {
              const pressed = emphasizedTags.includes(t)
              return node.expanded ? <li key={t} className="tag" title={t}>{t}</li> : (
                <li key={t}>
                  <button className="tag tag--steering"
                    title={!pressed && atCap ? 'Up to 3 tags' : t}
                    aria-pressed={pressed}
                    aria-disabled={node.loading || (!pressed && atCap)}
                    onClick={() => {
                      if (node.loading) return
                      if (pressed) onEmphasizedTags?.(emphasizedTags.filter((tag) => tag !== t))
                      else if (!atCap) onEmphasizedTags?.([...emphasizedTags, t])
                    }}>
                    {t}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          !error && <p className="panel__empty">No tags listed for this song.</p>
        )}
        {!node.expanded && tags.length > 0 && <p className="panel__hint steer-hint">Pick up to 3 for more of that flavour. Tags come from Last.fm listeners.</p>}
        <ExpandButton node={node} onExpand={onExpand} steering={emphasizedTags.length} />
        {node.ranking?.fallback_reason ? (
          <p className="panel__hint" role="status">{node.ranking.fallback_reason === 'cap_exceeded'
            ? 'Journey is over 50 stops, so this expansion used only this song.'
            : "Couldn't follow the whole journey this time; ranked by this song."}</p>
        ) : node.expanded && node.ranking?.mode === 'journey' ? (
          <p className="panel__hint">Expanded using your {node.ranking.stop_count}-stop journey.</p>
        ) : followJourney && !node.expanded ? (
          <p className="panel__hint">{(journeyStops ?? 0) > 50
            ? 'Journey is over 50 stops; next expansion will use only this song.'
            : `Next expansion follows your ${journeyStops}-stop journey.`}</p>
        ) : null}
        {emphasizedTags.length > 0 && (
          <p className="panel__hint" aria-live="polite">Steering: {emphasizedTags.join(', ')} · <button className="link-btn" disabled={node.loading} onClick={() => onEmphasizedTags?.([])}>Clear</button></p>
        )}
      </section>

      {error ? (
        <div className="panel__section">
          <div className="panel__error" role="alert">{error}</div>
        </div>
      ) : (
        (matchRow || details) && (
          <dl className="panel__section facts__list">
            {matchRow && (
              <div>
                <dt>Match</dt>
                <dd title={matchRow}>{matchRow}</dd>
              </div>
            )}
            {match && match.shared.length > 0 && (
              <div>
                <dt>Shared</dt>
                <dd title={match.shared.join(', ')}>{match.shared.join(', ')}</dd>
              </div>
            )}
            {details?.album && (
              <div>
                <dt>Album</dt>
                <dd title={details.album.title}>{details.album.title}</dd>
              </div>
            )}
            {details && (
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
            )}
            {details?.duration_seconds != null && (
              <div>
                <dt>Length</dt>
                <dd>{fmtDuration(details.duration_seconds)}</dd>
              </div>
            )}
            {details && (details.playcount != null || details.listeners != null) && (
              <div>
                <dt>Plays</dt>
                <dd>
                  {details.playcount != null && fmt(details.playcount)}
                  {details.listeners != null && <span className="facts__dim">{details.playcount != null && ' · '}{fmt(details.listeners)} listeners</span>}
                </dd>
              </div>
            )}
          </dl>
        )
      )}

      {details?.summary && (
        <section className="panel__section">
          <h3>About</h3>
          <Clamped text={details.summary} />
        </section>
      )}

      <TasteCheck key={node.id} actions={tasteActions} kind="track" itemId={node.id} profile={taste} onEdit={onEditTaste} />

      {node.expanded && connections.length > 0 && onSelectNode && (
        <ConnectionsCheck key={`${mapKey}:${node.id}`} parentId={node.id} items={connections} profile={taste} onSelect={onSelectNode} onEdit={onEditTaste} />
      )}

      <PruneActions node={node} isRoot={isRoot} impact={impact} onPrune={onPrune} />
      <OpenIn links={links} q={q} />
      <audio ref={audioRef} onTimeUpdate={(e) => setElapsed(Math.floor(e.currentTarget.currentTime))}
        onEnded={() => setState('idle')} onError={() => setState('idle')} preload="none" />
    </PanelShell>
  )
}

export function ArtistPanel(props: Props) {
  if (props.node.kind === 'track') return <TrackPanel key={props.node.id} {...props} />
  return <ArtistDetails {...props} />
}

function ArtistDetails({ node, isRoot, stop, match, impact, onExpand, onPrune, onClose, onTags, taste, tasteActions, onEditTaste, saved, onToggleSave, excluded, onToggleExclusion }: Omit<Props, 'onOpenArtist'>) {
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
  const matchRow = matchText(match)

  return (
    <PanelShell label={`${name} details`} kind="artist" stop={stop} onClose={onClose}>
      <header className="panel__section panel__header">
        <h2 className="panel__title" title={name}>{name}</h2>
        {artist?.listeners != null && <div className="panel__meta">{fmt(artist.listeners)} listeners on Last.fm</div>}
      </header>

      <SaveActions node={node} saved={saved} onToggleSave={onToggleSave} excluded={excluded} onToggleExclusion={onToggleExclusion} />

      <div className="panel__section panel__steer">
        <ExpandButton node={node} onExpand={onExpand} />
      </div>

      {loading ? (
        <div className="panel__section panel__loading">
          <span className="spinner" /> Loading…
        </div>
      ) : details.error ? (
        <div className="panel__section">
          <div className="panel__error" role="alert">{details.error}</div>
        </div>
      ) : (
        <>
          {(matchRow || artist) && (
            <dl className="panel__section facts__list">
              {matchRow && (
                <div>
                  <dt>Match</dt>
                  <dd title={matchRow}>{matchRow}</dd>
                </div>
              )}
              {artist && (
                <div>
                  <dt>Tags</dt>
                  <dd className="facts__wrap">{artist.tags.length > 0 ? artist.tags.join(', ') : <span className="facts__dim">No tags listed</span>}</dd>
                </div>
              )}
            </dl>
          )}

          {details.tracks && details.tracks.length > 0 && (
            <section className="panel__section">
              <h3>Top tracks</h3>
              <ul className="tracks">
                {details.tracks.map((t) => {
                  const isPlaying = playing?.track === t.name
                  return (
                    <li key={t.name} className={`track ${isPlaying ? 'is-playing' : ''}`}>
                      <PlayButton name={t.name} onClick={() => togglePreview(t)}
                        state={resolving === t.name ? 'resolving' : isPlaying ? 'playing' : unavailable.has(t.name) ? 'unavailable' : 'idle'} />
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

          {artist?.summary && (
            <section className="panel__section">
              <h3>Profile</h3>
              <Clamped text={artist.summary} />
            </section>
          )}
        </>
      )}

      <TasteCheck key={node.id} actions={tasteActions} kind="artist" itemId={node.id} profile={taste} onEdit={onEditTaste} />
      <PruneActions node={node} isRoot={isRoot} impact={impact} onPrune={onPrune} />
      <OpenIn links={links} q={q} />
      <audio ref={audioRef} onEnded={() => setPlaying(null)} onError={() => setPlaying(null)} preload="none" />
    </PanelShell>
  )
}
