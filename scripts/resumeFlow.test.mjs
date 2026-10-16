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
const sheet = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../frontend/src/sheet.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(sheet)
const graph = (kind = 'artist', count = 2, stops = 2) => ({
  nodes: new Map(Array.from({ length: count }, (_, i) => [String(i), { id: String(i), name: i ? `Node ${i}` : 'Radiohead', kind }])),
  edges: new Map(), rootId: '0', journey: Array.from({ length: stops }, (_, i) => String(i)),
})
// #77: the start screen shows history entry 0; `savedMap` is how that entry decodes.
const entry = (id = 's1', seed = 'Radiohead') => ({ id, seed, mode: 'artist', stops: 1, updatedAt: 1, map: `{"map":"${id}"}` })
function render(savedMap, activeGraph = graph('artist', 0, 0), saveResult = 'saved', { bookmarks = [], exclusions = [], history } = {}) {
  const effects = [], updates = [], timers = [], restores = [], written = [], cleared = []
  const sessions = history ?? (savedMap.status === 'none' ? [] : [entry()])
  const SearchBar = () => null, StartScreen = () => null, LibraryButton = () => null, LibraryDrawer = () => null, MapNavPane = () => null
  const mocks = {
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, (value) => updates.push(value)],
      useRef: (current) => ({ current }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
    },
    './graph/mapSnapshot': { decodeMap: () => savedMap, clearMap: () => cleared.push('map'), saveMap: () => saveResult,
      encodeMap: (value) => saveResult === 'too-large' ? 'too-large' : `{"nodes":${value.nodes.size}}` },
    './history': {
      readHistory: () => sessions, sessionMap: () => savedMap, newSessionId: () => 'new-id',
      writeHistory: (next) => { written.push(next); return true },
      sessionFromGraph: (id, value, map) => ({ id, seed: value.nodes.get(value.rootId)?.name, mode: 'artist', stops: value.journey.length, updatedAt: 2, map }),
      upsertSession: (list, s) => [s, ...list.filter((x) => x.id !== s.id)].slice(0, 5),
      restoreSessions: (list, removed) => [...list, ...removed.filter((r) => !list.some((x) => x.id === r.id))],
    },
    './graph/useMusicGraph': { useMusicGraph: () => ({ graph: activeGraph, nodes: [...activeGraph.nodes.values()],
      edges: [], undo: () => restores.push('undo'), restore: (value) => restores.push(value),
      resetArtist: (artist) => restores.push(['reset', artist.id]),
      select: (id) => restores.push(['select', id]), prune: (id, mode) => restores.push(['prune', id, mode]) }) },
    './components/SearchBar': { SearchBar },
    './components/StartScreen': { StartScreen },
    './components/LibraryDrawer': { LibraryButton, LibraryDrawer },
    './startScreen': helpers,
    './graph/onMap': onMap,
    './sheet': sheet,
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
  return { elements, updates, timers, restores, effects, written, cleared, SearchBar, LibraryButton, LibraryDrawer, MapNavPane,
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

test('start screen receives every snapshot state; DISCARD/START FRESH removes that session with Undo (#77)', () => {
  for (const saved of [{ status: 'none' }, { status: 'invalid' }, ready(graph('track', 500, 500))]) {
    const app = render(saved)
    assert.equal(app.start.props.savedMap, saved)
    assert.equal(app.elements.some((el) => el.props?.className === 'statusbar'), false)
    app.start.props.onStartFresh()
    if (saved.status === 'none') {
      assert.deepEqual(app.written, [])
      continue
    }
    assert.deepEqual(app.written.at(-1), [], 'Discard removes the session from history')
    assert.deepEqual(app.cleared, ['map'], 'and the single-map copy, so it cannot come back')
    const toast = app.updates.find((value) => value?.msg)
    assert.equal(toast.msg, 'Removed “Radiohead” from history.')
    toast.action.run()
    assert.deepEqual(app.written.at(-1).map((s) => s.id), ['s1'], 'Undo puts it back')
  }
  // The map shell replaces the start screen once a graph exists.
  assert.equal(render({ status: 'none' }, graph()).start, undefined)
})

test('history count, account wording and the All recent maps link reach the start screen (#77)', () => {
  for (const count of [0, 1, 2, 5]) {
    const history = Array.from({ length: count }, (_, i) => entry(`s${i}`, `Seed ${i}`))
    const app = render(count ? ready(graph()) : { status: 'none' }, undefined, 'saved', { history })
    assert.equal(app.start.props.historyCount, count)
    assert.equal(app.start.props.synced, false)
  }
  const app = render(ready(graph()))
  app.start.props.onAllRecent()
  assert.ok(app.updates.includes('history'), 'the link opens Library on History')
  assert.ok(app.updates.includes(true), 'and opens the drawer')
  app.start.props.onToggleLibrary()
  assert.equal(app.updates.at(-2), 'saved', 'the header button opens Library on Saved')
})

test('a new search starts a new session; autosave records it once and skips an unchanged map (#77)', () => {
  const active = graph('artist', 3, 1)
  const app = render({ status: 'none' }, active, 'saved', { history: [entry('old')] })
  app.elements.find((el) => el.type === app.SearchBar).props.onSelect({ id: '0', name: 'Radiohead' })
  assert.deepEqual(app.restores.at(-1), ['reset', '0'])
  assert.ok(app.updates.includes('new-id'), 'the open session id is the new one')
  const saving = app.effects.find((fn) => String(fn).includes('saveMap'))
  saving()
  app.timers.at(-1).fn()
  assert.equal(app.written.length, 1)
  assert.deepEqual(app.written[0].map((s) => s.id), ['new-id', 'old'], 'history keeps the earlier session')
  assert.equal(app.written[0][0].map, '{"nodes":3}')
  assert.equal(app.written[0][0].seed, 'Radiohead')
  // The same timer again, and a later render of the same map, do not save again.
  app.timers.at(-1).fn()
  saving()
  app.timers.at(-1).fn()
  assert.equal(app.written.length, 1)
})

test('Resume reuses the start-screen path for a history row and marks it the open session (#77)', () => {
  const value = graph()
  const app = render(ready(value), undefined, 'saved', { history: [entry('s1'), entry('s2', 'Björk')] })
  app.start.props.onResume()
  assert.equal(app.restores[0], value)
  assert.ok(app.updates.includes('s1'), 'the resumed row becomes the open session')
  assert.ok(app.updates.some((value) => value?.msg === 'Map restored.'))
  assert.deepEqual(app.written, [], 'an unchanged resumed map does not save on resume')
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
