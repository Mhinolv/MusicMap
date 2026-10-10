import type { MusicGraph } from './types'

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Library row age from `savedAt`, by local calendar day; empty when unknown (0). */
export function savedWhen(savedAt: number, now = Date.now()): string {
  if (!savedAt) return ''
  const day = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS }
  const days = Math.max(0, Math.round(day(now) - day(savedAt)))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const date = new Date(savedAt)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** Resume panel copy. The map snapshot has no timestamp, so links stand in for "opened". */
export function resumeSummary(graph: MusicGraph) {
  const root = graph.rootId ? graph.nodes.get(graph.rootId) : undefined
  const song = root?.kind === 'track'
  const stops = graph.journey.length
  const last = stops > 1 ? graph.nodes.get(graph.journey[stops - 1]) : undefined
  return {
    mode: song ? 'Song' : 'Artist', countLabel: song ? 'Songs' : 'Artists',
    stops, nodes: graph.nodes.size, links: graph.edges.size,
    title: last && root && last.id !== root.id ? `${root.name} › ${last.name}` : root?.name ?? '',
  }
}

export const MINI_MAP_CAP = 40
export type MiniStar = { id: string; x: number; y: number; r: number; tone: 'amber' | 'cyan' | 'star' }
export type MiniMap = { stars: MiniStar[]; links: { id: string; x1: number; y1: number; x2: number; y2: number }[]; journey: string }

// 200×120 thumbnail: the root sits left of centre and the rings stretch further to the right.
const CX = 72, CY = 60, RX_RIGHT = 112, RX_LEFT = 56, RY = 48
const round = (v: number) => Math.round(v * 10) / 10

/** Deterministic radial layout of a saved map, capped so huge maps stay cheap to draw. */
export function miniMap(graph: MusicGraph, cap = MINI_MAP_CAP): MiniMap {
  const rootId = graph.rootId
  if (!rootId || !graph.nodes.has(rootId) || cap < 1) return { stars: [], links: [], journey: '' }
  const parentOf = (id: string) => {
    const parent = graph.nodes.get(id)?.parentId
    return parent && parent !== id && graph.nodes.has(parent) ? parent : rootId
  }
  const children = new Map<string, string[]>()
  for (const id of graph.nodes.keys()) {
    if (id === rootId) continue
    const parent = parentOf(id)
    children.set(parent, [...children.get(parent) ?? [], id])
  }

  // Root first, then journey stops with their ancestors, then breadth-first.
  const included = new Set([rootId])
  for (const stop of graph.journey) {
    const chain: string[] = []
    for (let id = stop; graph.nodes.has(id) && !included.has(id) && chain.length < graph.nodes.size; id = parentOf(id)) chain.push(id)
    for (const id of chain.reverse()) if (included.size < cap) included.add(id)
  }
  const queue = [rootId]
  for (let i = 0; i < queue.length && included.size < cap; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (included.size >= cap) break
      included.add(child)
      queue.push(child)
    }
  }

  const kids = (id: string) => (children.get(id) ?? []).filter((child) => included.has(child))
  const leaves = new Map<string, number>()
  const countLeaves = (id: string): number => {
    const value = kids(id).reduce((sum, child) => sum + countLeaves(child), 0) || 1
    leaves.set(id, value)
    return value
  }
  countLeaves(rootId)
  const polar = new Map<string, { angle: number; depth: number }>([[rootId, { angle: 0, depth: 0 }]])
  const wedge = new Map<string, number>()
  const place = (id: string, start: number, span: number, depth: number) => {
    let at = start
    for (const child of kids(id)) {
      const share = span * leaves.get(child)! / leaves.get(id)!
      polar.set(child, { angle: at + share / 2, depth: depth + 1 })
      if (depth === 0) wedge.set(child, at + share / 2)
      place(child, at, share, depth + 1)
      at += share
    }
  }
  place(rootId, 0, Math.PI * 2, 0)

  // Point the branch holding the journey (else the selection, else the first child) to the right.
  const lead = [graph.journey[1], graph.selectedNodeId, kids(rootId)[0]].find((id) => id && included.has(id) && id !== rootId)
  let top = lead
  for (let hops = 0; top && parentOf(top) !== rootId && hops < graph.nodes.size; hops++) top = parentOf(top)
  const turn = top ? -(wedge.get(top) ?? 0) : 0
  const depthMax = Math.max(1, ...[...polar.values()].map((p) => p.depth))
  const points = new Map<string, { x: number; y: number }>()
  for (const [id, { angle, depth }] of polar) {
    const a = angle + turn, u = depth / depthMax
    points.set(id, { x: round(CX + Math.cos(a) * u * (Math.cos(a) >= 0 ? RX_RIGHT : RX_LEFT)), y: round(CY + Math.sin(a) * u * RY) })
  }

  const stops = new Set(graph.journey)
  const stars: MiniStar[] = [...points].map(([id, p]) => {
    const tone = id === graph.selectedNodeId ? 'cyan' : id === rootId || stops.has(id) ? 'amber' : 'star'
    return { id, ...p, tone, r: id === rootId || tone === 'cyan' ? 5 : tone === 'amber' ? 4 : 2.5 }
  })
  const links = [...graph.edges.values()].flatMap((edge) => {
    const a = points.get(edge.source), b = points.get(edge.target)
    return a && b ? [{ id: edge.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : []
  })
  const path = graph.journey.flatMap((id) => points.get(id) ?? [])
  const journey = path.length > 1 ? path.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') : ''
  // Draw dim stars first so amber and cyan stay on top.
  const order = { star: 0, amber: 1, cyan: 2 }
  return { stars: stars.sort((a, b) => order[a.tone] - order[b.tone]), links, journey }
}
