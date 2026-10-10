import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { JOURNEY_CAP } from '../graph/journey'
import { matchFraction, matchLabel, stopNumber, type OnMapRow } from '../graph/onMap'
import type { ArtistNode } from '../types'

type JourneyProps = {
  stops: ArtistNode[]
  focusId?: string
  songMode?: boolean
  followJourney?: boolean
  onFollowJourney?: () => void
  onJump: (id: string) => void
  onCollapse: (id: string) => void
}

/** Numbered journey stops with the Follow journey switch. The current stop stays amber. */
export function JourneyList({ stops, focusId, songMode, followJourney, onFollowJourney, onJump, onCollapse }: JourneyProps) {
  const listRef = useRef<HTMLOListElement>(null)
  const overCap = stops.length > JOURNEY_CAP

  // Keep the newest stop in view as the journey grows.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [stops.length])

  return (
    <section className="nav-journey" aria-label="Journey">
      <div className="nav-head">
        <h2>Journey</h2>
        {songMode && (
          <button
            className={`map-nav__follow ${followJourney ? 'is-on' : ''}`}
            role="switch"
            aria-checked={!!followJourney}
            aria-disabled={overCap}
            onClick={() => { if (!overCap) onFollowJourney?.() }}
            title={overCap ? 'Follow journey works for up to 50 stops'
              : "Rank new songs against every song you've expanded, not just this one" + (stops.length <= 1 ? ' (needs 2+ stops to make a difference)' : '')}
          >
            <span>Follow journey</span>
            <span className="map-nav__track" aria-hidden="true"><span className="map-nav__knob" /></span>
          </button>
        )}
      </div>
      {stops.length === 0 ? (
        <p className="nav-empty">Expand a star to start your journey.</p>
      ) : (
        <ol ref={listRef} className="nav-stops">
          {stops.map((n, i) => {
            const isFocus = n.id === focusId
            return (
              <li key={n.id} className={`nav-stop ${isFocus ? 'is-current' : ''}`}>
                <span className="nav-stop__num" aria-hidden="true">{stopNumber(i)}</span>
                <span className="nav-stop__dot" aria-hidden="true" />
                <button className="nav-stop__name" onClick={() => onJump(n.id)} title={`Jump to ${n.name}`} aria-current={isFocus ? 'step' : undefined}>
                  {n.name}
                </button>
                {n.expanded && (
                  <button className="nav-stop__collapse" onClick={() => onCollapse(n.id)} aria-label={`Collapse ${n.name} branch`} title="Collapse this branch">×</button>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

type OnMapProps = {
  rows: OnMapRow[]
  /** Every node on the map, root included. */
  count: number
  selectedId?: string
  onJump: (id: string) => void
}

/** Up and Down step between rows. */
function moveFocus(e: KeyboardEvent<HTMLUListElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.nav-row'))
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  e.preventDefault()
  buttons[Math.min(buttons.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))].focus()
}

/** Every star on the map ranked by match to the node it was expanded from. Selection is cyan. */
export function OnMapList({ rows, count, selectedId, onJump }: OnMapProps) {
  return (
    <section className="nav-onmap" aria-label="On map">
      <div className="nav-head nav-head--onmap">
        <h2>On map · {count}</h2>
        <span className="nav-head__match" aria-hidden="true">Match</span>
      </div>
      <ul className="nav-rows" onKeyDown={moveFocus}>
        {rows.map((row) => {
          const score = matchLabel(row)
          const spoken = row.loading ? 'loading' : row.match == null ? 'match unknown' : `match ${score}`
          return (
            <li key={row.id}>
              <button
                className="nav-row"
                aria-pressed={row.id === selectedId}
                onClick={() => onJump(row.id)}
                title={row.artist ? `${row.name} — ${row.artist}` : row.name}
                aria-label={row.artist ? `${row.name} by ${row.artist}, ${spoken}` : `${row.name}, ${spoken}`}
              >
                <span className="nav-row__name">{row.name}</span>
                <span className="nav-row__bar" aria-hidden="true"><span style={{ width: `${matchFraction(row.match) * 100}%` }} /></span>
                <span className="nav-row__score" aria-hidden="true">{score}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

type Props = JourneyProps & Omit<OnMapProps, 'onJump'> & { className?: string; children?: ReactNode }

/** Desktop left pane: Journey above, On map below. #34 reuses both lists in the mobile tabs. */
export function MapNavPane({ className, children, rows, count, selectedId, ...journey }: Props) {
  return (
    <nav className={className} aria-label="Journey and map contents">
      <JourneyList {...journey} />
      <OnMapList rows={rows} count={count} selectedId={selectedId} onJump={journey.onJump} />
      {children}
    </nav>
  )
}
