// Start screen helpers, StartScreen and LibraryDrawer markup, without a DOM or browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
// Same realm as the test, so deepStrictEqual sees ordinary arrays and objects.
const load = (path, mocks = {}) => {
  const source = ts.transpileModule(readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function('exports', 'require', source)(exports, (name) => name === 'react/jsx-runtime' ? require(name) : mocks[name] ?? {})
  return exports
}
const helpers = load('startScreen.ts')
const { plural, savedWhen, resumeSummary, miniMap, MINI_MAP_CAP } = helpers

const graphOf = ({ kind = 'track', count = 3, journey, selected, edges = true, parents } = {}) => {
  const nodes = new Map(Array.from({ length: count }, (_, i) => [`n${i}`, {
    id: `n${i}`, name: i ? `Song ${i}` : 'Creep', kind, expanded: false, loading: false,
    parentId: i ? parents?.(i) ?? 'n0' : undefined,
  }]))
  const edgeList = edges ? [...nodes.values()].filter((n) => n.parentId).map((n) => ({ id: `${n.parentId}::${n.id}`, source: n.parentId, target: n.id })) : []
  return { nodes, edges: new Map(edgeList.map((e) => [e.id, e])), rootId: 'n0', journey: journey ?? ['n0'], selectedNodeId: selected }
}

test('plural uses the singular only for exactly one', () => {
  assert.equal(plural(0, 'stop'), '0 stops')
  assert.equal(plural(1, 'stop'), '1 stop')
  assert.equal(plural(2, 'song'), '2 songs')
  assert.equal(plural(500, 'artist'), '500 artists')
  assert.equal(plural(1, 'discovery', 'discoveries'), '1 discovery')
  assert.equal(plural(3, 'discovery', 'discoveries'), '3 discoveries')
})

test('savedWhen covers unknown, today, yesterday, n days ago, dates, future and year/month edges', () => {
  const now = new Date(2026, 9, 10, 9, 30).getTime()
  assert.equal(savedWhen(0, now), '')
  assert.equal(savedWhen(new Date(2026, 9, 10, 0, 1).getTime(), now), 'today')
  assert.equal(savedWhen(now + 3600_000, now), 'today')
  assert.equal(savedWhen(new Date(2026, 9, 11).getTime(), now), 'today')
  assert.equal(savedWhen(new Date(2026, 9, 9, 23, 59).getTime(), now), 'yesterday')
  assert.equal(savedWhen(new Date(2026, 9, 8, 0, 0).getTime(), now), '2 days ago')
  assert.equal(savedWhen(new Date(2026, 9, 4, 12).getTime(), now), '6 days ago')
  assert.equal(savedWhen(new Date(2026, 9, 3, 12).getTime(), now), '3 Oct')
  assert.equal(savedWhen(new Date(2026, 8, 12, 12).getTime(), now), '12 Sep')
  assert.equal(savedWhen(new Date(2026, 0, 1, 12).getTime(), now), '1 Jan')
  assert.equal(savedWhen(new Date(2026, 11, 31, 23).getTime(), new Date(2027, 0, 2, 1).getTime()), '2 days ago')
  assert.equal(savedWhen(new Date(2026, 1, 28, 12).getTime(), new Date(2026, 2, 1, 1).getTime()), 'yesterday')
})

test('resumeSummary titles root alone for 0/1 stops, root › last stop otherwise, in both modes', () => {
  for (const kind of ['artist', 'track']) for (const count of [1, 3, 500]) {
    for (const journey of [[], ['n0'], ['n0', `n${count - 1}`], ['n0', 'missing']]) {
      const summary = resumeSummary(graphOf({ kind, count, journey }))
      const last = journey.length > 1 && journey[1] !== 'missing' && count > 1 ? `Creep › Song ${count - 1}` : 'Creep'
      assert.equal(summary.title, last)
      assert.equal(summary.mode, kind === 'track' ? 'Song' : 'Artist')
      assert.equal(summary.countLabel, kind === 'track' ? 'Songs' : 'Artists')
      assert.equal(summary.stops, journey.length)
      assert.equal(summary.nodes, count)
      assert.equal(summary.links, count - 1)
    }
  }
  assert.equal(resumeSummary({ nodes: new Map(), edges: new Map(), journey: [] }).title, '')
})

const inBox = (s) => s.x >= 0 && s.x <= 200 && s.y >= 0 && s.y <= 120

test('miniMap: empty, root-only and single-child maps', () => {
  assert.deepEqual(miniMap({ nodes: new Map(), edges: new Map(), journey: [] }), { stars: [], links: [], journey: '' })
  const alone = miniMap(graphOf({ count: 1 }))
  assert.equal(alone.stars.length, 1)
  assert.deepEqual(alone.stars[0], { id: 'n0', x: 72, y: 60, r: 5, tone: 'amber' })
  assert.equal(alone.links.length, 0)
  assert.equal(alone.journey, '')
  const pair = miniMap(graphOf({ count: 2, journey: ['n0', 'n1'] }))
  const child = pair.stars.find((s) => s.id === 'n1')
  assert.ok(child.x > 100 && Math.abs(child.y - 60) < 1, 'the journey branch points right of the root')
  assert.equal(pair.journey, 'M72 60L184 60')
})

test('miniMap is deterministic, capped at 40, in bounds and colours root/stops amber, selection cyan', () => {
  for (const count of [2, 39, 40, 41, 500]) {
    const graph = graphOf({ count, journey: ['n0', 'n1'], selected: `n${count - 1}`, parents: (i) => i > 5 ? `n${i % 5 + 1}` : 'n0' })
    const map = miniMap(graph)
    assert.deepEqual(map, miniMap(graph))
    assert.equal(map.stars.length, Math.min(count, MINI_MAP_CAP))
    assert.ok(map.stars.every(inBox))
    assert.ok(map.links.every((l) => inBox({ x: l.x1, y: l.y1 }) && inBox({ x: l.x2, y: l.y2 })))
    const root = map.stars.find((s) => s.id === 'n0')
    assert.ok(root.x < 100, 'root sits left of centre')
    assert.equal(map.stars.find((s) => s.id === 'n1').tone, count === 2 ? 'cyan' : 'amber')
    const selected = map.stars.find((s) => s.id === `n${count - 1}`)
    if (selected) assert.equal(selected.tone, 'cyan')
    assert.ok(map.stars.filter((s) => s.tone === 'star').every((s) => s.r === 2.5))
    // Amber and cyan stars are drawn last so dim stars never cover them.
    const tones = map.stars.map((s) => s.tone)
    assert.ok(tones.lastIndexOf('star') < Math.max(tones.indexOf('amber'), tones.indexOf('cyan')))
  }
})

test('miniMap keeps deep journey stops past the cap and draws the dashed path through them', () => {
  // 100 root children are listed first; the journey runs down a separate 10-deep chain.
  const nodes = new Map([['root', { id: 'root', name: 'Root', kind: 'artist' }]])
  for (let i = 0; i < 100; i++) nodes.set(`c${i}`, { id: `c${i}`, name: `C${i}`, kind: 'artist', parentId: 'root' })
  const chain = Array.from({ length: 10 }, (_, i) => `d${i}`)
  chain.forEach((id, i) => nodes.set(id, { id, name: id, kind: 'artist', parentId: i ? chain[i - 1] : 'root' }))
  const journey = ['root', ...chain]
  const map = miniMap({ nodes, edges: new Map(), rootId: 'root', journey })
  assert.equal(map.stars.length, 40)
  for (const id of chain) assert.equal(map.stars.find((s) => s.id === id)?.tone, 'amber')
  assert.equal((map.journey.match(/L/g) ?? []).length, chain.length)
  assert.ok(map.stars.every(inBox))
  assert.equal(miniMap({ nodes, edges: new Map(), rootId: 'root', journey }, 5).stars.length, 5)
})

test('miniMap tolerates orphans, unreachable cycles and links to omitted nodes', () => {
  const nodes = new Map([
    ['r', { id: 'r', name: 'R', kind: 'artist' }],
    ['orphan', { id: 'orphan', name: 'O', kind: 'artist', parentId: 'gone' }],
    ['a', { id: 'a', name: 'A', kind: 'artist', parentId: 'b' }],
    ['b', { id: 'b', name: 'B', kind: 'artist', parentId: 'a' }],
  ])
  const edges = new Map([['e1', { id: 'e1', source: 'r', target: 'orphan' }], ['e2', { id: 'e2', source: 'a', target: 'b' }]])
  const map = miniMap({ nodes, edges, rootId: 'r', journey: ['r', 'a'], selectedNodeId: 'a' })
  assert.deepEqual(map.stars.map((s) => s.id).sort(), ['orphan', 'r'])
  assert.deepEqual(map.links.map((l) => l.id), ['e1'])
  assert.equal(map.journey, '')
})

// ---- components ------------------------------------------------------------------

const visit = (element, out = []) => {
  if (!element || typeof element !== 'object') return out
  if (Array.isArray(element)) { for (const child of element) visit(child, out); return out }
  out.push(element)
  for (const child of [element.props?.children].flat(Infinity)) visit(child, out)
  return out
}
const text = (element) => [element.props?.children].flat(Infinity).map((child) =>
  typeof child === 'object' && child ? text(child) : child ?? '').join('')
const reactMock = (state = {}) => ({
  useState: (initial) => [state.value ?? (typeof initial === 'function' ? initial() : initial), () => {}],
  useRef: (current) => ({ current }), useMemo: (fn) => fn(), useEffect: () => {}, useCallback: (fn) => fn,
})

function renderStart(savedMap, { mode = 'artist', libraryCount = 0, libraryOpen = false } = {}) {
  const SearchBar = () => null, LibraryButton = () => null
  const { StartScreen } = load('components/StartScreen.tsx', {
    react: reactMock(), '../startScreen': helpers, '../graph/constellation': { generateStarField: () => [] },
    './LibraryDrawer': { LibraryButton }, './SearchBar': { SearchBar },
  })
  const calls = []
  const tree = StartScreen({ savedMap, search: { mode, onSelect() {}, onSelectTrack() {}, onModeChange() {} }, libraryCount, libraryOpen,
    onToggleLibrary: () => calls.push('library'), libraryButton: { current: null }, onTaste: () => calls.push('taste'),
    onResume: () => calls.push('resume'), onStartFresh: () => calls.push('fresh') })
  const elements = visit(tree)
  const button = (label) => elements.find((el) => el.type === 'button' && text(el) === label)
  return { elements, calls, button, SearchBar, LibraryButton, sections: elements.filter((el) => el.type === 'section') }
}
const ready = (graph) => ({ status: 'ready', snapshot: { graph, followJourney: false } })

test('start screen header: hidden h1, LIBRARY with saved + not-suggested count, TASTE opens the dialog', () => {
  for (const [count, open] of [[0, false], [3, true]]) {
    const app = renderStart({ status: 'none' }, { libraryCount: count, libraryOpen: open })
    assert.equal(text(app.elements.find((el) => el.type === 'h1')), 'TuneGraph')
    assert.equal(app.elements.find((el) => el.type === 'h1').props.className, 'sr-only')
    const library = app.elements.find((el) => el.type === app.LibraryButton)
    assert.equal(library.props.count, count)
    assert.equal(library.props.open, open)
    library.props.onToggle()
    app.button('Taste').props.onClick()
    assert.deepEqual(app.calls, ['library', 'taste'])
    assert.equal(app.elements.find((el) => el.type === 'main').props.className.includes('start--library'), open)
  }
})

test('no snapshot: NEW MAP only, MAP IT is the amber primary, hint follows mode', () => {
  for (const mode of ['artist', 'song']) {
    const app = renderStart({ status: 'none' }, { mode })
    assert.equal(app.sections.length, 1)
    const search = app.elements.find((el) => el.type === app.SearchBar)
    assert.equal(search.props.start, true)
    assert.equal(search.props.primary, true)
    assert.equal(search.props.autoFocus, true)
    const hint = text(app.elements.find((el) => el.props?.className === 'start-panel__hint'))
    assert.equal(hint, mode === 'song' ? 'Try “Creep”, “Glory Box”, or “Teardrop”.' : 'Try “Radiohead”, “Portishead”, or “Björk”.')
    assert.equal(app.button('Resume'), undefined)
  }
})

test('ready snapshot: amber RESUME panel after NEW MAP, outlined MAP IT, facts, RESUME and DISCARD', () => {
  for (const kind of ['artist', 'track']) for (const count of [1, 2, 500]) for (const stops of [0, 1, 2]) {
    const journey = Array.from({ length: Math.min(stops, count) }, (_, i) => `n${i}`)
    const app = renderStart(ready(graphOf({ kind, count, journey })))
    assert.equal(app.sections.length, 2)
    const [newMap, resume] = app.sections
    assert.equal(newMap.props['aria-labelledby'], 'new-map-title')
    assert.ok(resume.props.className.includes('resume-card--ready'))
    assert.equal(resume.props['aria-labelledby'], 'resume-title')
    assert.equal(app.elements.find((el) => el.type === app.SearchBar).props.primary, false)
    const title = text(app.elements.find((el) => el.props?.className === 'resume__title'))
    assert.equal(title, journey.length > 1 ? 'Creep › Song 1' : 'Creep')
    const facts = app.elements.filter((el) => el.type === 'div' && [el.props.children].flat().some((child) => child?.type === 'dt')).map((el) => text(el))
    assert.deepEqual(facts, [`Mode${kind === 'track' ? 'Song' : 'Artist'}`, `Stops${journey.length}`,
      `${kind === 'track' ? 'Songs' : 'Artists'}${count}`, `Links${count - 1}`])
    assert.equal(app.button('Resume').props.className, 'btn btn--primary resume__go')
    assert.equal(app.button('Discard').props['aria-label'], 'Discard saved map and start fresh')
    app.button('Resume').props.onClick()
    app.button('Discard').props.onClick()
    assert.deepEqual(app.calls, ['resume', 'fresh'])
  }
})

test('invalid snapshot: grey panel, recoverable copy, only START FRESH, MAP IT primary', () => {
  const app = renderStart({ status: 'invalid' })
  const panel = app.sections[1]
  assert.ok(panel.props.className.includes('resume-card--invalid'))
  assert.ok(!panel.props.className.includes('resume-card--ready'))
  assert.ok(text(panel).includes("Last map couldn't be restored"))
  assert.ok(text(panel).includes('It was damaged or too large to load.'))
  assert.equal(app.button('Resume'), undefined)
  assert.equal(app.elements.filter((el) => el.type === 'svg' && el.props.className === 'resume__map').length, 0)
  assert.equal(app.elements.find((el) => el.type === app.SearchBar).props.primary, true)
  app.button('Start fresh').props.onClick()
  assert.deepEqual(app.calls, ['fresh'])
})

function renderDrawer({ tab = 'saved', entries = [], exclusions = [] } = {}) {
  const { LibraryDrawer, LibraryButton } = load('components/LibraryDrawer.tsx', {
    react: reactMock({ value: tab }), '../startScreen': helpers,
    '../bookmarks': { bookmarkKey: (entry) => `${entry.kind}:${entry.item.id}` },
  })
  const calls = []
  const record = (name) => (entry) => calls.push([name, entry?.item?.id])
  const tree = LibraryDrawer({ entries, exclusions, onOpen: record('open'), onRemove: record('remove'), onClear: record('clear'),
    onRemoveExclusion: record('restore'), onResetExclusions: record('reset'), onClose: record('close') })
  return { elements: visit(tree), calls, tree, LibraryButton }
}
const artistEntry = { kind: 'artist', item: { id: 'a1', name: 'Portishead' }, savedAt: Date.now() }
const songEntry = { kind: 'track', item: { id: 't1', name: 'Glory Box', artist: { id: 'a1', name: 'Portishead' } }, savedAt: 0 }
const yesterdayNoon = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1, 12).getTime()
const excluded = { kind: 'track', item: { id: 't2', name: 'Teardrop', artist: { id: 'a2', name: 'Massive Attack' } }, savedAt: yesterdayNoon }

test('library drawer is a non-modal aside with tab counts and the selected tab focusable', () => {
  for (const tab of ['saved', 'excluded']) {
    const drawer = renderDrawer({ tab, entries: [artistEntry, songEntry], exclusions: [excluded] })
    assert.equal(drawer.tree.type, 'aside')
    assert.equal(drawer.tree.props['aria-label'], 'Library')
    assert.equal(drawer.tree.props.role, undefined)
    assert.equal(drawer.tree.props['aria-modal'], undefined)
    const tabs = drawer.elements.filter((el) => el.props?.role === 'tab')
    assert.deepEqual(tabs.map(text), ['Saved · 2', 'Not suggested · 1'])
    assert.deepEqual(tabs.map((el) => el.props['aria-selected']), [tab === 'saved', tab === 'excluded'])
    assert.deepEqual(tabs.map((el) => el.props.tabIndex), tab === 'saved' ? [0, -1] : [-1, 0])
    assert.deepEqual(drawer.elements.filter((el) => el.props?.role === 'tabpanel').map((el) => el.props.hidden), [tab !== 'saved', tab !== 'excluded'])
    const close = drawer.elements.find((el) => el.props?.['aria-label'] === 'Close library')
    close.props.onClick()
    assert.deepEqual(drawer.calls, [['close', undefined]])
  }
})

test('saved rows: sub line with age, MAP IT opens, × removes; not-suggested rows only RESTORE', () => {
  const drawer = renderDrawer({ entries: [artistEntry, songEntry], exclusions: [excluded] })
  const rows = drawer.elements.filter((el) => el.type === 'li')
  assert.deepEqual(rows.map((row) => text(visit(row).find((el) => el.props?.className === 'saved-item__sub'))),
    ['Artist · today', 'Portishead', 'Massive Attack · yesterday'])
  const [artistRow, songRow, excludedRow] = rows.map((row) => visit(row).filter((el) => el.type === 'button'))
  assert.deepEqual(artistRow.map(text), ['Map it', '×'])
  assert.equal(songRow[1].props['aria-label'], 'Remove Glory Box from saved')
  songRow[0].props.onClick()
  songRow[1].props.onClick()
  assert.deepEqual(excludedRow.map(text), ['Restore'])
  assert.equal(excludedRow[0].props['aria-label'], 'Suggest Teardrop by Massive Attack again')
  excludedRow[0].props.onClick()
  assert.deepEqual(drawer.calls, [['open', 't1'], ['remove', 't1'], ['restore', 't2']])
  const notes = drawer.elements.filter((el) => el.props?.className === 'library-drawer__note').map(text)
  assert.deepEqual(notes, ['Kept on this device. Songs marked "Don\'t suggest again" move to Not suggested, where you can restore them.',
    "Saving doesn't change your taste profile."])
})

test('empty lists keep today\'s copy and disable CLEAR ALL / RESET ALL', () => {
  const drawer = renderDrawer()
  const copy = drawer.elements.filter((el) => el.type === 'p' && el.props.className?.includes('saved-empty')).map(text)
  assert.deepEqual(copy, ['Nothing saved yet. Use the bookmark on any artist or song panel.', 'No excluded songs. Use “Don\'t suggest again” on a song panel.'])
  const buttons = drawer.elements.filter((el) => el.type === 'button' && ['Clear all', 'Reset all'].includes(text(el)))
  assert.deepEqual(buttons.map((el) => el.props.disabled), [true, true])
  const full = renderDrawer({ entries: [artistEntry], exclusions: [excluded] })
  for (const label of ['Clear all', 'Reset all']) full.elements.find((el) => el.type === 'button' && text(el) === label).props.onClick()
  assert.deepEqual(full.calls.map(([name]) => name), ['clear', 'reset'])
})

test('LIBRARY button hides the badge at 0 and reports expanded state', () => {
  const { LibraryButton } = renderDrawer()
  for (const [count, open] of [[0, false], [1, true], [7, false]]) {
    const button = LibraryButton({ count, open, onToggle() {} })
    const badge = visit(button).find((el) => el.props?.className === 'library-count')
    assert.equal(badge ? text(badge) : undefined, count ? String(count) : undefined)
    assert.equal(button.props['aria-expanded'], open)
    assert.equal(button.props['aria-controls'], open ? 'library-drawer' : undefined)
  }
})
