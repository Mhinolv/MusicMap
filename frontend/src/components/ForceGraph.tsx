import * as d3 from 'd3'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { generateStarField, journeyPath, labelLines, placeLabels, SELECTED_OUTER_RING, starRadius } from '../graph/constellation'
import type { LabelPosition } from '../graph/constellation'
import type { ArtistEdge, ArtistNode, NodeKind } from '../types'

type SimNode = d3.SimulationNodeDatum & {
  id: string
  name: string
  kind: NodeKind
  expanded: boolean
  loading: boolean
  error?: string
  degree: number
  isRoot: boolean
  isNew: boolean
  /** 0 = focus node, 1 = its neighbours, 2, 3 = further away. */
  tier: number
  parentId?: string
  subtitle?: string
  match?: number
}

type SimLink = d3.SimulationLinkDatum<SimNode> & {
  id: string
  similarity?: number
  sharedTags?: string[]
  tier: number
  /** 'home' = hub to its own child, 'hub' = between two expanded nodes, 'cross' = everything else. */
  kind: 'home' | 'hub' | 'cross'
}

type Props = {
  zoomControl?: RefObject<(factor: number) => void>
  onZoom?: (k: number) => void
  nodes: ArtistNode[]
  edges: ArtistEdge[]
  degree: Map<string, number>
  selectedId?: string
  rootId?: string
  focusId?: string
  journey: string[]
  onSelect: (id?: string) => void
  onExpand: (id: string) => void
  fitOnMount?: boolean
  resetKey: number
  /** Pan so this node sits in the middle of the view. `nonce` lets the same id be requested twice. */
  centerRequest?: { id: string; nonce: number }
}

const NODE_MIN_R = 13
const NODE_MAX_R = 30
const MAX_TIER = 3
// How much each tier shrinks relative to the focus.
const TIER_SCALE = [1, 0.92, 0.72, 0.58]
// Cluster layout tuning.
const HUB_LINK_DISTANCE = 260
const CROSS_LINK_STRENGTH = 0.08
const CLUSTER_PULL = 0.12
const SPAWN_DISTANCE = 90
const SPAWN_FAN = Math.PI * 0.9 // total arc new children are spread across
// Touch: holding a finger on a node this long expands it (the double-click equivalent).
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP = 12

function baseRadius(d: SimNode): number {
  const r = NODE_MIN_R + Math.sqrt(d.degree) * 4.5
  return Math.min(NODE_MAX_R, d.isRoot ? Math.max(r, 20) : r)
}
function radius(d: SimNode): number {
  return baseRadius(d) * TIER_SCALE[Math.min(d.tier, MAX_TIER)]
}
/** Eat the synthetic click a browser fires after a touch, for a short window. */
function swallowNextClick() {
  const eat = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
    stop()
  }
  const stop = () => {
    window.clearTimeout(timer)
    document.removeEventListener('click', eat, true)
  }
  document.addEventListener('click', eat, true)
  const timer = window.setTimeout(stop, 500)
}

function endId(e: string | number | SimNode): string {
  return typeof e === 'object' ? e.id : String(e)
}

/** Breadth-first distance from the focus node, capped at MAX_TIER. */
function computeTiers(focusId: string | undefined, nodes: ArtistNode[], edges: ArtistEdge[]): Map<string, number> {
  const tiers = new Map<string, number>()
  if (!focusId) {
    for (const n of nodes) tiers.set(n.id, 1)
    return tiers
  }
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
  }
  const queue = [focusId]
  tiers.set(focusId, 0)
  while (queue.length) {
    const id = queue.shift()!
    const t = tiers.get(id)!
    if (t >= MAX_TIER) continue
    for (const next of adj.get(id) ?? []) {
      if (!tiers.has(next)) {
        tiers.set(next, t + 1)
        queue.push(next)
      }
    }
  }
  for (const n of nodes) if (!tiers.has(n.id)) tiers.set(n.id, MAX_TIER)
  return tiers
}

export function ForceGraph({ nodes, edges, degree, selectedId, rootId, focusId, journey, onSelect, onExpand, resetKey, centerRequest, fitOnMount, zoomControl, onZoom }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const nodeMapRef = useRef(new Map<string, SimNode>())
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  const callbacksRef = useRef({ onSelect, onExpand })
  callbacksRef.current = { onSelect, onExpand }
  const visualRef = useRef({ selectedId, focusId, journey })
  visualRef.current = { selectedId, focusId, journey }
  const renderRef = useRef<(labels?: boolean) => void>(() => {})
  const labelPositionsRef = useRef(new Map<string, LabelPosition>())
  // One long-press can be pending at a time; a second finger or any movement cancels it.
  const pressRef = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null)

  const tiers = useMemo(() => computeTiers(focusId, nodes, edges), [focusId, nodes, edges])

  // ---- one-time setup: layers, zoom, simulation --------------------------
  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    svg.selectAll('*').remove()

    svg.append('rect').attr('class', 'backdrop').attr('width', '100%').attr('height', '100%').attr('fill', 'transparent')
    const field = svg.append('g').attr('class', 'star-field').attr('aria-hidden', 'true').style('pointer-events', 'none')
    const media = window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 640px), (pointer: coarse)')
    let resizeTimer: number | undefined
    const drawField = () => {
      const { width, height } = svgRef.current!.getBoundingClientRect()
      const stars = generateStarField(width, height, window.matchMedia('(max-width: 640px)').matches)
      field.selectAll('*').remove()
      field.selectAll('circle.sky-halo').data(media.matches ? [] : stars.filter(s => s.soft)).join('circle').attr('class', 'sky-halo')
        .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 4).attr('fill', 'rgba(138,142,150,.35)')
      field.selectAll('circle.sky-dot').data(stars).join('circle').attr('class', 'sky-dot')
        .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => d.r).attr('fill', d => d.color)
      svg.classed('reduced-glow', media.matches)
      renderRef.current(true)
    }
    const fieldObserver = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(drawField, 120)
    })
    fieldObserver.observe(svgRef.current!)
    media.addEventListener('change', drawField)
    drawField()

    const root = svg.append('g').attr('class', 'viewport')
    root.append('g').attr('class', 'links')
    root.append('path').attr('class', 'journey-path').attr('aria-hidden', 'true')
    root.append('g').attr('class', 'nodes')

    let zoomFrame = 0
    let latestZoom = 1
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .filter((event) => !event.ctrlKey && !event.button)
      .on('zoom', (event) => {
        root.attr('transform', event.transform)
        latestZoom = event.transform.k
        if (!zoomFrame) zoomFrame = requestAnimationFrame(() => {
          zoomFrame = 0
          onZoomRef.current?.(latestZoom)
        })
        renderRef.current()
      })
      .on('end', () => renderRef.current(true))
    svg.call(zoom).on('dblclick.zoom', null)
    svg.on('click', (event) => {
      const t = event.target as Element
      if (t === svgRef.current || t.classList.contains('backdrop')) callbacksRef.current.onSelect(undefined)
    })
    // Long-pressing a node on a touch screen must not open the browser's context menu.
    svg.on('contextmenu', (event) => event.preventDefault())
    zoomRef.current = zoom

    let labelWidths = new WeakMap<SVGTextElement, { key: string; main: number; sub: number }>()
    renderRef.current = (labels = false) => {
      const { selectedId, focusId, journey } = visualRef.current
      const stops = new Set(journey)
      const transform = d3.zoomTransform(svgRef.current!)
      const k = transform.k
      const mobile = window.matchMedia('(max-width: 640px)').matches
      const { width, height } = svgRef.current!.getBoundingClientRect()
      const groups = root.selectAll<SVGGElement, SimNode>('g.node')
      const points: Parameters<typeof placeLabels>[0] = []
      groups.each(function(d) {
        const g = d3.select(this)
        const selected = d.id === selectedId
        const stop = d.isRoot || stops.has(d.id)
        const core = starRadius(d.match, d.degree, TIER_SCALE[Math.min(d.tier, MAX_TIER)], selected, stop)
        const ring = selected ? 22 : stop ? 15 : 13
        const color = selected ? 'var(--cyan)' : stop ? 'var(--amber)' : 'var(--star)'
        g.classed('is-selected', selected).classed('is-journey', stops.has(d.id)).attr('aria-pressed', selected)
        g.selectAll('circle').attr('transform', `scale(${1 / k})`)
        g.select('.node__hit').attr('r', 22)
        g.select('.node__body').attr('r', core).attr('fill', color)
        g.select('.node__ring').attr('r', ring).attr('stroke', selected || stop ? color : `rgba(201,203,207,${d.parentId === focusId ? 0.4 : 0.22})`).attr('stroke-width', selected ? 1.5 : 1)
        g.select('.node__outer').attr('r', SELECTED_OUTER_RING).style('display', selected ? '' : 'none')
        g.select('.node__focus').attr('r', ring + 4)
        g.select('.node__glow').attr('r', core + (selected ? 10 : 5)).attr('fill', color)
          .attr('opacity', selected ? 0.25 : 0.12).style('display', media.matches || (stop && !selected) ? 'none' : '')
        g.select('.node__label').attr('transform', `scale(${1 / k})`)
        if (!labels) return
        const lines = labelLines(d.name, d.subtitle, d.match, d.isRoot, mobile)
        const text = g.select<SVGTextElement>('.node__label').style('display', '').attr('transform', `scale(${1 / k})`)
        text.select('.node__label-main').text(lines.main)
        text.select('.node__label-sub').style('display', '').text(lines.sub)
        const [x, y] = transform.apply([d.x ?? 0, d.y ?? 0])
        // Cache font measurements; collision passes during ticks use only arithmetic.
        const key = JSON.stringify([lines.main, lines.sub, selected])
        let measured = labelWidths.get(text.node()!)
        if (measured?.key !== key) {
          measured = { key,
            main: text.select<SVGTSpanElement>('.node__label-main').node()!.getComputedTextLength(),
            sub: lines.sub ? text.select<SVGTSpanElement>('.node__label-sub').node()!.getComputedTextLength() : 0 }
          labelWidths.set(text.node()!, measured)
        }
        points.push({ id: d.id, name: d.name, x, y, core, ring, outer: selected ? SELECTED_OUTER_RING : undefined,
          mainWidth: measured.main, subWidth: measured.sub,
          selected, root: d.isRoot, journey: stops.has(d.id), match: d.match })
      })
      root.select('.journey-path').attr('d', journeyPath(journey, nodeMapRef.current))
      if (!labels) return
      const positions = placeLabels(points, width, height, mobile, labelPositionsRef.current)
      labelPositionsRef.current = positions
      groups.select<SVGTextElement>('.node__label').each(function(d) {
        const p = positions.get(d.id)!
        const text = d3.select(this).style('display', p.hidden ? 'none' : '')
          .attr('text-anchor', p.anchor).attr('dominant-baseline', 'hanging')
        text.select('.node__label-main').attr('x', p.x).attr('y', p.y)
        text.select('.node__label-sub').attr('x', p.x).attr('y', p.y + 16).style('display', p.sub ? '' : 'none')
      })
    }
    const fontReady = () => {
      labelWidths = new WeakMap()
      renderRef.current(true)
    }
    document.fonts?.addEventListener('loadingdone', fontReady)
    let ticks = 0

    // Pulls each leaf toward the hub that discovered it, so clusters stay compact.
    const clusterForce = (alpha: number) => {
      const map = nodeMapRef.current
      for (const n of map.values()) {
        if (n.expanded || !n.parentId) continue
        const p = map.get(n.parentId)
        if (!p || p.x == null || p.y == null || n.x == null || n.y == null) continue
        const k = CLUSTER_PULL * alpha
        n.vx = (n.vx ?? 0) + (p.x - n.x) * k
        n.vy = (n.vy ?? 0) + (p.y - n.y) * k
      }
    }

    const sim = d3
      .forceSimulation<SimNode, SimLink>()
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>()
          .id((d) => d.id)
          .distance((l) => {
            if (l.kind === 'hub') return HUB_LINK_DISTANCE
            if (l.kind === 'home') return 125 - 30 * (l.similarity ?? 0.5)
            return 160
          })
          .strength((l) => (l.kind === 'home' ? 0.9 : l.kind === 'hub' ? 0.6 : CROSS_LINK_STRENGTH)),
      )
      .force(
        'charge',
        d3
          .forceManyBody<SimNode>()
          .strength((d) => (d.expanded ? -1100 : -180))
          .distanceMax(900),
      )
      .force('collide', d3.forceCollide<SimNode>().radius((d) => radius(d) + 22).strength(0.9))
      .force('cluster', clusterForce)
      .force('x', d3.forceX(0).strength(0.02))
      .force('y', d3.forceY(0).strength(0.02))
      .alphaDecay(0.035)
      .velocityDecay(0.35)
      .on('tick', () => {
        root
          .select<SVGGElement>('.links')
          .selectAll<SVGLineElement, SimLink>('line')
          .attr('x1', (d) => (d.source as SimNode).x!)
          .attr('y1', (d) => (d.source as SimNode).y!)
          .attr('x2', (d) => (d.target as SimNode).x!)
          .attr('y2', (d) => (d.target as SimNode).y!)
        root
          .select<SVGGElement>('.nodes')
          .selectAll<SVGGElement, SimNode>('g.node')
          .attr('transform', (d) => `translate(${d.x},${d.y})`)
        root.select('.journey-path').attr('d', journeyPath(visualRef.current.journey, nodeMapRef.current))
        if (++ticks % 10 === 0) renderRef.current(true)
      })
      .on('end.labels', () => renderRef.current(true))
    simRef.current = sim

    const { width, height } = svgRef.current!.getBoundingClientRect()
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2))

    return () => {
      cancelAnimationFrame(zoomFrame)
      sim.stop()
      document.fonts?.removeEventListener('loadingdone', fontReady)
      fieldObserver.disconnect()
      media.removeEventListener('change', drawField)
      window.clearTimeout(resizeTimer)
      if (pressRef.current) window.clearTimeout(pressRef.current.timer)
      renderRef.current = () => {}
    }
  }, [])

  // ---- keep the view centred as the stage resizes ---------------------------------
  // On phones the graph area shrinks when the bottom sheet opens and grows back when
  // it closes; on any device the browser chrome can come and go. Shift the zoom
  // transform by half the size delta so whatever was in the middle stays there.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    let last = svg.getBoundingClientRect()
    const ro = new ResizeObserver(() => {
      const zoom = zoomRef.current
      const next = svg.getBoundingClientRect()
      const dx = (next.width - last.width) / 2
      const dy = (next.height - last.height) / 2
      last = next
      if (!zoom || next.width === 0 || next.height === 0 || (dx === 0 && dy === 0)) return
      const k = d3.zoomTransform(svg).k
      d3.select(svg).call(zoom.translateBy, dx / k, dy / k)
    })
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  // ---- new search: clear positions and re-centre --------------------------------
  useEffect(() => {
    nodeMapRef.current.clear()
    labelPositionsRef.current.clear()
    const svg = d3.select(svgRef.current!)
    if (zoomRef.current && svgRef.current) {
      const { width, height } = svgRef.current.getBoundingClientRect()
      svg.transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity.translate(width / 2, height / 2))
    }
  }, [resetKey])

  // ---- data join: nodes / edges / tiers changed ----------------------------------
  useEffect(() => {
    const sim = simRef.current
    const svg = svgRef.current
    if (!sim || !svg) return
    const map = nodeMapRef.current
    const seen = new Set<string>()

    const anchorFor = (n: ArtistNode): SimNode | undefined => {
      if (n.parentId && map.has(n.parentId)) return map.get(n.parentId)
      for (const e of edges) {
        const other = e.source === n.id ? e.target : e.target === n.id ? e.source : undefined
        if (other && map.has(other)) return map.get(other)
      }
      return undefined
    }
    // Group the brand-new nodes by hub so each batch fans out in a coherent arc.
    const newByHub = new Map<string, ArtistNode[]>()
    for (const n of nodes) {
      if (map.has(n.id)) continue
      const key = n.parentId ?? '__root__'
      newByHub.set(key, [...(newByHub.get(key) ?? []), n])
    }
    const spawnAngle = (n: ArtistNode, hub: SimNode | undefined): number => {
      const batch = newByHub.get(n.parentId ?? '__root__') ?? [n]
      const i = batch.indexOf(n)
      const count = batch.length
      let heading = Math.random() * Math.PI * 2
      if (hub) {
        const grand = hub.parentId ? map.get(hub.parentId) : undefined
        if (grand && grand.x != null && hub.x != null) {
          heading = Math.atan2(hub.y! - grand.y!, hub.x - grand.x) // away from where the hub came from
        } else {
          heading = -Math.PI / 2
        }
      }
      const fan = count > 1 ? SPAWN_FAN : 0
      return heading - fan / 2 + (count > 1 ? (fan * i) / (count - 1) : 0)
    }

    const matches = new Map<string, number>()
    const parents = new Map(nodes.map(n => [n.id, n.parentId]))
    for (const e of edges) {
      if (e.similarity == null) continue
      for (const [id, other] of [[e.source, e.target], [e.target, e.source]]) {
        if (!parents.get(id) || parents.get(id) === other) matches.set(id, Math.max(matches.get(id) ?? 0, e.similarity))
      }
    }

    const simNodes: SimNode[] = nodes.map((n) => {
      seen.add(n.id)
      const tier = tiers.get(n.id) ?? MAX_TIER
      let s = map.get(n.id)
      if (!s) {
        const anchor = anchorFor(n)
        const angle = spawnAngle(n, anchor)
        const dist = SPAWN_DISTANCE + Math.random() * 20
        s = {
          id: n.id, name: n.name, kind: n.kind, subtitle: n.subtitle, match: matches.get(n.id), expanded: n.expanded, loading: n.loading, error: n.error,
          degree: degree.get(n.id) ?? 0, isRoot: n.id === rootId, isNew: true, tier, parentId: n.parentId,
          x: (anchor?.x ?? 0) + Math.cos(angle) * dist,
          y: (anchor?.y ?? 0) + Math.sin(angle) * dist,
        }
        map.set(n.id, s)
      } else {
        Object.assign(s, {
          name: n.name, kind: n.kind, subtitle: n.subtitle, match: matches.get(n.id), expanded: n.expanded, loading: n.loading, error: n.error,
          degree: degree.get(n.id) ?? 0, isRoot: n.id === rootId, isNew: false, tier, parentId: n.parentId,
        })
      }
      return s
    })
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id)

    const simLinks: SimLink[] = edges
      .filter((e) => map.has(e.source) && map.has(e.target))
      .map((e) => {
        const a = map.get(e.source)!
        const b = map.get(e.target)!
        const kind: SimLink['kind'] =
          a.expanded && b.expanded ? 'hub' : a.parentId === b.id || b.parentId === a.id ? 'home' : 'cross'
        return {
          id: e.id, source: e.source, target: e.target, similarity: e.similarity ?? undefined,
          sharedTags: e.sharedTags,
          tier: Math.max(tiers.get(e.source) ?? MAX_TIER, tiers.get(e.target) ?? MAX_TIER), kind,
        }
      })

    const rootSel = d3.select(svg).select<SVGGElement>('.viewport')

    rootSel
      .select<SVGGElement>('.links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks, (d) => d.id)
      .join(
        (enter) => enter.append('line').attr('class', 'link').attr('stroke-opacity', 0),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('class', (d) => `link tier-${Math.min(d.tier, MAX_TIER)}`)
      // Native hover tooltip: why these two songs are linked. Silent on tagless edges.
      .each(function (d) {
        const line = d3.select(this)
        line.select('title').remove()
        if (d.sharedTags?.length) line.append('title').text(`Similar: ${d.sharedTags.join(', ')}`)
      })
      .attr('stroke-width', 1).attr('stroke-opacity', 1)

    const nodeSel = rootSel
      .select<SVGGElement>('.nodes')
      .selectAll<SVGGElement, SimNode>('g.node')
      .data(simNodes, (d) => d.id)
      .join(
        (enter) => {
          const g = enter
            .append('g')
            .attr('class', 'node')
            .attr('tabindex', 0)
            .attr('role', 'button')
            .attr('aria-label', (d) => d.name)
            .style('opacity', 0)
          g.append('circle').attr('class', 'node__hit').attr('r', 22).attr('fill', 'transparent')
          for (const name of ['glow', 'outer', 'ring', 'body', 'focus']) g.append('circle').attr('class', `node__${name}`)
          const text = g.append('text').attr('class', 'node__label')
          text.append('tspan').attr('class', 'node__label-main')
          text.append('tspan').attr('class', 'node__label-sub')
          g.transition().duration(500).style('opacity', 1).on('end', function() { d3.select(this).style('opacity', null) })
          g.on('click', (event, d) => {
            event.stopPropagation()
            callbacksRef.current.onSelect(d.id)
          })
            .on('dblclick', (event, d) => {
              event.stopPropagation()
              callbacksRef.current.onSelect(d.id)
              if (!d.expanded && !d.loading) callbacksRef.current.onExpand(d.id)
            })
            .on('keydown', (event, d) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                callbacksRef.current.onSelect(d.id)
                if (event.key === 'Enter' && event.shiftKey && !d.expanded) callbacksRef.current.onExpand(d.id)
              }
            })
          // Touch: press and hold to expand. Registered before the drag behaviour so it
          // still sees touchstart (d3-drag stops propagation to later listeners).
          const cancelPress = () => {
            if (pressRef.current) window.clearTimeout(pressRef.current.timer)
            pressRef.current = null
          }
          g.on('touchstart.press', (event: TouchEvent, d) => {
            cancelPress()
            if (event.touches.length !== 1) return
            const t = event.touches[0]
            const timer = window.setTimeout(() => {
              if (pressRef.current) pressRef.current.fired = true
              callbacksRef.current.onSelect(d.id)
              if (!d.expanded && !d.loading) callbacksRef.current.onExpand(d.id)
              navigator.vibrate?.(12)
            }, LONG_PRESS_MS)
            pressRef.current = { timer, x: t.clientX, y: t.clientY, fired: false }
          })
            .on('touchmove.press', (event: TouchEvent) => {
              const p = pressRef.current
              if (!p || p.fired) return
              const t = event.touches[0]
              if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_SLOP) cancelPress()
            })
            .on('touchend.press touchcancel.press', (event: TouchEvent) => {
              // Once the press has fired, the panel may already have slid in under the
              // finger; the browser's follow-up click must not land on whatever is there.
              if (pressRef.current?.fired) {
                event.preventDefault()
                swallowNextClick()
              }
              cancelPress()
            })
          return g
        },
        (update) => update,
        (exit) => exit.transition().duration(250).style('opacity', 0).remove(),
      )

    nodeSel
      .attr('class', (d) => `node tier-${Math.min(d.tier, MAX_TIER)}`)
      .classed('is-root', (d) => d.isRoot)
      .classed('is-track', (d) => d.kind === 'track')
      .classed('is-focus', (d) => d.id === focusId)
      .classed('is-expanded', (d) => d.expanded)
      .classed('is-loading', (d) => d.loading)
      .classed('has-error', (d) => !!d.error)
    nodeSel.attr('aria-label', d => [d.name, d.subtitle, d.isRoot ? 'ROOT' : ''].filter(Boolean).join(' · '))

    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.25).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0)
        d.fx = null
        d.fy = null
      })
    nodeSel.call(drag)

    sim.nodes(simNodes)
    sim.force<d3.ForceLink<SimNode, SimLink>>('link')!.links(simLinks)
    sim.force<d3.ForceManyBody<SimNode>>('charge')!.initialize(simNodes, Math.random)
    const anyNew = simNodes.some((n) => n.isNew)
    sim.alpha(anyNew ? 0.9 : 0.3).restart()
    renderRef.current(true)
  }, [nodes, edges, degree, rootId, focusId, tiers])

  // Visual priority and label placement update immediately, without React tick state.
  useEffect(() => { renderRef.current(true) }, [journey, selectedId, nodes, edges, tiers])

  // ---- selection highlighting ------------------------------------------------------
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const neighbours = new Set<string>()
    if (selectedId) {
      neighbours.add(selectedId)
      for (const e of edges) {
        if (e.source === selectedId) neighbours.add(e.target)
        if (e.target === selectedId) neighbours.add(e.source)
      }
    }
    const sel = d3.select(svg)
    sel
      .selectAll<SVGGElement, SimNode>('g.node')
      .classed('is-selected', (d) => d.id === selectedId)
      .classed('is-dimmed', (d) => !!selectedId && !neighbours.has(d.id))
    sel
      .selectAll<SVGLineElement, SimLink>('line.link')
      .classed('is-dimmed', (d) => !!selectedId && endId(d.source) !== selectedId && endId(d.target) !== selectedId)
  }, [selectedId, edges, nodes])

  // ---- jump to a node (journey trail) --------------------------------------------
  useEffect(() => {
    if (!centerRequest) return
    const svg = svgRef.current
    const zoom = zoomRef.current
    const target = nodeMapRef.current.get(centerRequest.id)
    if (!svg || !zoom || !target || target.x == null || target.y == null) return
    d3.select(svg).transition().duration(450).call(zoom.translateTo, target.x, target.y)
  }, [centerRequest])

  // ---- zoom controls ---------------------------------------------------------------
  const zoomBy = (factor: number) => {
    if (!svgRef.current || !zoomRef.current) return
    d3.select(svgRef.current).transition().duration(250).call(zoomRef.current.scaleBy, factor)
  }
  useEffect(() => {
    if (!zoomControl) return
    zoomControl.current = zoomBy
    return () => { zoomControl.current = () => {} }
  }, [zoomControl])

  const fit = () => {
    const svg = svgRef.current
    const zoom = zoomRef.current
    if (!svg || !zoom) return
    const pts = [...nodeMapRef.current.values()].filter((n) => n.x != null && n.y != null)
    const { width, height } = svg.getBoundingClientRect()
    if (pts.length === 0) {
      d3.select(svg).transition().duration(400).call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2))
      return
    }
    const [x0, x1] = d3.extent(pts, (p) => p.x!) as [number, number]
    const [y0, y1] = d3.extent(pts, (p) => p.y!) as [number, number]
    const pad = 80
    const w = x1 - x0 + pad * 2
    const h = y1 - y0 + pad * 2
    const k = Math.min(2, 0.95 / Math.max(w / width, h / height))
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    d3.select(svg)
      .transition()
      .duration(500)
      .call(zoom.transform, d3.zoomIdentity.translate(width / 2 - cx * k, height / 2 - cy * k).scale(k))
  }

  // Resume reconstructs layout locally, then fits once after the simulation settles.
  useEffect(() => {
    if (!fitOnMount) return
    const sim = simRef.current
    if (!sim) return
    sim.on('end.resume', () => {
      sim.on('end.resume', null)
      fit()
    })
    return () => { sim.on('end.resume', null) }
    // The request is consumed once per restored map, not on subsequent graph changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitOnMount, resetKey])

  return (
    <div className="graph-wrap">
      {/* DOM order: zoom controls come before the SVG so keyboard Tab reaches them
          before the graph's per-node tab stops, which can number in the dozens. */}
      <div className="zoom-controls" role="group" aria-label="Zoom">
        <button onClick={() => zoomBy(1.4)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button onClick={fit} aria-label="Fit graph to view" title="Fit to view">
          FIT
        </button>
      </div>
      <svg ref={svgRef} className="graph" role="img" aria-label="Music relationship graph">
        <title>Music relationship graph</title>
      </svg>
    </div>
  )
}
