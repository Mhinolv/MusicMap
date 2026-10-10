// "Check these connections" helpers (#37); no browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-connections-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/connections.ts'), join(root, 'frontend/src/taste.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const emitted = join(output, 'connections.js')
writeFileSync(emitted, readFileSync(emitted, 'utf8').replace("'./fitBand'", "'./fitBand.js'"))
const c = await import(pathToFileURL(emitted).href)
const t = await import(pathToFileURL(join(output, 'taste.js')).href)
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')

/** Renders ConnectionsCheck's first frame (hooks stubbed to their initial values). */
function render(props) {
  const source = ts.transpileModule(readFileSync(new URL('../frontend/src/components/ConnectionsCheck.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  const modules = { '../taste': t, '../connections': c }
  runInNewContext(source, {
    exports, require: (name) => name === 'react/jsx-runtime' ? require(name)
      : name === 'react' ? { useState: (initial) => [initial, () => {}], useRef: (current) => ({ current }), useEffect() {} }
        : modules[name] ?? {},
  })
  const elements = []
  const visit = (element) => {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    if (typeof element.type === 'function') visit(element.type(element.props))
    else for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(exports.ConnectionsCheck(props))
  return elements
}
const text = (element) => [element.props?.children].flat(Infinity).filter((value) => typeof value === 'string').join('')

const song = (id, parentId, name = `Song ${id}`, artist = `Artist ${id}`) =>
  [id, { id, kind: 'track', name, parentId, expanded: false, loading: false, artist: { id: `a-${id}`, name: artist } }]
const result = (item_id, outcome, level = null) => ({ item_id, outcome, level, score: level })

test('children are the expansion\'s surviving songs in graph order, capped at seven', () => {
  const nodes = new Map([
    song('root'), song('z', 'root'), song('a', 'root'), song('grand', 'z'), song('m', 'root'),
  ])
  assert.deepEqual(c.expansionChildren(nodes, 'root').map((item) => item.id), ['z', 'a', 'm'], 'never re-sorted')
  assert.deepEqual(c.expansionChildren(nodes, 'root')[0], { id: 'z', name: 'Song z', artist: 'Artist z' })
  assert.deepEqual(c.expansionChildren(nodes, 'z').map((item) => item.id), ['grand'])
  assert.deepEqual(c.expansionChildren(nodes, 'a'), [], 'no expansion, no rows')
  assert.deepEqual(c.expansionChildren(nodes, 'missing'), [])

  nodes.delete('a') // pruned / removed child loses its row
  assert.deepEqual(c.expansionChildren(nodes, 'root').map((item) => item.id), ['z', 'm'])

  const many = new Map([song('root'), ...Array.from({ length: 9 }, (_, i) => song(`c${i}`, 'root'))])
  assert.equal(c.expansionChildren(many, 'root').length, c.CONNECTIONS_LIMIT)
  assert.equal(c.CONNECTIONS_LIMIT, 7)
})

test('artist maps never get a connections list', () => {
  const nodes = new Map([
    ['artist', { id: 'artist', kind: 'artist', name: 'A', expanded: true, loading: false }],
    ['child', { id: 'child', kind: 'artist', name: 'B', parentId: 'artist', expanded: false, loading: false }],
  ])
  assert.deepEqual(c.expansionChildren(nodes, 'artist'), [])
})

test('row labels: "title — artist", title alone without an artist', () => {
  assert.equal(c.connectionLabel({ id: 'x', name: 'Teardrop', artist: 'Massive Attack' }), 'Teardrop — Massive Attack')
  assert.equal(c.connectionLabel({ id: 'x', name: 'Teardrop', artist: '' }), 'Teardrop')
})

test('bands reuse the #36 vocabulary; unknown has no band', () => {
  assert.equal(c.connectionBand(result('a', 'fit', 3)).label, 'Likely fit')
  assert.equal(c.connectionBand(result('a', 'fit', 0)).key, 'conflict')
  assert.equal(c.connectionBand(result('a', 'insufficient_evidence')).label, 'Not enough information')
  assert.equal(c.connectionBand(result('a', 'uncertain')).label, 'Uncertain estimate')
  assert.deepEqual(c.connectionBand(result('a', 'uncertain', 3)),
    { key: 'likely', label: 'Likely fit', tone: 'uncertain', pips: 4, tentative: true })
  assert.equal(c.connectionBand(result('a', 'unknown')), null)
})

test('check again sends only misses, or every row when nothing is missing', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ id, name: id, artist: '' }))
  assert.deepEqual(c.idsToCheck(items, {}), ['a', 'b', 'c'])
  assert.deepEqual(c.idsToCheck(items, { a: result('a', 'fit', 4), b: result('b', 'unknown') }), ['b', 'c'])
  const all = { a: result('a', 'fit', 4), b: result('b', 'insufficient_evidence'), c: result('c', 'uncertain') }
  assert.deepEqual(c.idsToCheck(items, all), ['a', 'b', 'c'])
  assert.deepEqual(c.idsToCheck([], {}), [])
})

test('panel section: rows are selectable before any check; the gate matches Check my taste', () => {
  const items = [
    { id: 'b', name: 'Teardrop', artist: 'Massive Attack' },
    { id: 'a', name: 'Roads', artist: 'Portishead' },
  ]
  for (const positive of [false, true]) {
    const profile = { ...t.emptyTaste(), disliked: ['Harsh'], liked_genres: positive ? ['trip-hop'] : [] }
    const selected = []
    const edits = []
    const elements = render({ parentId: 'p', items, profile, onSelect: (id) => selected.push(id), onEdit: () => edits.push(1) })
    assert.equal(text(elements.find((el) => el.type === 'h3')), 'Your taste across these connections')
    const buttons = elements.filter((el) => el.type === 'button')
    const action = buttons.find((el) => el.props.className === 'btn btn--ghost')
    assert.equal(text(action), positive ? 'Check these connections' : 'Add preferences')
    const hints = elements.filter((el) => el.type === 'p').map(text)
    assert.equal(hints.includes('Add a few things you like to check these connections.'), !positive)
    assert.ok(hints.includes("Labels compare each song with your taste. They don't change the map."))
    if (!positive) {
      action.props.onClick()
      assert.equal(edits.length, 1)
    }

    const list = elements.find((el) => el.type === 'ol')
    assert.equal(list.props['aria-busy'], false)
    const rows = buttons.filter((el) => el.props.className?.includes('connections__name'))
    assert.deepEqual(rows.map(text), ['Teardrop — Massive Attack', 'Roads — Portishead'], 'graph order, never re-sorted')
    assert.deepEqual(rows.map((el) => el.props['aria-label']), ['Select Teardrop by Massive Attack', 'Select Roads by Portishead'])
    assert.deepEqual(rows.map((el) => el.props.title), ['Teardrop — Massive Attack', 'Roads — Portishead'])
    rows.forEach((row) => row.props.onClick())
    assert.deepEqual(selected, ['b', 'a'])
    assert.equal(elements.filter((el) => String(el.props?.className ?? '').includes('connections__label')).length, 0, 'no labels before a check')
  }
})

test('summary counts visible rows only and never shows a percent', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id, artist: '' }))
  assert.equal(c.connectionsSummary(items, {}), null)
  const results = {
    a: result('a', 'fit', 4), b: result('b', 'fit', 3), c: result('c', 'fit', 0),
    d: result('d', 'insufficient_evidence'), e: result('e', 'unknown'), gone: result('gone', 'fit', 4),
  }
  const summary = c.connectionsSummary(items, results)
  assert.equal(summary, "Checked 4 songs: 2 likely or strong fit, 1 not enough information. 1 song couldn't be checked.")
  assert.doesNotMatch(summary, /%/)
  assert.equal(c.connectionsSummary(items.slice(0, 1), results), 'Checked 1 song: 1 likely or strong fit, 0 not enough information.')
})

test('summary counts tentative leans on their own, never as likely or strong (#51)', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, artist: '' }))
  const results = {
    a: result('a', 'fit', 4), b: result('b', 'uncertain', 4), c: result('c', 'uncertain', 3), d: result('d', 'uncertain'),
  }
  const summary = c.connectionsSummary(items, results)
  assert.equal(summary, 'Checked 4 songs: 1 likely or strong fit, 2 tentative, 0 not enough information.')
  assert.doesNotMatch(summary, /%/)
  assert.equal(c.connectionsSummary(items.slice(1, 2), results), 'Checked 1 song: 0 likely or strong fit, 1 tentative, 0 not enough information.')
  assert.doesNotMatch(c.connectionsSummary(items.slice(0, 1), results), /tentative/, 'no clause when there are none')
})
