// Exercise App's rendered elements and callbacks without a DOM or browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const source = ts.transpileModule(readFileSync(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const graph = (kind = 'artist', count = 2, stops = 2) => ({
  nodes: new Map(Array.from({ length: count }, (_, i) => [String(i), { id: String(i), name: i ? `Node ${i}` : 'Radiohead', kind }])),
  edges: new Map(), rootId: '0', journey: Array.from({ length: stops }, (_, i) => String(i)),
})
function render(savedMap, activeGraph = graph('artist', 0, 0), saveResult = 'saved') {
  const effects = [], updates = [], timers = [], restores = []
  const SearchBar = () => null
  const mocks = {
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, (value) => updates.push(value)],
      useRef: (current) => ({ current }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
    },
    './graph/mapSnapshot': { readMap: () => savedMap, clearMap() {}, saveMap: () => saveResult },
    './graph/useMusicGraph': { useMusicGraph: () => ({ graph: activeGraph, nodes: [...activeGraph.nodes.values()],
      edges: [], restore: (value) => restores.push(value) }) },
    './components/SearchBar': { SearchBar },
    './bookmarks': { readBookmarks: () => [] },
    './exclusions': { readExclusions: () => [] },
  }
  const exports = {}
  runInNewContext(source, {
    exports, require: (name) => name === 'react/jsx-runtime' ? require(name) : mocks[name] ?? {},
    localStorage: { getItem: () => null },
    window: { clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      addEventListener() {}, removeEventListener() {} },
  })
  const tree = exports.default()
  const elements = []
  function visit(element) {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(tree)
  return { elements, updates, timers, restores, effects, SearchBar }
}
const content = (element) => [element.props?.children].flat(Infinity).map((child) =>
  typeof child === 'object' && child ? content(child) : child ?? '').join('')
const ready = (value) => ({ status: 'ready', snapshot: { graph: value, followJourney: false } })

test('Resume restores the graph and announces Map restored. for four seconds', () => {
  const value = graph()
  const app = render(ready(value))
  app.elements.find((el) => el.type === 'button' && content(el) === 'Resume').props.onClick()
  assert.equal(app.restores[0], value)
  assert.ok(app.updates.some((value) => value?.msg === 'Map restored.'), 'Resume must announce Map restored.')
  assert.equal(app.timers.at(-1).ms, 4000)
})

test('resume card describes both modes, minimum/maximum sizes, and absent/present stops', () => {
  for (const kind of ['artist', 'track']) for (const count of [1, 500]) for (const stops of [0, 1, count]) {
    const app = render(ready(graph(kind, count, stops)))
    const description = app.elements.find((el) => el.type === 'section').props.children
    const expected = `${kind === 'track' ? 'Song' : 'Artist'} map from “Radiohead” · ${count} ${kind === 'track' ? 'songs' : 'artists'}${stops ? ` · ${stops} stops` : ''}`
    assert.ok(content({ props: { children: description } }).includes(expected), expected)
  }
})

test('card reuses taste-import before search with accessible name and ghost Start fresh', () => {
  const app = render(ready(graph()))
  const card = app.elements.find((el) => el.type === 'section')
  assert.ok(card.props.className.split(' ').includes('taste-import'))
  assert.equal(card.props['aria-label'], 'Resume last map')
  assert.ok(app.elements.indexOf(card) < app.elements.findIndex((el) => el.type === app.SearchBar))
  assert.equal(app.elements.find((el) => el.type === 'button' && content(el) === 'Start fresh').props.className, 'btn btn--ghost')
})

test('invalid snapshot uses prescribed detail and only Start fresh; no snapshot hides card', () => {
  const app = render({ status: 'invalid' })
  const card = app.elements.find((el) => el.type === 'section')
  assert.ok(content(card).includes('It was damaged or too large to load.'))
  assert.equal(app.elements.filter((el) => el.type === 'button' && content(el) === 'Resume').length, 0)
  assert.equal(render({ status: 'none' }).elements.filter((el) => el.type === 'section').length, 0)
})

test('oversize toast uses prescribed copy and appears only once per session', () => {
  const app = render({ status: 'none' }, graph(), 'too-large')
  // Find the map-saving effect by content: other effects may be declared before it.
  app.effects.find((fn) => String(fn).includes('saveMap'))()
  app.timers[0].fn()
  app.timers[0].fn()
  const messages = app.updates.filter((value) => value?.msg)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].msg, 'This map is too large to keep for next time.')
})
