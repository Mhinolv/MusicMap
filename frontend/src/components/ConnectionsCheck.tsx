import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { hasPositiveTaste } from '../taste'
import { FIT_PIPS } from '../fitBand'
import { connectionBand, connectionLabel, connectionsSummary, idsToCheck, type ConnectionItem } from '../connections'
import { tasteErrorMessage } from '../tasteError'
import { ConflictIcon } from './TasteCheck'
import { SimulatedBadge } from './SimulatedBadge'
import type { TasteConnectionResult, TasteProfile } from '../types'

type Props = {
  parentId: string
  /** The expansion's surviving children, in graph order. */
  items: ConnectionItem[]
  profile: TasteProfile | null
  onSelect: (id: string) => void
  onEdit: () => void
}

/** Results belong to one profile; the parent mounts this per parent node and map. */
type Checked = { profileKey: string; results: Record<string, TasteConnectionResult>; simulated: boolean }

/**
 * "Check these connections" (#37): one explicit batch taste check for the songs an
 * expansion added. Labels sit beside each song and never change the map.
 */
export function ConnectionsCheck({ items, profile, onSelect, onEdit }: Props) {
  const profileKey = JSON.stringify(profile)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [pending, setPending] = useState<{ profileKey: string; ids: string[] } | null>(null)
  const [error, setError] = useState<{ profileKey: string; message: string } | null>(null)
  const abort = useRef<AbortController | null>(null)

  // A taste edit or unmount (another node selected, map reset) drops the in-flight batch.
  useEffect(() => () => abort.current?.abort(), [profileKey])

  const canCheck = hasPositiveTaste(profile)
  const results = checked?.profileKey === profileKey ? checked.results : {}
  const pendingIds = new Set(pending?.profileKey === profileKey ? pending.ids : [])
  const loading = pendingIds.size > 0
  const shownError = error?.profileKey === profileKey ? error.message : ''
  const tasteChanged = !!checked && checked.profileKey !== profileKey && canCheck
  const summary = loading ? null : connectionsSummary(items, results)

  const check = async () => {
    if (!canCheck || !profile || loading) return
    const ids = idsToCheck(items, results)
    if (!ids.length) return
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    const key = profileKey
    setPending({ profileKey: key, ids })
    setError(null)
    try {
      const response = await api.tasteConnections(ids, profile, ctrl.signal)
      if (ctrl.signal.aborted) return
      const fresh = Object.fromEntries(response.results.filter((r) => ids.includes(r.item_id)).map((r) => [r.item_id, r] as const))
      setChecked((previous) => ({
        profileKey: key,
        results: { ...(previous?.profileKey === key ? previous.results : {}), ...fresh },
        simulated: response.simulated,
      }))
    } catch (err) {
      if (ctrl.signal.aborted) return
      // Whole-request failure: rows go back to no label; the user retries explicitly.
      setChecked(null)
      setError({ profileKey: key, message: tasteErrorMessage(err) })
    } finally {
      if (!ctrl.signal.aborted) setPending(null)
    }
  }

  const hasResults = Object.keys(results).length > 0

  return (
    <section className="panel__section connections-check">
      <div className="connections-check__head">
        <h3>Your taste across these connections</h3>
        {hasResults && checked?.simulated && <SimulatedBadge />}
      </div>
      {!canCheck ? (
        <>
          <p className="panel__hint">Add a few things you like to check these connections.</p>
          <div><button className="btn btn--ghost" onClick={onEdit}>Add preferences</button></div>
        </>
      ) : (
        <>
          {tasteChanged && !hasResults && !loading && <p className="panel__hint">Your taste changed. Check again to update.</p>}
          <div>
            <button className="btn btn--ghost" onClick={check} disabled={loading}>
              {loading ? 'Checking…' : hasResults || shownError || tasteChanged ? 'Check again' : 'Check these connections'}
            </button>
          </div>
          {shownError && <p className="panel__error" role="alert">{shownError}</p>}
        </>
      )}
      <ol className="connections" aria-busy={loading}>
        {items.map((item) => {
          const result = results[item.id]
          const band = result ? connectionBand(result) : null
          const label = connectionLabel(item)
          return (
            <li key={item.id} className="connections__row">
              <button className="link-btn connections__name" title={label}
                aria-label={item.artist ? `Select ${item.name} by ${item.artist}` : `Select ${item.name}`}
                onClick={() => onSelect(item.id)}>
                {label}
              </button>
              {pendingIds.has(item.id) ? (
                <span className="connections__label connections__label--pending"><span className="spinner spinner--xs" aria-hidden="true" /> Checking…</span>
              ) : result && band ? (
                <span className={`connections__label fit--${band.key} fit-tone--${band.tone}`}>
                  <span className="fit-band">
                    {band.key === 'conflict' && <ConflictIcon />}
                    <span className="fit-band__label">{band.label}</span>
                    {band.pips > 0 && <span className="fit-pips" aria-hidden="true">
                      {Array.from({ length: FIT_PIPS }, (_, i) => <i key={i} className={i < band.pips ? 'is-on' : undefined} />)}
                    </span>}
                  </span>
                </span>
              ) : result ? (
                <span className="connections__label connections__label--unknown">Couldn't check</span>
              ) : null}
            </li>
          )
        })}
      </ol>
      {summary && <p className="panel__hint" aria-live="polite">{summary}</p>}
      <p className="panel__hint connections-check__note">Labels compare each song with your taste. They don't change the map.</p>
    </section>
  )
}
