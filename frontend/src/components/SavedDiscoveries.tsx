import { useEffect, useRef } from 'react'
import { bookmarkKey, type Bookmark } from '../bookmarks'

type Props = {
  entries: Bookmark[]
  onOpen: (entry: Bookmark) => void
  onRemove: (entry: Bookmark) => void
  onClear: () => void
  onClose: () => void
}

export function SavedDiscoveries({ entries, onOpen, onRemove, onClear, onClose }: Props) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const initial = dialog.current?.querySelector<HTMLButtonElement>('.saved-item') ?? dialog.current?.querySelector<HTMLButtonElement>('button')
    initial?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key !== 'Tab') return
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []), ...document.querySelectorAll<HTMLButtonElement>('.toast__action')]
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
          <button className="is-on" id="saved-tab" role="tab" aria-selected="true" aria-controls="saved-list">Saved ({entries.length})</button>
        </div>
        <div id="saved-list" role="tabpanel" aria-labelledby="saved-tab">
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
        </div>
        <button className="btn btn--ghost btn--danger" onClick={onClear} disabled={!entries.length}>Clear all</button>
      </section>
    </div>
  )
}
