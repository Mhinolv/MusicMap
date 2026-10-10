/** Map zoom shortcuts leave text editing and browser modifier shortcuts alone. */
export function zoomShortcut(key: string, typing: boolean, dialogOpen: boolean, modified: boolean): number | undefined {
  if (typing || dialogOpen || modified) return undefined
  if (key === '+' || key === '=') return 1.4
  if (key === '-') return 1 / 1.4
  return undefined
}
