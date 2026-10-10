/** Fixed seed, independent of the force simulation; also usable by the start screen. */
export function generateStarField(width: number, height: number, mobile: boolean, faint = false) {
  let seed = 29
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const count = width > 0 && height > 0 ? Math.min(mobile ? 32 : 120, Math.floor(width * height / 6000)) : 0
  return Array.from({ length: count + (count ? mobile ? 3 : 7 : 0) }, (_, i) => {
    const tone = random()
    return { x: random() * width, y: random() * height, r: i >= count ? 1.5 : random() < 0.5 ? 0.5 : 1,
      color: i >= count || tone >= 0.82 ? '#8A8E96' : tone >= 0.61 ? '#5A5E66' : '#3A3D44',
      soft: i >= count, opacity: faint ? 0.35 : 1 }
  })
}

export function starRadius(match: number | undefined, degree: number, tierScale: number, selected: boolean, stop: boolean) {
  const value = match ?? (0.6 + Math.min(1, Math.sqrt(Math.max(0, degree)) / 5) * 0.3)
  return (selected ? 8 : stop ? 6 : (11 + 2 * Math.max(0, Math.min(1, (value - 0.6) / 0.3))) / 2) * tierScale
}

export function labelLines(name: string, artist: string | undefined, match: number | undefined, root: boolean, mobile: boolean) {
  const truncate = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text
  const detail = root ? 'ROOT' : match == null ? '' : `${Math.round(match * 100)}%`
  return { main: truncate(name, mobile ? 15 : 20), sub: truncate(mobile ? artist ?? '' : [artist, detail].filter(Boolean).join(' · '), mobile ? 16 : 22) }
}

export type LabelPoint = {
  id: string; name: string; x: number; y: number; core: number; ring: number
  mainWidth: number; subWidth: number; selected: boolean; root: boolean; journey: boolean; match?: number
}
type Side = 'right' | 'left' | 'below'
export type LabelPosition = { side: Side; x: number; y: number; anchor: 'start' | 'end' | 'middle'; sub: boolean; hidden: boolean }
type Box = { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w + 3 && a.x + a.w + 3 > b.x && a.y < b.y + b.h + 3 && a.y + a.h + 3 > b.y

/** Screen-space collision placement; called at most once per ten simulation ticks. */
export function placeLabels(points: LabelPoint[], width: number, height: number, mobile: boolean, previous = new Map<string, LabelPosition>()) {
  const placed: Box[] = []
  const cores = points.map(p => ({ x: p.x - p.core, y: p.y - p.core, w: p.core * 2, h: p.core * 2 }))
  const priority = (p: LabelPoint) => p.selected ? 0 : p.root ? 1 : p.journey ? 2 : 3
  const ordered = [...points].sort((a, b) => priority(a) - priority(b) || (b.match ?? -1) - (a.match ?? -1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const result = new Map<string, LabelPosition>()
  for (const p of ordered) {
    let sides: Side[] = mobile ? ['below'] : ['right', 'left', 'below']
    const old = previous.get(p.id)
    if (old && !old.hidden && sides.includes(old.side)) sides = [old.side, ...sides.filter(s => s !== old.side)]
    let found: LabelPosition | undefined
    for (const sub of p.subWidth ? [true, false] : [false]) {
      for (const side of sides) {
        const w = Math.max(p.mainWidth, sub ? p.subWidth : 0)
        const x = side === 'right' ? 18 : side === 'left' ? -18 : 0
        const y = side === 'below' ? p.ring + 4 : -8
        const box = { x: p.x + x - (side === 'left' ? w : side === 'below' ? w / 2 : 0), y: p.y + y, w, h: sub ? 30 : 15 }
        if (box.x < 8 || box.y < 8 || box.x + w > width - 8 || box.y + box.h > height - 8 || placed.some(b => overlaps(box, b)) || cores.some(b => overlaps(box, b))) continue
        found = { side, x, y, anchor: side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle', sub, hidden: false }
        placed.push(box)
        break
      }
      if (found) break
    }
    result.set(p.id, found ?? { side: 'below', x: 0, y: p.ring + 4, anchor: 'middle', sub: false, hidden: true })
  }
  return result
}

export function journeyPath(stops: string[], positions: Map<string, { x?: number; y?: number }>) {
  if (stops.length < 2) return ''
  let path = '', connected = false
  for (const id of stops) {
    const point = positions.get(id)
    if (point?.x == null || point.y == null) { connected = false; continue }
    path += `${connected ? 'L' : 'M'}${point.x},${point.y}`
    connected = true
  }
  return path
}
