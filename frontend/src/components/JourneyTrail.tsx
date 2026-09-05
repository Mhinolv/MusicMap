import { useEffect, useRef } from 'react'
import type { ArtistNode } from '../types'

type Props = {
  journey: string[]
  nodes: Map<string, ArtistNode>
  focusId?: string
  selectedId?: string
  onJump: (id: string) => void
  onCollapse: (id: string) => void
}

const STEP_MAX = 18
function short(name: string): string {
  return name.length > STEP_MAX ? name.slice(0, STEP_MAX - 1) + '…' : name
}

/**
 * A slim breadcrumb of every node the user has expanded, in order. It rests at
 * low opacity at the bottom of the stage and wakes on hover or keyboard focus.
 * Each stop can be jumped to, or pruned to drop the branch that grew from it.
 */
export function JourneyTrail({ journey, nodes, focusId, selectedId, onJump, onCollapse }: Props) {
  const listRef = useRef<HTMLOListElement>(null)
  const steps = journey.map((id) => nodes.get(id)).filter((n): n is ArtistNode => !!n)

  // Keep the newest stop in view as the trail grows.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }, [journey.length])

  if (steps.length === 0) return null

  return (
    <nav className="journey" aria-label="Exploration journey">
      <span className="journey__label" title="Your exploration path, in order">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <circle cx="3" cy="13" r="2" fill="currentColor" />
          <circle cx="13" cy="3" r="2" fill="currentColor" />
          <path d="M4.5 11.5C7 9 9 7 11.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1 2.6" />
        </svg>
        <span>{steps.length === 1 ? '1 stop' : `${steps.length} stops`}</span>
      </span>
      <ol ref={listRef} className="journey__steps">
        {steps.map((n, i) => {
          const isFocus = n.id === focusId
          const isSelected = n.id === selectedId
          const canCollapse = n.expanded
          return (
            <li key={n.id} className={`journey__step ${isFocus ? 'is-focus' : ''} ${isSelected ? 'is-selected' : ''}`}>
              {i > 0 && (
                <span className="journey__arrow" aria-hidden="true">
                  ›
                </span>
              )}
              <span className="journey__chip">
                <button
                  className="journey__jump"
                  onClick={() => onJump(n.id)}
                  title={`Jump to ${n.name}`}
                  aria-current={isFocus ? 'step' : undefined}
                >
                  <span className="journey__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="journey__name">{n.kind === 'track' ? `♪ ${short(n.name)}` : short(n.name)}</span>
                </button>
                {canCollapse && (
                  <button
                    className="journey__prune"
                    onClick={() => onCollapse(n.id)}
                    aria-label={`Collapse ${n.name} and everything explored from it`}
                    title="Collapse this branch"
                  >
                    ×
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
