import { useEffect, useRef, useState, type Ref } from 'react'
import type { ExcludedSong } from '../exclusions'
import { bookmarkKey, type Bookmark } from '../bookmarks'
import { savedWhen } from '../startScreen'

export const LIBRARY_DRAWER_ID = 'library-drawer'

type ButtonProps = { count: number; open: boolean; onToggle: () => void; buttonRef?: Ref<HTMLButtonElement>; className?: string; icon?: boolean }

/** Header entry on the start screen and in the map; the badge counts saved + not suggested. */
export function LibraryButton({ count, open, onToggle, buttonRef, className = '', icon = false }: ButtonProps) {
  // Phone map header (#34): a bookmark glyph whose name carries the count.
  if (icon) return (
    <button ref={buttonRef} type="button" className={`library-button library-button--icon ${className}`} aria-expanded={open}
      aria-controls={open ? LIBRARY_DRAWER_ID : undefined} aria-label={`Library, ${count} ${count === 1 ? 'item' : 'items'}`} onClick={onToggle}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="miter"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
    </button>
  )
  return (
    <button ref={buttonRef} type="button" className={`taste-entry library-button ${className}`} aria-expanded={open}
      aria-controls={open ? LIBRARY_DRAWER_ID : undefined} aria-label={count ? `Library, ${count} saved or not suggested` : 'Library'} onClick={onToggle}>
      <span>Library</span>{count > 0 && <span className="library-count">{count}</span>}
    </button>
  )
}

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

const sub = (who: string, savedAt: number) => [who, savedWhen(savedAt)].filter(Boolean).join(' · ')

/** Non-modal: the map, header and undo toasts stay reachable while it is open. */
export function LibraryDrawer({ exclusions, onRemoveExclusion, onResetExclusions, entries, onOpen, onRemove, onClear, onClose }: Props) {
  const [tab, setTab] = useState<'saved' | 'excluded'>('saved')
  const drawer = useRef<HTMLElement>(null)
  useEffect(() => {
    drawer.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal dialog opened over the drawer handles its own Escape.
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside ref={drawer} id={LIBRARY_DRAWER_ID} className="library-drawer" aria-label="Library">
      <div className="library-drawer__head">
        <h2>Library</h2>
        <button type="button" className="library-drawer__close" onClick={onClose} aria-label="Close library">×</button>
      </div>
      <div className="library-tabs" role="tablist" aria-label="Library lists">
        {(['saved', 'excluded'] as const).map((value) => (
          <button key={value} type="button" id={`${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`${value}-list`} tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
              e.preventDefault()
              const next = e.key === 'Home' ? 'saved' : e.key === 'End' ? 'excluded' : tab === 'saved' ? 'excluded' : 'saved'
              setTab(next)
              drawer.current?.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus()
            }}>
            {value === 'saved' ? `Saved · ${entries.length}` : `Not suggested · ${exclusions.length}`}
          </button>
        ))}
      </div>
      <div className="library-drawer__body">
        <div hidden={tab !== 'saved'} id="saved-list" role="tabpanel" aria-labelledby="saved-tab">
          {entries.length ? (
            <ul className="saved-list">
              {entries.map((entry) => (
                <li key={bookmarkKey(entry)}>
                  <span className="saved-list__dot" aria-hidden="true" />
                  <div className="saved-item">
                    <span className="saved-item__name">{entry.item.name}</span>
                    <span className="saved-item__sub">{sub(entry.kind === 'track' ? entry.item.artist.name : 'Artist', entry.savedAt)}</span>
                  </div>
                  <button type="button" className="btn" onClick={() => onOpen(entry)}>Map it</button>
                  <button type="button" className="icon-btn" onClick={() => onRemove(entry)} aria-label={`Remove ${entry.item.name} from saved`}>×</button>
                </li>
              ))}
            </ul>
          ) : <p className="panel__empty saved-empty">Nothing saved yet. Use the bookmark on any artist or song panel.</p>}
          <div className="library-drawer__actions">
            <button type="button" className="btn btn--danger" onClick={onClear} disabled={!entries.length}>Clear all</button>
          </div>
        </div>
        <div hidden={tab !== 'excluded'} id="excluded-list" role="tabpanel" aria-labelledby="excluded-tab">
          {exclusions.length ? (
            <ul className="saved-list">
              {exclusions.map((entry) => (
                <li key={entry.item.id}>
                  <span className="saved-list__dot" aria-hidden="true" />
                  <div className="saved-item">
                    <span className="saved-item__name">{entry.item.name}</span>
                    <span className="saved-item__sub">{sub(entry.item.artist.name, entry.savedAt)}</span>
                  </div>
                  <button type="button" className="btn" onClick={() => onRemoveExclusion(entry)} aria-label={`Suggest ${entry.item.name} by ${entry.item.artist.name} again`}>Restore</button>
                </li>
              ))}
            </ul>
          ) : <p className="panel__empty saved-empty">No excluded songs. Use “Don't suggest again” on a song panel.</p>}
          <div className="library-drawer__actions">
            <button type="button" className="btn" onClick={onResetExclusions} disabled={!exclusions.length}>Reset all</button>
          </div>
        </div>
        <p className="library-drawer__note">Kept on this device. Songs marked "Don't suggest again" move to Not suggested, where you can restore them.</p>
        <p className="library-drawer__note">Saving doesn't change your taste profile.</p>
      </div>
    </aside>
  )
}
