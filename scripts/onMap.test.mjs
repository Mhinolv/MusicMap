// #31 left pane data: On map ranking and journey stops. No browser or GUI.
// Run: node --test scripts/onMap.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-onmap-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/graph/onMap.ts'), join(root, 'frontend/src/graph/useMusicGraph.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
// The compiled hook imports react; resolve it from the frontend's node_modules.
symlinkSync(join(root, 'frontend/node_modules'), join(output, 'node_modules'), 'dir')
const hookFile = join(output, 'graph/useMusicGraph.js')
writeFileSync(hookFile, readFileSync(hookFile, 'utf8').replace("'../types'", "'../types.js'"))
const { musicGraphReducer, artistNode, trackNode } = await import(pathToFileURL(hookFile).href)
const { nodeMatches, onMapRows, matchLabel, matchFraction, journeyStops, stopNumber, matchFact, matchText } = await import(pathToFileURL(join(output, 'graph/onMap.js')).href)

const empty = { nodes: new Map(), edges: new Map(), journey: [] }
const ref = (kind, id, name = `Name ${id}`) => kind === 'track'
  ? { id, name, artist: { id: `by-${id}`, name: `Artist ${id}` } }
  : { id, name }
const make = (kind, id, parent, name) => kind === 'track' ? trackNode(ref(kind, id, name), parent) : artistNode(ref(kind, id, name), parent)
const reset = (kind, id) => musicGraphReducer(empty, { type: 'reset', root: make(kind, id) })
const expand = (state, kind, id, children) => musicGraphReducer(state, { type: 'expand:success', id,
  children: children.map(([child, similarity, name]) => ({ node: make(kind, child, id, name), similarity })) })
const names = (graph) => onMapRows(graph).rows.map((row) => row.id)

test('match is the edge to the parent; parentless nodes take their strongest edge', () => {
  const nodes = [{ id: 'r' }, { id: 'a', parentId: 'r' }, { id: 'b', parentId: 'a' }]
  const edges = [
    { source: 'r', target: 'a', similarity: 0.4 },
    { source: 'a', target: 'b', similarity: 0.7 },
    // A stronger non-parent edge never changes b's match.
    { source: 'r', target: 'b', similarity: 0.95 },
    { source: 'r', target: 'x', similarity: null },
  ]
  const matches = nodeMatches(nodes, edges)
  assert.equal(matches.get('a'), 0.4)
  assert.equal(matches.get('b'), 0.7)
  assert.equal(matches.get('r'), 0.95)
  assert.deepEqual(nodeMatches([], []), new Map())
})

// Owner decision 2026-10-10: ON MAP was empty after a search on production.
for (const kind of ['artist', 'track']) {
  test(`${kind} map: ON MAP lists the root's first connections as soon as the search loads`, () => {
    const searched = reset(kind, 'root')
    assert.deepEqual(onMapRows(searched), { count: 1, rows: [] })
    const children = Array.from({ length: 8 }, (_, i) => [`c${i}`, 0.5 + i / 20])
    const loaded = expand(searched, kind, 'root', children)
    const { count, rows } = onMapRows(loaded)
    // Same number the status bar shows (root included), root itself not listed.
    assert.equal(count, loaded.nodes.size)
    assert.equal(count, 9)
    assert.equal(rows.length, 8)
    assert.ok(!rows.some((row) => row.id === 'root'))
    assert.deepEqual(rows.map((row) => row.id), ['c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0'])
    assert.deepEqual(rows.map(matchLabel), ['85', '80', '75', '70', '65', '60', '55', '50'])
    for (const row of rows) assert.equal(row.artist, kind === 'track' ? `Artist ${row.id}` : undefined)
  })

  test(`${kind} map: ON MAP stays in sync after expand, collapse, remove and undo`, () => {
    let graph = expand(reset(kind, 'root'), kind, 'root', [['a', 0.9], ['b', 0.6]])
    graph = expand(graph, kind, 'a', [['a1', 0.8], ['a2', 0.3], ['b', 0.99]])
    // b keeps its match to root (its parent), not the stronger edge to a.
    assert.deepEqual(names(graph), ['a', 'a1', 'b', 'a2'])
    assert.equal(onMapRows(graph).count, 5)

    const collapsed = musicGraphReducer(graph, { type: 'prune', id: 'a', mode: 'collapse' })
    assert.deepEqual(names(collapsed), ['a', 'b'])
    assert.equal(onMapRows(collapsed).count, 3)
    assert.deepEqual(names(musicGraphReducer(collapsed, { type: 'undo' })), ['a', 'a1', 'b', 'a2'])

    const removed = musicGraphReducer(graph, { type: 'prune', id: 'a', mode: 'remove' })
    assert.deepEqual(names(removed), ['b'])
    assert.deepEqual(names(musicGraphReducer(removed, { type: 'undo' })), ['a', 'a1', 'b', 'a2'])
  })

  test(`${kind} map: selection and focus changes never reshuffle the rows`, () => {
    let graph = expand(reset(kind, 'root'), kind, 'root', [['a', 0.9], ['b', 0.6], ['c', 0.75]])
    const before = names(graph)
    graph = musicGraphReducer(graph, { type: 'select', id: 'b' })
    assert.deepEqual(names(graph), before)
    graph = expand(graph, kind, 'b', [['b1', 0.1]])
    assert.equal(graph.focusId, 'b')
    assert.deepEqual(names(graph).filter((id) => id !== 'b1'), before)
  })
}

test('ties sort by name; unknown matches sort last with a dash and an empty bar; loading shows an ellipsis', () => {
  let graph = expand(reset('track', 'root'), 'track', 'root', [
    ['z', 0.5, 'Zebra'], ['y', 0.5, 'Apple'], ['n1', undefined, 'Mango'], ['n0', undefined, 'Banana'], ['top', 1, 'Top'],
  ])
  assert.deepEqual(names(graph), ['top', 'y', 'z', 'n0', 'n1'])
  const unknown = onMapRows(graph).rows.at(-1)
  assert.equal(matchLabel(unknown), '—')
  assert.equal(matchFraction(unknown.match), 0)
  graph = musicGraphReducer(graph, { type: 'expand:start', id: 'y' })
  const loading = onMapRows(graph).rows.find((row) => row.id === 'y')
  assert.equal(loading.loading, true)
  assert.equal(matchLabel(loading), '…')
  // The row keeps its rank while it loads.
  assert.deepEqual(names(graph), ['top', 'y', 'z', 'n0', 'n1'])
})

test('match fraction and label clamp to 0–100 and ignore non-finite values', () => {
  for (const [match, fraction, label] of [[0, 0, '0'], [0.004, 0.004, '0'], [0.826, 0.826, '83'], [1, 1, '100'], [1.4, 1, '100'], [-0.2, 0, '0']]) {
    assert.equal(matchFraction(match), fraction)
    assert.equal(matchLabel({ match, loading: false }), label)
  }
  assert.equal(matchFraction(Number.NaN), 0)
  assert.equal(matchFraction(undefined), 0)
})

test('journey stops: song maps list expanded songs only, artist maps list the whole journey', () => {
  const song = reset('track', 'root')
  assert.deepEqual(journeyStops(song), [])
  const songMap = expand(expand(song, 'track', 'root', [['a', 0.9]]), 'track', 'a', [['b', 0.5]])
  assert.deepEqual(journeyStops(songMap).map((n) => n.id), ['root', 'a'])
  // A stop's expanded state drives the collapse control.
  assert.ok(journeyStops(songMap).every((n) => n.expanded))

  const artist = reset('artist', 'root')
  assert.deepEqual(journeyStops(artist).map((n) => n.id), ['root'])
  const artistMap = expand(artist, 'artist', 'root', [['a', 0.9]])
  assert.deepEqual(journeyStops(artistMap).map((n) => n.id), ['root'])
  const collapsed = musicGraphReducer(expand(artistMap, 'artist', 'a', [['b', 0.4]]), { type: 'prune', id: 'a', mode: 'collapse' })
  assert.deepEqual(journeyStops(collapsed).map((n) => n.id), ['root'])
  assert.deepEqual(journeyStops({ nodes: new Map(), journey: [] }), [])
  // Ids missing from the map are skipped rather than crashing.
  assert.deepEqual(journeyStops({ ...songMap, journey: ['gone', ...songMap.journey] }).map((n) => n.id), ['root', 'a'])
})

test('stop numbers are two digits', () => {
  assert.deepEqual([0, 8, 9, 49, 98, 99].map(stopNumber), ['01', '09', '10', '50', '99', '100'])
})

// #32 inspector facts: MATCH and SHARED read the edge to the parent, like the On map score.
test('inspector match fact: parent edge, shared tags, root and unknown matches', () => {
  let graph = musicGraphReducer(reset('track', 'root'), { type: 'expand:success', id: 'root', children: [
    { node: make('track', 'a', 'root', 'Glory Box'), similarity: 0.826, sharedTags: ['90s', 'alternative'] },
    { node: make('track', 'n', 'root', 'No score') },
  ] })
  graph = expand(graph, 'track', 'a', [['b', 0.4], ['n', 0.99]])
  assert.equal(matchFact(graph, 'root'), null, 'the root has no parent, so no MATCH row')
  assert.equal(matchFact(graph, 'missing'), null)
  assert.deepEqual(matchFact(graph, 'a'), { match: 0.826, parent: 'Name root', shared: ['90s', 'alternative'] })
  assert.equal(matchText(matchFact(graph, 'a')), '83% to Name root')
  assert.deepEqual(matchFact(graph, 'b'), { match: 0.4, parent: 'Glory Box', shared: [] })
  // n keeps root as its parent; the stronger edge to a never becomes its MATCH.
  assert.deepEqual(matchFact(graph, 'n'), { match: undefined, parent: 'Name root', shared: [] })
  assert.equal(matchText(matchFact(graph, 'n')), null)
  assert.equal(matchText(null), null)
  assert.equal(matchText({ match: Number.NaN, parent: 'x', shared: [] }), null)
  assert.equal(matchText({ match: 1.3, parent: 'x', shared: [] }), '100% to x')
  assert.equal(matchText({ match: 0, parent: 'x', shared: [] }), '0% to x')
  // Artist edges carry no shared tags; a removed parent drops the row.
  const artist = expand(reset('artist', 'r'), 'artist', 'r', [['c', 0.5]])
  assert.deepEqual(matchFact(artist, 'c'), { match: 0.5, parent: 'Name r', shared: [] })
  const nodes = new Map(artist.nodes)
  nodes.delete('r')
  assert.equal(matchFact({ ...artist, nodes }, 'c'), null)
})
