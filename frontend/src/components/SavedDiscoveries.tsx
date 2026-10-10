import { useEffect, useRef, useState } from 'react'
import type { ExcludedSong } from '../exclusions'
import { bookmarkKey, type Bookmark } from '../bookmarks'

type Props = {
  exclusions: ExcludedSong[]
  onRemoveExclusion: (entry: ExcludedSong) => void
  onResetExclusions: () => void
  entries: Bookmark[]
  onOpen: (entry: Bookmark) => void
  onRemove: (entry: Bookmark) => void
  onClear: () => void
  onClose: () => void
}

export function SavedDiscoveries({ exclusions, onRemoveExclusion, onResetExclusions, entries, onOpen, onRemove, onClear, onClose }: Props) {
  const [tab, setTab] = useState<'saved' | 'excluded'>('saved')
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const initial = dialog.current?.querySelector<HTMLButtonElement>('button.saved-item') ?? dialog.current?.querySelector<HTMLButtonElement>('button')
    initial?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key !== 'Tab') return
      const visibleButtons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        .filter((button) => !button.closest('[hidden]') && button.tabIndex >= 0)
      const buttons = [...visibleButtons, ...document.querySelectorAll<HTMLButtonElement>('.toast__action')]
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (!buttons.some((button) => button === document.activeElement)) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus() }
  }, [onClose])

  return (
    <div className="taste-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section ref={dialog} className="taste-dialog saved-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-title">
        <div className="taste-dialog__head">
          <div><h2 id="saved-title">Saved</h2><p>Kept in this browser. Saving doesn't change your taste profile.</p></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close saved discoveries">×</button>
        </div>
        <div className="search__mode saved-tabs" role="tablist" aria-label="Discoveries">
          {(['saved', 'excluded'] as const).map((value) => (
            <button key={value} className={tab === value ? 'is-on' : ''} id={`${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`${value}-list`} tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                const next = e.key === 'Home' ? 'saved' : e.key === 'End' ? 'excluded' : tab === 'saved' ? 'excluded' : 'saved'
                setTab(next)
                dialog.current?.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus()
              }}>
              {value === 'saved' ? `Saved (${entries.length})` : `Not suggested (${exclusions.length})`}
            </button>
          ))}
        </div>
        <div hidden={tab !== 'saved'} id="saved-list" role="tabpanel" aria-labelledby="saved-tab">
          {entries.length ? (
            <ul className="saved-list">
              {entries.map((entry) => (
                <li key={bookmarkKey(entry)}>
                  <button className="saved-item" onClick={() => onOpen(entry)}>
                    <span className="search__name">{entry.kind === 'track' && <span className="search__glyph" aria-label="Song">♪ </span>}{entry.item.name}</span>
                    <span className="search__sub">{entry.kind === 'track' ? entry.item.artist.name : 'Artist'}</span>
                  </button>
                  <button className="icon-btn" onClick={() => onRemove(entry)} aria-label={`Remove ${entry.item.name}`}>×</button>
                </li>
              ))}
            </ul>
          ) : <p className="panel__empty saved-empty">Nothing saved yet. Use the bookmark on any artist or song panel.</p>}
          <button className="btn btn--ghost btn--danger" onClick={onClear} disabled={!entries.length}>Clear all</button>
        </div>
        <div hidden={tab !== 'excluded'} id="excluded-list" role="tabpanel" aria-labelledby="excluded-tab">
          <p className="panel__hint">These songs stay on your map but are excluded from future suggestions. Up to 100, kept in this browser.</p>
          {exclusions.length ? (
            <ul className="saved-list">
              {exclusions.map((entry) => (
                <li key={entry.item.id}>
                  <div className="saved-item">
                    <span className="search__name">♪ {entry.item.name}</span>
                    <span className="search__sub">{entry.item.artist.name}</span>
                  </div>
                  <button className="icon-btn" onClick={() => onRemoveExclusion(entry)} aria-label={`Suggest ${entry.item.name} by ${entry.item.artist.name} again`}>×</button>
                </li>
              ))}
            </ul>
          ) : <p className="panel__empty saved-empty">No excluded songs. Use “Don't suggest again” on a song panel.</p>}
          <button className="btn btn--ghost" onClick={onResetExclusions} disabled={!exclusions.length}>Reset all</button>
        </div>
      </section>
    </div>
  )
}
