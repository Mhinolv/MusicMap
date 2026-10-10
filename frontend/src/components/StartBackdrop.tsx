import { useEffect, useMemo, useRef, useState } from 'react'
import { contourPaths } from '../startBackdrop'

/** Static topographic contour lines behind the start screen (#46, concept A). Decorative only. */
export function StartBackdrop() {
  const ref = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0, mobile: false })
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    let timer: number | undefined
    const measure = () => {
      const { width, height } = svg.getBoundingClientRect()
      setSize({ width: Math.round(width), height: Math.round(height), mobile: window.matchMedia('(max-width: 640px)').matches })
    }
    const observer = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(measure, 120) })
    observer.observe(svg)
    measure()
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [])
  const paths = useMemo(() => contourPaths(size.width, size.height, size.mobile), [size])
  // Calmer under the panel column: desktop fades in left to right, mobile top to bottom.
  const fade = size.mobile ? { x2: 0, y2: 1, stop: 0.45 } : { x2: 1, y2: 0, stop: 0.55 }
  return (
    <svg ref={ref} className="start-backdrop" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="start-backdrop-fade" x1={0} y1={0} x2={fade.x2} y2={fade.y2}>
          <stop offset={0} stopColor="#fff" stopOpacity={0.35} />
          <stop offset={fade.stop} stopColor="#fff" stopOpacity={1} />
        </linearGradient>
        <mask id="start-backdrop-mask">
          <rect width={size.width} height={size.height} fill="url(#start-backdrop-fade)" />
        </mask>
      </defs>
      <g mask="url(#start-backdrop-mask)" fill="none" strokeWidth={1} strokeLinecap="round">
        <path className="contour-minor" d={paths.minor} stroke="var(--hairline)" />
        <path className="contour-index" d={paths.index} stroke="var(--sky-1)" />
      </g>
    </svg>
  )
}
