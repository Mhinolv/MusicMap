import { useRef, type KeyboardEvent, type ReactNode, type TouchEvent } from 'react'
import { SHEET_TABS, tabForKey, type SheetGesture, type SheetTab, type SheetView } from '../sheet'

type Props = {
  /** "Song details" or "Artist details". */
  label: string
  view: SheetView
  onTab: (tab: SheetTab) => void
  onResize: (gesture: SheetGesture) => void
  journeyCount: number
  onMapCount: number
  inspector: ReactNode
  journey: ReactNode
  onMap: ReactNode
}

const SWIPE_PX = 36

/**
 * Phone bottom sheet (#34): a grab handle, the INSPECTOR | JOURNEY | ON MAP tabs and
 * their panels. Every panel stays mounted so a playing preview survives a tab switch.
 */
export function MobileSheet({ label, view, onTab, onResize, journeyCount, onMapCount, inspector, journey, onMap }: Props) {
  const startY = useRef<number | null>(null)
  const swiped = useRef(false)
  const tabs = useRef<HTMLDivElement>(null)

  const onTouchStart = (e: TouchEvent) => {
    startY.current = e.touches[0]?.clientY ?? null
    swiped.current = false
  }
  const onTouchEnd = (e: TouchEvent) => {
    const y0 = startY.current
    startY.current = null
    if (y0 == null) return
    const dy = (e.changedTouches[0]?.clientY ?? y0) - y0
    if (Math.abs(dy) <= SWIPE_PX) return
    swiped.current = true
    onResize(dy < 0 ? 'up' : 'down')
  }
  const onHandleClick = () => {
    // A swipe that also produced a click should not undo itself.
    if (swiped.current) {
      swiped.current = false
      return
    }
    onResize('tap')
  }
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabForKey(view.tab, e.key)
    if (!next) return
    e.preventDefault()
    onTab(next)
    tabs.current?.querySelector<HTMLButtonElement>(`#sheet-tab-${next}`)?.focus()
  }

  const labels: Record<SheetTab, string> = { inspector: 'Inspector', journey: `Journey · ${journeyCount}`, onmap: `On map · ${onMapCount}` }
  const panels: Record<SheetTab, ReactNode> = { inspector, journey, onmap: onMap }
  return (
    <section className={`sheet sheet--${view.size}`} aria-label={label}>
      <button
        type="button"
        className="sheet__handle"
        onClick={onHandleClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => (startY.current = null)}
        aria-label={view.size === 'full' ? 'Shrink panel' : 'Expand panel'}
      >
        <span aria-hidden="true" />
      </button>
      <div ref={tabs} className="sheet__tabs" role="tablist" aria-label="Panel views">
        {SHEET_TABS.map((tab) => (
          <button key={tab} type="button" id={`sheet-tab-${tab}`} role="tab" aria-selected={view.tab === tab}
            aria-controls={`sheet-panel-${tab}`} tabIndex={view.tab === tab ? 0 : -1}
            onClick={() => onTab(tab)} onKeyDown={onTabKey}>
            {labels[tab]}
          </button>
        ))}
      </div>
      {SHEET_TABS.map((tab) => (
        <div key={tab} id={`sheet-panel-${tab}`} className={`sheet__panel sheet__panel--${tab}`} role="tabpanel"
          aria-labelledby={`sheet-tab-${tab}`} hidden={view.tab !== tab || view.size === 'peek'}>
          {panels[tab]}
        </div>
      ))}
    </section>
  )
}
