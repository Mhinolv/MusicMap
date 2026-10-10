import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hasPositiveTaste } from '../taste'
import { api, ApiError } from '../api'
import type { TasteEvaluation, TasteProfile } from '../types'

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
    try {
      setResult(await api.tasteEvaluate(kind, itemId, profile, ctrl.signal))
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(err instanceof ApiError && err.status === 503
        ? 'Taste checks are not configured on this server.'
        : err instanceof ApiError && err.status === 429
          ? 'JEV is busy. Try again shortly.'
          : 'Could not check your taste right now. Please retry.')
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }

  const label = result ? result.estimate >= 0.7 ? 'Likely fit' : result.estimate <= 0.3 ? 'Unlikely fit' : 'Mixed signals' : ''
  const shared = result?.tags.filter((tag) => profile?.liked_genres.some((genre) => genre.toLowerCase() === tag.toLowerCase())) ?? []

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
              {loading ? 'Checking…' : result ? 'Check again' : 'Check my taste'}
            </button>
          </div>
          {loading && <p className="panel__hint" role="status">JEV is checking. The first request may take a while.</p>}
          {error && <p className="panel__error" role="alert">{error}</p>}
          {result && <div className="taste-check__result" role="status">
            <strong>{label}</strong><span>{Math.round(result.estimate * 100)}% model estimate</span>
            {shared.length > 0 && <small>Shared tags: {shared.join(', ')}</small>}
            <small>Experimental judgment based on the preferences you entered.</small>
          </div>}
        </>
      )}
    </>
  )
}
