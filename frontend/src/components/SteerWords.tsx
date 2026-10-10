import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { proposedChips, steerAllowlist, steerErrorMessage, steerNotices, STEER_COUNTER_FROM, STEER_MAX_CHARS } from '../steerWords'
import { SimulatedBadge } from './SimulatedBadge'

type Props = {
  itemId: string
  /** The song's displayed tags; only these can be proposed. */
  tags: string[]
  disabled?: boolean
  /** Replaces the current manual steering with these tags (#8's path). */
  onApply: (tags: string[]) => void
}

type Interpretation = { chips: string[]; pressed: string[]; notices: string[]; simulated: boolean }

/** Plain-word front door to the steering chips (#38). Nothing is sent while typing; a
 * remount (new key) aborts the request and discards the interpretation. */
export function SteerWords({ itemId, tags, disabled = false, onApply }: Props) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Interpretation | null>(null)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const interpret = async (e: FormEvent) => {
    e.preventDefault()
    const request = text.trim()
    if (!request || pending || disabled) return
    const allowlist = steerAllowlist(tags)
    const ctrl = new AbortController()
    abort.current = ctrl
    setPending(true)
    setError('')
    setResult(null)
    try {
      const steer = await api.tasteSteer(itemId, request, allowlist, ctrl.signal)
      if (ctrl.signal.aborted) return
      const chips = proposedChips(steer, allowlist)
      setResult({ chips, pressed: chips, notices: steerNotices(steer, allowlist), simulated: steer.simulated })
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(steerErrorMessage(err))
    } finally {
      if (!ctrl.signal.aborted) setPending(false)
    }
  }

  const toggle = (tag: string) => setResult((current) => current && {
    ...current,
    pressed: current.pressed.includes(tag) ? current.pressed.filter((t) => t !== tag) : current.chips.filter((t) => t === tag || current.pressed.includes(t)),
  })

  const apply = () => {
    if (!result?.pressed.length || disabled) return
    onApply(result.pressed)
    setText('')
    setResult(null)
  }

  const clear = () => {
    setResult(null)
    setError('')
    input.current?.focus()
  }

  return (
    <div className="steer-words">
      <form className="steer-words__form" onSubmit={interpret}>
        <div className="steer-words__field">
          <input ref={input} type="text" value={text} maxLength={STEER_MAX_CHARS} readOnly={pending}
            placeholder="e.g. darker, more dreamy" aria-label="Describe the direction for the next expansion"
            autoComplete="off" spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // A non-empty field eats Escape; an empty one lets the panel close as before.
              if (e.key !== 'Escape' || !text || pending) return
              e.stopPropagation()
              setText('')
            }} />
          {text.length >= STEER_COUNTER_FROM && <span className="steer-words__count">{text.length}/{STEER_MAX_CHARS}</span>}
        </div>
        <button type="submit" className="btn btn--ghost" disabled={!text.trim() || pending || disabled}>
          {pending ? 'Interpreting…' : 'Interpret'}
        </button>
      </form>
      <p className="panel__hint">Picks from this song's tags only.</p>
      <div className="steer-words__result" aria-live="polite">
        {error && <p className="panel__error" role="alert">{error}</p>}
        {result && (
          <>
            {result.chips.length > 0 && (
              <div className="steer-words__chips">
                <span className="steer-words__label">Interpreted as:</span>
                <ul className="tags">
                  {result.chips.map((tag) => (
                    <li key={tag}>
                      <button className="tag tag--steering" aria-pressed={result.pressed.includes(tag)} onClick={() => toggle(tag)}>
                        {result.pressed.includes(tag) && <span aria-hidden="true">✓ </span>}{tag}
                      </button>
                    </li>
                  ))}
                </ul>
                {result.simulated && <SimulatedBadge />}
              </div>
            )}
            {result.notices.map((notice, i) => (
              <p key={notice} className="panel__hint">
                {notice}
                {!result.chips.length && result.simulated && i === result.notices.length - 1 && <> <SimulatedBadge /></>}
              </p>
            ))}
            <div className="steer-words__actions">
              {result.chips.length > 0 && (
                <button className="btn btn--ghost" disabled={!result.pressed.length || disabled} onClick={apply}>Apply</button>
              )}
              <button className="link-btn" onClick={clear}>Clear</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
