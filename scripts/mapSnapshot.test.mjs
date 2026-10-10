// Pure storage tests; no browser or GUI. Run: node --test scripts/mapSnapshot.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-map-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/graph/mapSnapshot.ts'), join(root, 'frontend/src/graph/useMusicGraph.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
symlinkSync(join(root, 'frontend/node_modules'), join(output, 'node_modules'))
const hookFile = join(output, 'graph/useMusicGraph.js')
writeFileSync(hookFile, readFileSync(hookFile, 'utf8').replace("'../types'", "'../types.js'"))
const { musicGraphReducer } = await import(pathToFileURL(hookFile).href)
const m = await import(pathToFileURL(join(output, 'graph/mapSnapshot.js')).href)
const node = (id, kind = 'artist', parentId) => ({ id, kind, name: `Name ${id}`, parentId,
  expanded: true, loading: true, error: 'transient', tags: ['rock'],
  ...(kind === 'track' ? { artist: { id: 'performer', name: 'Performer' }, subtitle: 'Performer',
    ranking: { mode: 'journey', stop_count: 2, fallback_reason: null } } : {}) })
const fixture = (kind = 'artist') => ({ version: 1, rootId: 'a', focusId: 'b', selectedNodeId: 'b',
  journey: ['a', 'b'], nodes: [node('a', kind), node('b', kind, 'a')],
  edges: [{ id: 'a::b', source: 'a', target: 'b', similarity: 0.6, sharedTags: ['rock'] }] })
const decode = (v) => m.decodeMap(JSON.stringify(v))
const storage = new Map()
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }

test('both modes and journey options round trip topology, pruning parents, selection and metadata', () => {
  for (const kind of ['artist', 'track']) for (const follow of [false, true]) {
    const restored = decode({ ...fixture(kind), followJourney: follow })
    assert.equal(restored.status, 'ready')
    assert.equal(restored.snapshot.followJourney, follow)
    const graph = restored.snapshot.graph
    assert.equal(graph.nodes.size, 2)
    assert.equal(graph.nodes.get('b').parentId, 'a')
    assert.deepEqual([...graph.edges.values()], fixture().edges)
    assert.deepEqual(graph.journey, ['a', 'b'])
    assert.equal(graph.focusId, 'b'); assert.equal(graph.selectedNodeId, 'b')
    assert.equal(graph.nodes.get('a').loading, false)
    assert.equal(graph.nodes.get('a').error, undefined)
    assert.equal(graph.undo, undefined)
    assert.equal(m.saveMap(graph, follow), 'saved')
    const raw = JSON.parse(storage.get(m.MAP_STORAGE_KEY))
    assert.equal('loading' in raw.nodes[0], false)
    assert.equal('error' in raw.nodes[0], false)
    assert.equal(m.readMap().snapshot.graph.nodes.get('b').kind, kind)
    if (kind === 'track') assert.deepEqual(graph.nodes.get('b').ranking, node('b', kind).ranking)
  }
})
test('minimal snapshot defaults optional fields and handles stale selection/trail references', () => {
  const restored = decode({ version: 1, rootId: 'a', nodes: [{ id: 'a', name: 'A', kind: 'artist' }], edges: [] })
  assert.equal(restored.status, 'ready')
  assert.deepEqual(restored.snapshot.graph.journey, ['a'])
  assert.equal(restored.snapshot.followJourney, false)
  assert.equal(restored.snapshot.graph.focusId, 'a')
  const stale = decode({ ...fixture(), focusId: 'gone', selectedNodeId: 'gone', journey: ['a', 'gone', 'a'] })
  assert.deepEqual(stale.snapshot.graph.journey, ['a'])
  assert.equal(stale.snapshot.graph.selectedNodeId, undefined)
})
test('corrupt, unknown versions, invalid topology and mixed modes refuse restoration', () => {
  assert.equal(m.decodeMap(null).status, 'none')
  for (const raw of ['', '{', 'null', '[]', '{}']) assert.equal(m.decodeMap(raw).status, 'invalid')
  for (const bad of [{ version: 2 }, { nodes: [] }, { rootId: 'gone' },
    { nodes: [node('a'), node('a')] }, { nodes: [node('a'), node('b', 'track', 'a')] },
    { nodes: [node('a'), { ...node('b', 'track'), artist: undefined }] },
    { nodes: [node('a'), node('b', 'artist', 'gone')] },
    { nodes: [node('a'), node('b', 'artist', 'c'), node('c', 'artist', 'b')] },
    { edges: [{ id: 'bad', source: 'a', target: 'gone' }] },
    { edges: [fixture().edges[0], fixture().edges[0]] }]) {
    assert.equal(decode({ ...fixture(), ...bad }).status, 'invalid')
  }
})
test('exact node and UTF-8 byte limits; oversized snapshots clear rather than leave stale saves', () => {
  const v = { ...fixture(), nodes: Array.from({ length: 500 }, (_, i) => node(i ? `n${i}` : 'a')),
    focusId: 'a', selectedNodeId: 'a', journey: ['a'], edges: [] }
  const graph = decode(v).snapshot.graph
  assert.equal(m.saveMap(graph, false), 'saved')
  assert.equal(m.readMap().snapshot.graph.nodes.size, 500)
  graph.nodes.set('overflow', node('overflow'))
  assert.equal(m.saveMap(graph, false), 'too-large')
  assert.equal(m.readMap().status, 'none')
  assert.equal(decode({ ...v, nodes: [...v.nodes, node('overflow')] }).status, 'invalid')
  const small = { version: 1, rootId: 'a', nodes: [node('a')], edges: [] }
  const raw = JSON.stringify(small)
  assert.equal(m.decodeMap(raw + ' '.repeat(m.MAP_BYTE_LIMIT - raw.length)).status, 'ready')
  assert.equal(m.decodeMap(raw + ' '.repeat(m.MAP_BYTE_LIMIT - raw.length + 1)).status, 'invalid')
  const bigGraph = decode(fixture()).snapshot.graph
  bigGraph.nodes.get('a').name = '🎵'.repeat(m.MAP_BYTE_LIMIT / 4)
  assert.equal(m.saveMap(bigGraph, false), 'too-large')
  assert.equal(m.readMap().status, 'none')
})
test('clear only affects map storage; disabled storage and quota failures are safe', () => {
  storage.set('tunegraph:taste:v1', 'taste'); storage.set('tunegraph:bookmarks:v1', 'bookmarks')
  m.saveMap(decode(fixture()).snapshot.graph, false); m.clearMap()
  assert.equal(storage.get('tunegraph:taste:v1'), 'taste')
  assert.equal(storage.get('tunegraph:bookmarks:v1'), 'bookmarks')
  globalThis.localStorage = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') }, removeItem() { throw Error('blocked') } }
  assert.equal(m.readMap().status, 'none')
  assert.equal(m.saveMap(decode(fixture()).snapshot.graph, false), 'unavailable')
  assert.doesNotThrow(m.clearMap)
})

test('restored graph still collapses, removes, undoes and expands correctly in both modes', () => {
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  for (const kind of ['artist', 'track']) {
    const value = fixture(kind)
    value.nodes.push(node('c', kind, 'b'))
    value.edges.push({ id: 'b::c', source: 'b', target: 'c' })
    const snapshot = decode(value).snapshot.graph
    const restored = musicGraphReducer({ nodes: new Map(), edges: new Map(), journey: [] }, { type: 'restore', graph: snapshot })
    const collapsed = musicGraphReducer(restored, { type: 'prune', id: 'b', mode: 'collapse' })
    assert.deepEqual([...collapsed.nodes.keys()], ['a', 'b'])
    assert.equal(collapsed.nodes.get('b').expanded, false)
    assert.deepEqual(collapsed.journey, ['a'])
    assert.equal(collapsed.focusId, 'a')
    const undone = musicGraphReducer(collapsed, { type: 'undo' })
    assert.equal(undone.nodes.size, 3)
    const removed = musicGraphReducer(restored, { type: 'prune', id: 'b', mode: 'remove' })
    assert.deepEqual([...removed.nodes.keys()], ['a'])
    assert.equal(removed.selectedNodeId, 'a')
    assert.equal(m.saveMap(removed, false), 'saved')
    const afterReload = m.readMap().snapshot.graph
    assert.equal(afterReload.nodes.size, 1)
    assert.equal(afterReload.undo, undefined)
    const expanded = musicGraphReducer(afterReload, { type: 'expand:success', id: 'a', children: [{ node: node('d', kind) }] })
    assert.equal(expanded.nodes.get('d').parentId, 'a')
    assert.equal(expanded.edges.size, 1)
  }
})
