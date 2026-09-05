import * as d3 from 'd3'
import { useEffect, useMemo, useRef } from 'react'
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
  nodes: ArtistNode[]
  edges: ArtistEdge[]
  degree: Map<string, number>
  selectedId?: string
  rootId?: string
  focusId?: string
  journey: string[]
  onSelect: (id?: string) => void
  onExpand: (id: string) => void
  resetKey: number
  /** Pan so this node sits in the middle of the view. `nonce` lets the same id be requested twice. */
  centerRequest?: { id: string; nonce: number }
}

const NODE_MIN_R = 13
const NODE_MAX_R = 30
const LABEL_MAX = 22
const MAX_TIER = 3
// How much each tier shrinks relative to the focus.
const TIER_SCALE = [1, 0.92, 0.72, 0.58]
// Cluster layout tuning.
const HUB_LINK_DISTANCE = 260
const CROSS_LINK_STRENGTH = 0.08
const CLUSTER_PULL = 0.12
const SPAWN_DISTANCE = 90
const SPAWN_FAN = Math.PI * 0.9 // total arc new children are spread across

function baseRadius(d: SimNode): number {
  const r = NODE_MIN_R + Math.sqrt(d.degree) * 4.5
  return Math.min(NODE_MAX_R, d.isRoot ? Math.max(r, 20) : r)
}
function radius(d: SimNode): number {
  return baseRadius(d) * TIER_SCALE[Math.min(d.tier, MAX_TIER)]
}
function label(name: string): string {
  return name.length > LABEL_MAX ? name.slice(0, LABEL_MAX - 1) + '…' : name
}
/** Leaves label outward from their hub; hubs label below. */
function labelPlacement(d: SimNode, map: Map<string, SimNode>) {
  const r = radius(d)
  const p = !d.expanded && d.parentId ? map.get(d.parentId) : undefined
  if (!p || p.x == null || p.y == null || d.x == null || d.y == null) {
    return { x: 0, y: r + 16, anchor: 'middle', baseline: 'auto' }
  }
  const a = Math.atan2(d.y - p.y, d.x - p.x)
  const c = Math.cos(a)
  const sn = Math.sin(a)
  if (Math.abs(c) < 0.35) {
    return { x: 0, y: sn > 0 ? r + 16 : -(r + 8), anchor: 'middle', baseline: 'auto' }
  }
  const off = r + 8
  return { x: c * off, y: sn * off, anchor: c > 0 ? 'start' : 'end', baseline: 'central' }
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

export function ForceGraph({ nodes, edges, degree, selectedId, rootId, focusId, journey, onSelect, onExpand, resetKey, centerRequest }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const nodeMapRef = useRef(new Map<string, SimNode>())
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const callbacksRef = useRef({ onSelect, onExpand })
  callbacksRef.current = { onSelect, onExpand }

  const tiers = useMemo(() => computeTiers(focusId, nodes, edges), [focusId, nodes, edges])

  // ---- one-time setup: defs, layers, zoom, simulation --------------------------
  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    const grad = (id: string, from: string, to: string) => {
      const g = defs.append('radialGradient').attr('id', id).attr('cx', '35%').attr('cy', '30%').attr('r', '75%')
      g.append('stop').attr('offset', '0%').attr('stop-color', from)
      g.append('stop').attr('offset', '100%').attr('stop-color', to)
    }
    grad('grad-node', '#8fb4ff', '#4a63e7')
    grad('grad-expanded', '#a9c4ff', '#5f7cf0')
    grad('grad-focus', '#ffd08a', '#f0913f')
    grad('grad-root', '#ffe1a6', '#e8a84a')
    grad('grad-track', '#a6f2e3', '#2fb89c')
    grad('grad-track-expanded', '#c4f7ec', '#49c9ad')
    const glow = defs.append('filter').attr('id', 'glow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    glow.append('feGaussianBlur').attr('stdDeviation', 5).attr('result', 'blur')
    const merge = glow.append('feMerge')
    merge.append('feMergeNode').attr('in', 'blur')
    merge.append('feMergeNode').attr('in', 'SourceGraphic')
    const dots = defs
      .append('pattern')
      .attr('id', 'dots')
      .attr('width', 28)
      .attr('height', 28)
      .attr('patternUnits', 'userSpaceOnUse')
    dots.append('circle').attr('cx', 1).attr('cy', 1).attr('r', 1).attr('fill', 'rgba(255,255,255,0.06)')

    svg.append('rect').attr('class', 'backdrop').attr('width', '100%').attr('height', '100%').attr('fill', 'url(#dots)')

    const root = svg.append('g').attr('class', 'viewport')
    root.append('g').attr('class', 'links')
    root.append('g').attr('class', 'nodes')

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .filter((event) => !event.ctrlKey && !event.button)
      .on('zoom', (event) => {
        root.attr('transform', event.transform)
        svg.select('.backdrop').attr('transform', `translate(${event.transform.x % 28},${event.transform.y % 28})`)
      })
    svg.call(zoom).on('dblclick.zoom', null)
    svg.on('click', (event) => {
      const t = event.target as Element
      if (t === svgRef.current || t.classList.contains('backdrop')) callbacksRef.current.onSelect(undefined)
    })
    zoomRef.current = zoom

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
        const nodeG = root
          .select<SVGGElement>('.nodes')
          .selectAll<SVGGElement, SimNode>('g.node')
          .attr('transform', (d) => `translate(${d.x},${d.y})`)
        const map = nodeMapRef.current
        nodeG.select<SVGTextElement>('.node__label').each(function (d) {
          const p = labelPlacement(d, map)
          const t = d3.select(this)
          t.attr('x', p.x).attr('y', p.y).attr('text-anchor', p.anchor).attr('dominant-baseline', p.baseline)
          // The second line must restart at the same x to sit under the first.
          t.select('.node__label-sub').attr('x', p.x)
        })
      })
    simRef.current = sim

    const { width, height } = svgRef.current!.getBoundingClientRect()
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2))

    return () => {
      sim.stop()
    }
  }, [])

  // ---- new search: clear positions and re-centre --------------------------------
  useEffect(() => {
    nodeMapRef.current.clear()
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

    const simNodes: SimNode[] = nodes.map((n) => {
      seen.add(n.id)
      const tier = tiers.get(n.id) ?? MAX_TIER
      let s = map.get(n.id)
      if (!s) {
        const anchor = anchorFor(n)
        const angle = spawnAngle(n, anchor)
        const dist = SPAWN_DISTANCE + Math.random() * 20
        s = {
          id: n.id, name: n.name, kind: n.kind, subtitle: n.subtitle, expanded: n.expanded, loading: n.loading, error: n.error,
          degree: degree.get(n.id) ?? 0, isRoot: n.id === rootId, isNew: true, tier, parentId: n.parentId,
          x: (anchor?.x ?? 0) + Math.cos(angle) * dist,
          y: (anchor?.y ?? 0) + Math.sin(angle) * dist,
        }
        map.set(n.id, s)
      } else {
        Object.assign(s, {
          name: n.name, kind: n.kind, subtitle: n.subtitle, expanded: n.expanded, loading: n.loading, error: n.error,
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
      .transition()
      .duration(500)
      .attr('stroke-width', (d) => (1 + 2.5 * (d.similarity ?? 0.5)) * TIER_SCALE[Math.min(d.tier, MAX_TIER)])
      .attr('stroke-opacity', (d) => (0.3 + 0.6 * (d.similarity ?? 0.5)) * [1, 0.9, 0.5, 0.3][Math.min(d.tier, MAX_TIER)])

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
          g.append('circle').attr('class', 'node__glow').attr('r', 0)
          g.append('circle').attr('class', 'node__ring').attr('r', 0)
          g.append('circle').attr('class', 'node__body').attr('r', 0)
          g.append('circle').attr('class', 'node__shine').attr('r', 0)
          g.append('text').attr('class', 'node__glyph').attr('text-anchor', 'middle').attr('dy', '0.36em').text('♪')
          const text = g.append('text').attr('class', 'node__label').attr('text-anchor', 'middle')
          text.append('tspan').attr('class', 'node__label-main')
          text.append('tspan').attr('class', 'node__label-sub').attr('dy', '1.2em')
          const badge = g.append('g').attr('class', 'node__badge')
          badge.append('circle').attr('r', 8)
          badge.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
          g.transition().duration(500).style('opacity', 1)
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
    nodeSel.select<SVGCircleElement>('.node__body').transition().duration(450).attr('r', radius)
    nodeSel.select<SVGCircleElement>('.node__shine').transition().duration(450).attr('r', (d) => radius(d) * 0.55).attr('cx', (d) => -radius(d) * 0.25).attr('cy', (d) => -radius(d) * 0.3)
    nodeSel.select<SVGCircleElement>('.node__ring').transition().duration(450).attr('r', (d) => radius(d) + 4)
    nodeSel.select<SVGCircleElement>('.node__glow').transition().duration(450).attr('r', (d) => radius(d) + 6)
    nodeSel
      .select<SVGTextElement>('.node__glyph')
      .style('display', (d) => (d.kind === 'track' ? 'inline' : 'none'))
      .attr('font-size', (d) => radius(d) * 1.15)
    nodeSel.select<SVGTSpanElement>('.node__label-main').text((d) => label(d.name))
    nodeSel.select<SVGTSpanElement>('.node__label-sub').text((d) => (d.subtitle ? label(d.subtitle) : ''))
    nodeSel
      .select<SVGTextElement>('.node__label')
      .transition()
      .duration(450)
      .attr('font-size', (d) => 12 * (0.85 + 0.15 * TIER_SCALE[Math.min(d.tier, MAX_TIER)]))

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
  }, [nodes, edges, degree, rootId, focusId, tiers])

  // ---- exploration trail -------------------------------------------------------------
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const step = new Map(journey.map((id, i) => [id, i + 1]))
    const trailEdges = new Set<string>()
    for (let i = 1; i < journey.length; i++) {
      const a = journey[i - 1]
      const b = journey[i]
      trailEdges.add(a < b ? `${a}::${b}` : `${b}::${a}`)
    }
    const sel = d3.select(svg)
    const nodeSel = sel.selectAll<SVGGElement, SimNode>('g.node').classed('is-journey', (d) => step.has(d.id))
    nodeSel
      .select<SVGGElement>('.node__badge')
      .style('display', (d) => (step.has(d.id) ? null : 'none'))
      .attr('transform', (d) => `translate(${radius(d) * 0.75},${-radius(d) * 0.75})`)
      .select('text')
      .text((d) => step.get(d.id) ?? '')
    sel.selectAll<SVGLineElement, SimLink>('line.link').classed('is-trail', (d) => trailEdges.has(d.id))
  }, [journey, nodes, edges, tiers])

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
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <svg ref={svgRef} className="graph" role="img" aria-label="Artist relationship graph">
        <title>Artist relationship graph</title>
      </svg>
    </div>
  )
}
