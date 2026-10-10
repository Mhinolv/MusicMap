// Start-screen Contour backdrop (#46): geometry, markup, placement and CSS, without a DOM or browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8')
const load = (path, mocks = {}) => {
  const source = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function('exports', 'require', source)(exports, (name) => name === 'react/jsx-runtime' ? require(name) : mocks[name] ?? {})
  return exports
}
const geometry = load('startBackdrop.ts')
const { contourPaths, contourField, contourStep, CONTOUR_LEVELS, CONTOUR_STEP } = geometry

/** Every `M x yL x y` segment of a path string as [x1, y1, x2, y2]. */
const segments = (d) => {
  const out = []
  const re = /M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g
  let m, consumed = 0
  while ((m = re.exec(d))) { out.push(m.slice(1).map(Number)); consumed += m[0].length }
  assert.equal(consumed, d.length, 'path is only M..L.. segments')
  return out
}
const SIZES = [[1, 1], [6, 6], [390, 796], [640, 1200], [1440, 852], [1440, 552], [1060, 852], [3840, 2112]]

test('15 levels run 0.08 to 0.99 in 0.065 steps, every 4th an index line', () => {
  assert.equal(CONTOUR_LEVELS.length, 15)
  assert.equal(CONTOUR_LEVELS[0], 0.08)
  assert.equal(CONTOUR_LEVELS.at(-1), 0.99)
  for (let i = 1; i < CONTOUR_LEVELS.length; i++) assert.ok(Math.abs(CONTOUR_LEVELS[i] - CONTOUR_LEVELS[i - 1] - 0.065) < 1e-9)
})

test('empty or invalid sizes draw nothing', () => {
  for (const [w, h] of [[0, 0], [0, 900], [1440, 0], [-5, 10], [NaN, 10]]) for (const mobile of [false, true]) {
    assert.deepEqual(contourPaths(w, h, mobile), { minor: '', index: '' })
  }
})

test('contours are deterministic, in bounds, rounded to 1 decimal, with minor and index lines', () => {
  for (const mobile of [false, true]) for (const [w, h] of SIZES) {
    const paths = contourPaths(w, h, mobile)
    assert.deepEqual(paths, contourPaths(w, h, mobile))
    const step = contourStep(w, h)
    const all = [...segments(paths.minor), ...segments(paths.index)]
    for (const seg of all) for (const [i, v] of seg.entries()) {
      assert.ok(v >= 0 && v <= (i % 2 ? h : w) + step, `${v} inside ${w}x${h}`)
      assert.equal(Math.round(v * 10) / 10, v)
    }
    if (w >= 390) {
      assert.ok(segments(paths.minor).length > 100, `${w}x${h} has minor lines`)
      assert.ok(segments(paths.index).length > 10, `${w}x${h} has index lines`)
    }
  }
  assert.notDeepEqual(contourPaths(640, 900, false), contourPaths(640, 900, true), 'mobile uses its own hills')
})

test('isolines lie on their level: segment ends interpolate the field', () => {
  const [w, h] = [1440, 852]
  const f = contourField(w, h, false)
  // Every endpoint sits on a grid edge, so one coordinate is a multiple of the step.
  for (const [x1, y1] of segments(contourPaths(w, h, false).index).slice(0, 200)) {
    assert.ok(x1 % CONTOUR_STEP === 0 || y1 % CONTOUR_STEP === 0 || Math.abs((x1 % CONTOUR_STEP) - CONTOUR_STEP) < 0.1 || Math.abs((y1 % CONTOUR_STEP) - CONTOUR_STEP) < 0.1)
    const v = f(x1, y1)
    assert.ok([3, 7, 11].some((n) => Math.abs(v - CONTOUR_LEVELS[n]) < 0.02), `index endpoint ${x1},${y1} = ${v}`)
  }
  // Desktop terrain rises to the right: the highest hill sits at 86% across, the left edge stays low.
  assert.ok(f(0.86 * w, 0.3 * h) > 0.9)
  assert.ok(f(0, 0) < 0.15)
})

test('grid is 6px up to large screens and coarsens on huge ones so the cost stays bounded', () => {
  assert.equal(contourStep(1440, 900), 6)
  assert.equal(contourStep(390, 844), 6)
  assert.equal(contourStep(1920, 1080), 6)
  for (const [w, h] of [[3840, 2160], [7680, 4320]]) {
    const step = contourStep(w, h)
    assert.ok(step > 6)
    assert.ok((w / step + 1) * (h / step + 1) <= 65000)
  }
  const big = contourPaths(3840, 2112, false)
  assert.ok(big.minor.length + big.index.length < 2_000_000, 'path text stays a few hundred KB')
})

test('geometry is seeded only: no Math.random and no star field', () => {
  for (const path of ['startBackdrop.ts', 'components/StartBackdrop.tsx', 'components/StartScreen.tsx']) {
    const source = read(path)
    assert.ok(!source.includes('Math.random'), path)
    assert.ok(!source.includes('generateStarField'), path)
    assert.ok(!/constellation/.test(source), path)
  }
})

// ---- markup ------------------------------------------------------------------------

const visit = (element, out = []) => {
  if (!element || typeof element !== 'object') return out
  if (Array.isArray(element)) { for (const child of element) visit(child, out); return out }
  out.push(element)
  for (const child of [element.props?.children].flat(Infinity)) visit(child, out)
  return out
}
const renderBackdrop = (size) => {
  const react = {
    useState: (initial) => [size ?? initial, () => {}],
    useRef: (current) => ({ current }), useMemo: (fn) => fn(), useEffect: () => {},
  }
  const { StartBackdrop } = load('components/StartBackdrop.tsx', { react, '../startBackdrop': geometry })
  return { elements: visit(StartBackdrop()) }
}

test('StartBackdrop: one aria-hidden svg, masked minor and index paths in tokens only, nothing animated', () => {
  for (const mobile of [false, true]) {
    const { elements } = renderBackdrop({ width: mobile ? 390 : 1440, height: mobile ? 796 : 852, mobile })
    const [svg] = elements
    assert.equal(svg.type, 'svg')
    assert.equal(svg.props.className, 'start-backdrop')
    assert.equal(svg.props['aria-hidden'], 'true')
    assert.equal(svg.props.focusable, 'false')
    assert.equal(elements.filter((el) => el.type === 'svg').length, 1)
    assert.ok(!elements.some((el) => ['circle', 'text', 'animate', 'animateTransform'].includes(el.type)))
    const paths = elements.filter((el) => el.type === 'path')
    assert.deepEqual(paths.map((p) => p.props.stroke), ['var(--hairline)', 'var(--sky-1)'])
    assert.ok(paths.every((p) => p.props.d.length > 0))
    const group = elements.find((el) => el.type === 'g')
    assert.equal(group.props.mask, 'url(#start-backdrop-mask)')
    assert.equal(group.props.fill, 'none')
    assert.equal(group.props.strokeWidth, 1)
    const mask = elements.find((el) => el.type === 'mask')
    assert.equal(mask.props.id, 'start-backdrop-mask')
    const gradient = elements.find((el) => el.type === 'linearGradient')
    // Desktop fades in left to right over 55% of the width; mobile top to bottom over 45% of the height.
    assert.deepEqual([gradient.props.x2, gradient.props.y2], mobile ? [0, 1] : [1, 0])
    const stops = elements.filter((el) => el.type === 'stop').map((s) => [s.props.offset, s.props.stopOpacity])
    assert.deepEqual(stops, [[0, 0.35], [mobile ? 0.45 : 0.55, 1]])
  }
})

test('StartBackdrop draws nothing before its first measurement', () => {
  const { elements } = renderBackdrop()
  assert.deepEqual(elements.filter((el) => el.type === 'path').map((p) => p.props.d), ['', ''])
})

test('StartScreen renders StartBackdrop between the header and main', () => {
  const StartBackdrop = () => null, SearchBar = () => null, LibraryButton = () => null
  const react = { useMemo: (fn) => fn(), useState: (v) => [v, () => {}], useRef: (current) => ({ current }), useEffect: () => {} }
  const { StartScreen } = load('components/StartScreen.tsx', {
    react, '../startScreen': load('startScreen.ts'), './StartBackdrop': { StartBackdrop },
    './LibraryDrawer': { LibraryButton }, './SearchBar': { SearchBar },
  })
  for (const savedMap of [{ status: 'none' }, { status: 'invalid' }]) {
    const tree = StartScreen({ savedMap, search: { mode: 'artist' }, libraryCount: 0, libraryOpen: false, onToggleLibrary() {},
      libraryButton: { current: null }, onTaste() {}, onResume() {}, onStartFresh() {} })
    const top = tree.props.children.filter(Boolean)
    assert.deepEqual(top.map((el) => el.type === StartBackdrop ? 'backdrop' : el.type), ['header', 'backdrop', 'main'])
  }
})

// ---- CSS ---------------------------------------------------------------------------

const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
/** Body of the first top-level rule for exactly `selector`. */
const ruleBody = (selector) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))?.[2]

test('backdrop CSS: under the header, full width, never takes clicks; old start sky rules are gone', () => {
  const desktop = ruleBody('.start-backdrop')
  for (const decl of ['position: absolute', 'top: 48px', 'left: 0', 'width: 100%', 'height: calc(100% - 48px)', 'pointer-events: none']) {
    assert.ok(desktop.includes(decl), decl)
  }
  assert.match(css, /@media \(max-width: 640px\) \{[^@]*\n\s+\.start-backdrop \{ top: calc\(48px \+ env\(safe-area-inset-top\)\); \}/)
  assert.ok(!css.includes('.start-sky'))
  assert.ok(!/\.start-backdrop[^{]*\{[^}]*(animation|transition)/.test(css), 'static on every device')
  // Panels stay opaque above the backdrop; the header stays on top.
  assert.match(ruleBody('.start-panel'), /background: var\(--pane\)/)
  assert.match(ruleBody('.start'), /position: relative/)
  assert.match(ruleBody('.start-header'), /z-index: 5/)
})
