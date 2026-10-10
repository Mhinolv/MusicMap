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
const helpers = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../frontend/src/startScreen.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(helpers)
const onMap = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../frontend/src/graph/onMap.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(onMap)
const graph = (kind = 'artist', count = 2, stops = 2) => ({
  nodes: new Map(Array.from({ length: count }, (_, i) => [String(i), { id: String(i), name: i ? `Node ${i}` : 'Radiohead', kind }])),
  edges: new Map(), rootId: '0', journey: Array.from({ length: stops }, (_, i) => String(i)),
})
function render(savedMap, activeGraph = graph('artist', 0, 0), saveResult = 'saved', { bookmarks = [], exclusions = [] } = {}) {
  const effects = [], updates = [], timers = [], restores = []
  const SearchBar = () => null, StartScreen = () => null, LibraryButton = () => null, LibraryDrawer = () => null, MapNavPane = () => null
  const mocks = {
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, (value) => updates.push(value)],
      useRef: (current) => ({ current }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
    },
    './graph/mapSnapshot': { readMap: () => savedMap, clearMap() {}, saveMap: () => saveResult },
    './graph/useMusicGraph': { useMusicGraph: () => ({ graph: activeGraph, nodes: [...activeGraph.nodes.values()],
      edges: [], undo: () => restores.push('undo'), restore: (value) => restores.push(value),
      select: (id) => restores.push(['select', id]), prune: (id, mode) => restores.push(['prune', id, mode]) }) },
    './components/SearchBar': { SearchBar },
    './components/StartScreen': { StartScreen },
    './components/LibraryDrawer': { LibraryButton, LibraryDrawer },
    './startScreen': helpers,
    './graph/onMap': onMap,
    './components/MapNavPane': { MapNavPane },
    './bookmarks': { readBookmarks: () => bookmarks },
    './exclusions': { readExclusions: () => exclusions },
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
  return { elements, updates, timers, restores, effects, SearchBar, LibraryButton, LibraryDrawer, MapNavPane,
    start: elements.find((el) => el.type === StartScreen) }
}
const content = (element) => [element.props?.children].flat(Infinity).map((child) =>
  typeof child === 'object' && child ? content(child) : child ?? '').join('')
const ready = (value) => ({ status: 'ready', snapshot: { graph: value, followJourney: false } })

test('Resume restores the graph and announces Map restored. for four seconds', () => {
  const value = graph()
  const app = render(ready(value))
  app.start.props.onResume()
  assert.equal(app.restores[0], value)
  assert.ok(app.updates.some((value) => value?.msg === 'Map restored.'), 'Resume must announce Map restored.')
  assert.equal(app.timers.at(-1).ms, 4000)
})

test('start screen receives every snapshot state; DISCARD/START FRESH clears it to none', () => {
  for (const saved of [{ status: 'none' }, { status: 'invalid' }, ready(graph('track', 500, 500))]) {
    const app = render(saved)
    assert.equal(app.start.props.savedMap, saved)
    assert.equal(app.elements.some((el) => el.props?.className === 'statusbar'), false)
    app.start.props.onStartFresh()
    assert.equal(app.updates.at(-1).status, 'none')
  }
  // The map shell replaces the start screen once a graph exists.
  assert.equal(render({ status: 'none' }, graph()).start, undefined)
})

// #24: the entry count covered bookmarks only ("Open saved discoveries (0)" with exclusions saved).
test('LIBRARY count is saved + not suggested on the start screen and in the map header', () => {
  const song = (id) => ({ kind: 'track', item: { id, name: id, artist: { id: 'a', name: 'A' } }, savedAt: 0 })
  for (const [bookmarks, exclusions] of [[0, 0], [0, 1], [2, 0], [3, 4], [200, 100]]) {
    const lists = { bookmarks: Array.from({ length: bookmarks }, (_, i) => song(`b${i}`)), exclusions: Array.from({ length: exclusions }, (_, i) => song(`e${i}`)) }
    assert.equal(render({ status: 'none' }, undefined, 'saved', lists).start.props.libraryCount, bookmarks + exclusions)
    const map = render({ status: 'none' }, graph(), 'saved', lists)
    assert.equal(map.elements.find((el) => el.type === map.LibraryButton).props.count, bookmarks + exclusions)
  }
})

test('LIBRARY toggles the non-modal drawer, and the drawer only renders while open', () => {
  const app = render({ status: 'none' })
  assert.equal(app.start.props.libraryOpen, false)
  assert.equal(app.elements.some((el) => el.type === app.LibraryDrawer), false)
  app.start.props.onToggleLibrary()
  const toggle = app.updates.at(-1)
  assert.equal(typeof toggle, 'function')
  assert.equal(toggle(false), true)
  assert.equal(toggle(true), false)
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


test('both shell modes retain live counts, an empty dock, and inspector-before-graph DOM order', () => {
  for (const kind of ['artist', 'track']) for (const count of [1, 500]) {
    const app = render({ status: 'none' }, graph(kind, count))
    const inspector = app.elements.find((el) => el.props?.className === 'inspector-dock')
    const nav = app.elements.find((el) => el.props?.className === 'map-nav')
    const stage = app.elements.find((el) => el.props?.className === 'stage ')
    assert.ok(app.elements.indexOf(inspector) < app.elements.indexOf(nav))
    assert.ok(app.elements.indexOf(nav) < app.elements.indexOf(stage))
    assert.ok(content(inspector).includes('Select a star to inspect it. Double-click to expand.'))
    const counts = app.elements.find((el) => el.props?.className === 'statusbar__counts')
    assert.equal(counts.props['aria-live'], 'polite')
    // #24 plurals: "1 song", never "1 songs".
    const noun = kind === 'track' ? 'song' : 'artist'
    assert.equal(content(counts), `${count} ${count === 1 ? noun : `${noun}s`} · 0 links`)
  }
})

test('header Undo is guarded without history and restores the graph with history', () => {
  for (const available of [false, true]) {
    const active = graph()
    if (available) active.undo = { seq: 1, summary: 'Removed branch' }
    const app = render({ status: 'none' }, active)
    const undo = app.elements.find((el) => el.props?.className?.includes('header-undo'))
    assert.equal(undo.props['aria-disabled'], !available)
    undo.props.onClick()
    assert.deepEqual(app.restores, available ? ['undo'] : [])
  }
})

// #31 owner decision: ON MAP lists every node as soon as a search loads, in both modes.
test('left pane lists every non-root node, counts the root, and wires jump, follow and collapse', () => {
  for (const kind of ['artist', 'track']) for (const count of [1, 9]) {
    const app = render({ status: 'none' }, graph(kind, count, 1))
    const pane = app.elements.find((el) => el.type === app.MapNavPane)
    assert.equal(pane.props.className, 'map-nav')
    assert.equal(pane.props.songMode, kind === 'track')
    assert.equal(pane.props.count, count)
    assert.deepEqual(pane.props.rows.map((row) => row.id), Array.from({ length: count - 1 }, (_, i) => String(i + 1)))
    // Song maps only list expanded stops; this fixture's root is not expanded yet.
    assert.deepEqual(pane.props.stops.map((n) => n.id), kind === 'track' ? [] : ['0'])
    if (count > 1) {
      pane.props.onJump('3')
      assert.deepEqual(app.restores.at(-1), ['select', '3'])
      assert.equal(app.updates.at(-1).id, '3', 'jump also centres the node')
    }
    pane.props.onCollapse('0')
    assert.deepEqual(app.restores.at(-1), ['prune', '0', 'collapse'])
    pane.props.onFollowJourney()
    assert.equal(app.updates.at(-1)(false), true)
  }
})
