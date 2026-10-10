/** Phones (≤640px) show the inspector and the #31 lists as tabs in one bottom sheet (#34). */
export const NARROW_QUERY = '(max-width: 640px)'

export type SheetTab = 'inspector' | 'journey' | 'onmap'
export type SheetSize = 'peek' | 'half' | 'full'
/** `selectionId` is the selection this view was chosen for; the tab choice is never persisted. */
export type SheetView = { tab: SheetTab; size: SheetSize; selectionId?: string }
export type SheetGesture = 'tap' | 'up' | 'down'

export const SHEET_TABS: readonly SheetTab[] = ['inspector', 'journey', 'onmap']
const SIZES: readonly SheetSize[] = ['peek', 'half', 'full']

/** Selecting a node opens INSPECTOR at half height; deselecting returns to peek on JOURNEY. */
export function sheetForSelection(view: SheetView, selectionId?: string): SheetView {
  if (view.selectionId === selectionId) return view
  return selectionId ? inspectorView(selectionId) : { tab: 'journey', size: 'peek' }
}

export function inspectorView(selectionId: string): SheetView {
  return { tab: 'inspector', size: 'half', selectionId }
}

/** Handle gestures: a tap cycles peek → half → full → peek; a swipe moves one step and stops at the ends. */
export function resizeSheet(size: SheetSize, gesture: SheetGesture): SheetSize {
  const i = SIZES.indexOf(size)
  if (gesture === 'tap') return SIZES[(i + 1) % SIZES.length]
  return SIZES[Math.min(SIZES.length - 1, Math.max(0, i + (gesture === 'up' ? 1 : -1)))]
}

/** Arrow keys wrap between tabs; Home and End jump to the ends. Other keys leave the tab alone. */
export function tabForKey(tab: SheetTab, key: string): SheetTab | undefined {
  const i = SHEET_TABS.indexOf(tab)
  if (key === 'ArrowRight') return SHEET_TABS[(i + 1) % SHEET_TABS.length]
  if (key === 'ArrowLeft') return SHEET_TABS[(i - 1 + SHEET_TABS.length) % SHEET_TABS.length]
  if (key === 'Home') return SHEET_TABS[0]
  if (key === 'End') return SHEET_TABS[SHEET_TABS.length - 1]
  return undefined
}
