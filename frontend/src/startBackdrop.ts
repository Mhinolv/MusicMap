// Start-screen backdrop (#46, concept A "Contour"): dim topographic isolines of unmapped ground.
// Pure and deterministic (no randomness) so the geometry can be tested without a DOM.

/** Gaussian hill: [cx as share of width, cy as share of height, sigma as share of max(w, h), height]. */
type Hill = readonly [number, number, number, number]

const DESKTOP_HILLS: readonly Hill[] = [[0.86, 0.30, 0.20, 1], [0.64, 1.00, 0.19, 0.85], [1.02, 0.86, 0.13, 0.62], [0.30, 1.10, 0.17, 0.55]]
const MOBILE_HILLS: readonly Hill[] = [[0.86, 0.66, 0.30, 1], [0.08, 1.02, 0.26, 0.8], [0.62, 0.36, 0.14, 0.42]]

/** Grid spacing in px; very large screens use a coarser grid so the sample count stays near 1440x900's. */
export const CONTOUR_STEP = 6
const MAX_SAMPLES = 60000
/** 15 isoline levels, 0.08 to 0.99 in 0.065 steps (as the approved mock draws); every 4th level is an index line. */
export const CONTOUR_LEVELS = Array.from({ length: 15 }, (_, n) => Math.round((0.08 + n * 0.065) * 1000) / 1000)

export type ContourPaths = { minor: string; index: string }

export function contourStep(width: number, height: number): number {
  return Math.max(CONTOUR_STEP, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)))
}

/** Field height at (x, y): Gaussian hills plus two faint ripples. */
export function contourField(width: number, height: number, mobile: boolean): (x: number, y: number) => number {
  const hills = mobile ? MOBILE_HILLS : DESKTOP_HILLS
  const size = Math.max(width, height)
  return (x, y) => {
    let v = 0.035 * Math.sin(x / 97 + y / 143) + 0.025 * Math.sin(x / 61 - y / 89)
    for (const [cx, cy, sigma, h] of hills) {
      const dx = x - cx * width, dy = y - cy * height, s = sigma * size
      v += h * Math.exp(-(dx * dx + dy * dy) / (2 * s * s))
    }
    return v
  }
}

const num = (n: number) => String(Math.round(n * 10) / 10)

/** Marching-squares isolines as two `M..L..` path strings: minor lines and index lines. */
export function contourPaths(width: number, height: number, mobile: boolean): ContourPaths {
  if (!(width > 0 && height > 0)) return { minor: '', index: '' }
  const f = contourField(width, height, mobile)
  const step = contourStep(width, height)
  const cols = Math.ceil(width / step) + 1, rows = Math.ceil(height / step) + 1
  const grid = new Float64Array(cols * rows)
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid[j * cols + i] = f(i * step, j * step)
  const minor: string[] = [], index: string[] = []
  CONTOUR_LEVELS.forEach((level, n) => {
    const out = n % 4 === 3 ? index : minor
    const t = (p: number, q: number) => (level - p) / (q - p)
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = grid[j * cols + i], b = grid[j * cols + i + 1], c = grid[(j + 1) * cols + i + 1], d = grid[(j + 1) * cols + i]
      const k = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0)
      if (k === 0 || k === 15) continue
      const x = i * step, y = j * step
      // Edge crossings: corners are a top-left, b top-right, c bottom-right, d bottom-left.
      const point = (edge: Edge) =>
        edge === 'top' ? `${num(x + step * t(a, b))} ${num(y)}`
        : edge === 'right' ? `${num(x + step)} ${num(y + step * t(b, c))}`
        : edge === 'bottom' ? `${num(x + step * t(d, c))} ${num(y + step)}`
        : `${num(x)} ${num(y + step * t(a, d))}`
      for (const [from, to] of SEGMENTS[k]) out.push(`M${point(from)}L${point(to)}`)
    }
  })
  return { minor: minor.join(''), index: index.join('') }
}

type Edge = 'top' | 'right' | 'bottom' | 'left'
/** Edge pairs per corner mask (a=8, b=4, c=2, d=1); saddles 5 and 10 draw two segments. */
const SEGMENTS: Record<number, [Edge, Edge][]> = {
  1: [['left', 'bottom']], 2: [['bottom', 'right']], 3: [['left', 'right']], 4: [['top', 'right']],
  5: [['left', 'top'], ['bottom', 'right']], 6: [['top', 'bottom']], 7: [['left', 'top']], 8: [['left', 'top']],
  9: [['top', 'bottom']], 10: [['left', 'bottom'], ['top', 'right']], 11: [['top', 'right']], 12: [['left', 'right']],
  13: [['bottom', 'right']], 14: [['left', 'bottom']],
}
