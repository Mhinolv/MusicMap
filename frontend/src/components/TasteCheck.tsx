import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hasPositiveTaste } from '../taste'
import { api } from '../api'
import { bandFor, FIT_PIPS, uncertainHint } from '../fitBand'
import { tasteErrorMessage } from '../tasteError'
import { SimulatedBadge } from './SimulatedBadge'
import type { TasteEvaluation, TasteProfile } from '../types'

export function ConflictIcon() {
  return (
    <svg className="fit-band__icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.1 10.9 10.9 3.1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type Props = {
  actions?: ReactNode
  kind: 'artist' | 'track'
  itemId: string
  profile: TasteProfile | null
  onEdit: () => void
}

export function TasteCheck({ actions, ...props }: Props) {
  return (
    <section className="panel__section taste-check">
      <h3>For your taste</h3>
      {actions}
      <TasteEvaluationCheck key={`${props.kind}:${props.itemId}:${JSON.stringify(props.profile)}`} {...props} />
    </section>
  )
}

function TasteEvaluationCheck({ kind, itemId, profile, onEdit }: Props) {
  const [result, setResult] = useState<TasteEvaluation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const check = async () => {
    if (!hasPositiveTaste(profile) || !profile || loading) return
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setLoading(true)
    setError('')
    setResult(null)
    try {
      setResult(await api.tasteEvaluate(kind, itemId, profile, ctrl.signal))
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(tasteErrorMessage(err))
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }

  const band = result ? bandFor(result) : null
  const hint = band ? uncertainHint(band, kind) : null
  const shared = band && band.pips > 0
    ? result?.tags.filter((tag) => profile?.liked_genres.some((genre) => genre.toLowerCase() === tag.toLowerCase())) ?? []
    : []

  return (
    <>
      {!hasPositiveTaste(profile) ? (
        <>
          <p className="panel__hint">Add a few things you like to check this {kind === 'track' ? 'song' : 'artist'}.</p>
          <button className="btn btn--ghost" onClick={onEdit}>Add preferences</button>
        </>
      ) : (
        <>
          <div className="taste-check__actions">
            <button className="btn btn--ghost" onClick={onEdit}>Edit taste</button>
            <button className="btn" onClick={check} disabled={loading}>
              {loading ? 'Checking…' : result || error ? 'Check again' : 'Check my taste'}
            </button>
          </div>
          {loading && <p className="panel__hint" role="status">JEV is checking (up to 5 seconds).</p>}
          {error && <p className="panel__error" role="alert">{error}</p>}
          {result && band && <div className={`taste-check__result fit--${band.key} fit-tone--${band.tone}`} role="status">
            <div className="fit-band">
              {band.key === 'conflict' && <ConflictIcon />}
              <strong className="fit-band__label">{band.label}</strong>
              {band.pips > 0 && <span className="fit-pips" aria-hidden="true">
                {Array.from({ length: FIT_PIPS }, (_, i) => <i key={i} className={i < band.pips ? 'is-on' : undefined} />)}
              </span>}
              {result.simulated && <SimulatedBadge />}
            </div>
            {hint && <p className="panel__hint">{hint}</p>}
            {shared.length > 0 && <small>Shared tags: {shared.join(', ')}</small>}
            <small>Experimental judgment based on the preferences you entered.{result.model ? ` · ${result.model}` : ''}</small>
          </div>}
        </>
      )}
    </>
  )
}
