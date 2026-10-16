// #34: mobile tabbed sheet rules and the #24 combined expansion toast, run against App without a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const load = (path) => {
  const exports = {}
  new Function('exports', ts.transpileModule(readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText)(exports)
  return exports
}
const appSource = ts.transpileModule(readFileSync(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const startScreen = load('startScreen.ts')
const onMap = load('graph/onMap.ts')
const journey = load('graph/journey.ts')
const sheet = load('sheet.ts')

// ---- sheet state rules --------------------------------------------------------------

test('nothing selected: the sheet peeks on JOURNEY', () => {
  const initial = { tab: 'journey', size: 'peek' }
  assert.deepEqual(sheet.sheetForSelection(initial, undefined), initial)
  // Deselecting (Escape or ×) from any tab and size returns to peek on JOURNEY.
  for (const tab of sheet.SHEET_TABS) for (const size of ['peek', 'half', 'full']) {
    assert.deepEqual(sheet.sheetForSelection({ tab, size, selectionId: 'a' }, undefined), { tab: 'journey', size: 'peek' })
  }
})

test('selecting a node opens INSPECTOR at half, whatever the sheet showed before', () => {
  for (const tab of sheet.SHEET_TABS) for (const size of ['peek', 'half', 'full']) {
    for (const before of [undefined, 'a']) {
      assert.deepEqual(sheet.sheetForSelection({ tab, size, selectionId: before }, 'b'), { tab: 'inspector', size: 'half', selectionId: 'b' })
    }
  }
  assert.deepEqual(sheet.inspectorView('a'), { tab: 'inspector', size: 'half', selectionId: 'a' })
})

test('a tab or size chosen for the current selection is kept across renders', () => {
  for (const view of [{ tab: 'onmap', size: 'full', selectionId: 'a' }, { tab: 'journey', size: 'half', selectionId: undefined }]) {
    assert.equal(sheet.sheetForSelection(view, view.selectionId), view)
  }
})

test('handle: a tap cycles peek → half → full → peek; swipes step and stop at the ends', () => {
  assert.equal(sheet.resizeSheet('peek', 'tap'), 'half')
  assert.equal(sheet.resizeSheet('half', 'tap'), 'full')
  assert.equal(sheet.resizeSheet('full', 'tap'), 'peek')
  assert.equal(sheet.resizeSheet('peek', 'up'), 'half')
  assert.equal(sheet.resizeSheet('half', 'up'), 'full')
  assert.equal(sheet.resizeSheet('full', 'up'), 'full')
  assert.equal(sheet.resizeSheet('full', 'down'), 'half')
  assert.equal(sheet.resizeSheet('half', 'down'), 'peek')
  assert.equal(sheet.resizeSheet('peek', 'down'), 'peek')
})

test('tab keys: arrows wrap, Home and End jump, other keys are ignored', () => {
  assert.deepEqual(sheet.SHEET_TABS, ['inspector', 'journey', 'onmap'])
  assert.equal(sheet.tabForKey('inspector', 'ArrowRight'), 'journey')
  assert.equal(sheet.tabForKey('onmap', 'ArrowRight'), 'inspector')
  assert.equal(sheet.tabForKey('inspector', 'ArrowLeft'), 'onmap')
  assert.equal(sheet.tabForKey('journey', 'ArrowLeft'), 'inspector')
  assert.equal(sheet.tabForKey('onmap', 'Home'), 'inspector')
  assert.equal(sheet.tabForKey('inspector', 'End'), 'onmap')
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab']) assert.equal(sheet.tabForKey('journey', key), undefined)
})

// ---- App harness ----------------------------------------------------------------------

/** Renders App on a one-song map (or the given graph) at desktop or phone width. */
function harness({ result, narrow = false, graph: given } = {}) {
  const updates = [], selects = []
  const root = { id: 'root', kind: 'track', name: 'Creep', artist: { id: 'r', name: 'Radiohead' } }
  const graph = given ?? { nodes: new Map([['root', root]]), edges: new Map(), rootId: 'root', journey: [] }
  const mocks = {
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, (next) => updates.push(next)],
      useRef: (current) => ({ current }), useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect() {},
    },
    './api': { api: { trackSimilar: async () => result }, ApiError: class extends Error {} },
    './graph/mapSnapshot': { readMap: () => ({ status: 'none' }) },
    './history': { readHistory: () => [], sessionMap: () => ({ status: 'none' }) },
    './graph/useMusicGraph': {
      useMusicGraph: () => ({ graph, nodes: [...graph.nodes.values()], edges: [], select: (id) => selects.push(id),
        expandStart() {}, expandSuccess() {}, expandFailure() {} }),
      trackNode: (track, parentId) => ({ id: track.id, kind: 'track', name: track.name, parentId }),
      planPrune: () => null,
    },
    './graph/journey': journey,
    './graph/onMap': onMap,
    './bookmarks': { readBookmarks: () => [], nodeBookmark: () => null },
    './exclusions': { readExclusions: () => [] },
    './useTasteSync': { useTasteSync: () => ({ status: 'synced', edited() {} }) },
    './useLibrarySync': { useLibrarySync: () => ({ status: 'synced', edited() {} }) },
    './startScreen': startScreen,
    './sheet': sheet,
    './components/ForceGraph': { ForceGraph: 'ForceGraph' },
    './components/ArtistPanel': { ArtistPanel: 'ArtistPanel' },
    './components/MobileSheet': { MobileSheet: 'MobileSheet' },
    './components/MapNavPane': { MapNavPane: 'MapNavPane', JourneyList: 'JourneyList', OnMapList: 'OnMapList' },
    './components/LibraryDrawer': { LibraryButton: 'LibraryButton', LibraryDrawer: 'LibraryDrawer' },
    './components/SearchBar': { SearchBar: 'SearchBar' },
  }
  const exports = {}
  runInNewContext(appSource, {
    exports, require: (name) => name === 'react/jsx-runtime' ? require(name) : mocks[name] ?? {},
    window: {
      clearTimeout() {}, setTimeout: () => 0, addEventListener() {}, removeEventListener() {},
      matchMedia: (query) => ({ matches: narrow && query === sheet.NARROW_QUERY, addEventListener() {}, removeEventListener() {} }),
    },
  })
  const elements = []
  const visit = (element) => {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(exports.default())
  const find = (pred) => elements.find(pred)
  return {
    elements, updates, selects, find,
    expand: () => find((el) => el.type === 'ForceGraph').props.onExpand('root'),
    toasts: () => updates.filter((value) => value?.msg),
  }
}

const tracks = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `Song ${i}`, artist: { id: 'x', name: 'X' }, similarity: 0.5 }))
const ranking = (fallback_reason = null) => ({ mode: 'parent', stop_count: 1, fallback_reason })
const FALLBACK = "Couldn't follow the whole journey this time; ranked by this song."
const className = (el) => (typeof el.props?.className === 'string' ? el.props.className : '')

// ---- phone header and sheet -------------------------------------------------------------

test('phone header: TuneGraph, mode chip, find and library icons; no Taste or Undo', () => {
  const app = harness({ narrow: true })
  const header = app.find((el) => el.type === 'header')
  const inHeader = []
  const walk = (el) => {
    if (!el || typeof el !== 'object') return
    inHeader.push(el)
    for (const child of [el.props?.children].flat(Infinity)) walk(child)
  }
  walk(header)
  assert.equal(inHeader.some((el) => /header-taste|header-undo/.test(className(el))), false)
  const mode = inHeader.find((el) => className(el).includes('topbar__mode'))
  assert.equal(mode.props['aria-label'], 'Switch mode, currently Artist')
  mode.props.onClick()
  assert.equal(app.updates.at(-1), 'song')
  const find = inHeader.find((el) => className(el).includes('topbar__find'))
  assert.equal(find.props['aria-label'], 'Find an artist')
  find.props.onClick()
  assert.equal(app.updates.at(-1)(false), true, 'the search icon toggles the overlay')
  const library = inHeader.find((el) => el.type === 'LibraryButton')
  assert.equal(library.props.icon, true)
  assert.equal(library.props.count, 0)
  // The search field stays closed until the icon opens it.
  assert.equal(inHeader.some((el) => el.type === 'SearchBar'), false)
})

test('desktop header and panes are unchanged above 640px', () => {
  const app = harness({ narrow: false })
  assert.ok(app.find((el) => /header-taste/.test(className(el))))
  assert.ok(app.find((el) => /header-undo/.test(className(el))))
  assert.ok(app.find((el) => el.type === 'MapNavPane'))
  assert.equal(app.find((el) => el.type === 'MobileSheet'), undefined)
})

test('phone sheet: peek on JOURNEY with nothing selected, labelled by the map mode, and wired to the #31 lists', () => {
  for (const kind of ['track', 'artist']) {
    const root = { id: 'root', kind, name: 'Root', expanded: true }
    const leaf = { id: 'leaf', kind, name: 'Leaf', parentId: 'root' }
    const graph = { nodes: new Map([['root', root], ['leaf', leaf]]), edges: new Map([['e', { id: 'e', source: 'root', target: 'leaf', similarity: 0.5 }]]),
      rootId: 'root', journey: ['root'] }
    const app = harness({ narrow: true, graph })
    assert.equal(app.find((el) => el.type === 'MapNavPane'), undefined, 'no desktop left pane on phones')
    const mobile = app.find((el) => el.type === 'MobileSheet')
    // App's initial view is built inside the vm context, so copy it out of that realm before the strict prototype check.
    assert.deepEqual({ ...mobile.props.view }, { tab: 'journey', size: 'peek' })
    assert.equal(mobile.props.label, kind === 'track' ? 'Song details' : 'Artist details')
    assert.equal(mobile.props.journeyCount, 1)
    assert.equal(mobile.props.onMapCount, 2)
    assert.equal(mobile.props.journey.type, 'JourneyList')
    assert.equal(mobile.props.onMap.type, 'OnMapList')
    assert.equal(mobile.props.journey.props.songMode, kind === 'track')
    // Tapping a tab from peek opens the sheet to half on that tab.
    mobile.props.onTab('onmap')
    assert.deepEqual({ ...app.updates.at(-1) }, { tab: 'onmap', size: 'half' })
    mobile.props.onResize('tap')
    assert.deepEqual({ ...app.updates.at(-1) }, { tab: 'journey', size: 'half' })
    // A list row selects the node and switches to INSPECTOR.
    mobile.props.onMap.props.onJump('leaf')
    assert.ok(app.updates.some((value) => value?.tab === 'inspector' && value.selectionId === 'leaf' && value.size === 'half'))
    assert.deepEqual(app.selects.at(-1), 'leaf')
    assert.equal(app.updates.at(-1).id, 'leaf', 'the jump also centres the graph on the node')
    assert.ok(className(app.find((el) => className(el).startsWith('app '))).includes('app--sheet-peek'))
  }
})

test('phone sheet: a selected node shows the inspector at half height', () => {
  const root = { id: 'root', kind: 'track', name: 'Creep', artist: { id: 'r', name: 'Radiohead' } }
  const graph = { nodes: new Map([['root', root]]), edges: new Map(), rootId: 'root', journey: [], selectedNodeId: 'root' }
  const app = harness({ narrow: true, graph })
  const mobile = app.find((el) => el.type === 'MobileSheet')
  assert.deepEqual({ ...mobile.props.view }, { tab: 'inspector', size: 'half', selectionId: 'root' })
  assert.equal(mobile.props.inspector.type, 'ArtistPanel')
  // Taste is reached from the inspector, since the phone header has no Taste button.
  mobile.props.inspector.props.onEditTaste()
  assert.equal(app.updates.at(-1), true)
  assert.ok(className(app.find((el) => className(el).startsWith('app '))).includes('app--sheet-half'))
})

// ---- #24 combined expansion toast ---------------------------------------------------------

// #24: an expansion short of songs after exclusions AND ranked by fallback announced only the shortfall.
test('one expansion with an exclusion shortfall and a journey fallback shows one two-line toast', async () => {
  for (const narrow of [false, true]) for (const reason of ['timeout', 'missing_tags']) {
    const app = harness({ narrow, result: { tracks: tracks(3), excluded_count: 2, ranking: ranking(reason) } })
    await app.expand()
    const shown = app.toasts()
    assert.equal(shown.length, 1, 'both messages share one toast')
    assert.deepEqual([shown[0].msg, ...(shown[0].lines ?? [])], [
      'Only 3 connections remain after not suggested songs were excluded.',
      FALLBACK,
    ])
    assert.equal(shown[0].action, undefined)
  }
})

test('single expansion messages keep their own one-line toast', async () => {
  const cases = [
    [{ tracks: tracks(3), excluded_count: 2, ranking: ranking() }, 'Only 3 connections remain after not suggested songs were excluded.'],
    [{ tracks: tracks(1), excluded_count: 6, ranking: ranking() }, 'Only 1 connection remains after not suggested songs were excluded.'],
    [{ tracks: tracks(7), excluded_count: 0, ranking: ranking('timeout') }, FALLBACK],
    [{ tracks: [], excluded_count: 0, ranking: ranking() }, 'No known connections for Creep.'],
    // Nothing left to rank, so a fallback line would add nothing.
    [{ tracks: [], excluded_count: 4, ranking: ranking('timeout') }, 'No connections remain after not suggested songs were excluded. Manage them in Library → Not suggested.'],
  ]
  for (const [result, msg] of cases) {
    const app = harness({ result })
    await app.expand()
    const shown = app.toasts()
    assert.equal(shown.length, 1)
    assert.equal(shown[0].msg, msg)
    assert.equal(shown[0].lines, undefined)
  }
  const quiet = harness({ result: { tracks: tracks(7), excluded_count: 0, ranking: ranking() } })
  await quiet.expand()
  assert.equal(quiet.toasts().length, 0)
})

// ---- toast placement CSS ----------------------------------------------------------------

test('phone toasts sit above the sheet in every state, full width', () => {
  const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8')
  const phone = css.slice(css.indexOf('phone map: compact header and tabbed bottom sheet'))
  assert.match(phone, /\.app--graph \.toast \{[^}]*bottom: calc\(var\(--sheet-h\) \+ 8px\)/)
  assert.match(phone, /\.app--graph \.toast \{[^}]*width: calc\(100vw - 24px\)/)
  assert.match(phone, /\.app--graph \{ --sheet-h: /)
  assert.match(phone, /\.app--sheet-half \{ --sheet-h: 42dvh; \}/)
  assert.match(phone, /\.app--sheet-full \{ --sheet-h: min\(88dvh, 100%\); \}/)
  assert.match(phone, /\.sheet \{[^}]*height: var\(--sheet-h\)/)
  assert.match(phone, /\.app--graph \.map-shell > \.stage \{[^}]*bottom: var\(--sheet-h\)/)
  // The old phone rule pinned toasts to the top, over the header and search.
  assert.doesNotMatch(css, /\.toast \{\s*bottom: auto; top: calc\(62px/)
})
