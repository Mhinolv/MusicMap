// Map session history (#77): storage, cap, legacy map, merge and row copy. No browser or GUI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const modules = {}
const load = (path, name) => {
  const source = ts.transpileModule(readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function('exports', 'require', source)(exports, (dep) => modules[dep] ?? {})
  modules[name] = exports
  return exports
}
const snap = load('graph/mapSnapshot.ts', './graph/mapSnapshot')
load('startScreen.ts', './startScreen')
const h = load('history.ts', './history')

const storage = new Map()
const memory = () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) })
globalThis.localStorage = memory()

const map = (root = 'radiohead', kind = 'artist', extra = 1) => JSON.stringify({ version: 1, rootId: root, journey: [root],
  nodes: [{ id: root, name: `Seed ${root}`, kind, ...(kind === 'track' ? { artist: { id: 'a', name: 'A' } } : {}) },
    ...Array.from({ length: extra }, (_, i) => ({ id: `${root}-${i}`, name: `N${i}`, kind, parentId: root,
      ...(kind === 'track' ? { artist: { id: 'a', name: 'A' } } : {}) }))], edges: [] })
const session = (id, updatedAt, root = id) => ({ id, seed: `Seed ${root}`, mode: 'artist', stops: 1, updatedAt, map: map(root) })

test.beforeEach(() => { storage.clear(); globalThis.localStorage = memory() })

test('write and read round trip, newest first, at most 5', () => {
  const six = [1, 6, 3, 2, 5, 4].map((t) => session(`s${t}`, t))
  assert.equal(h.writeHistory(six.slice(0, 5)), true)
  assert.deepEqual(h.readHistory().map((s) => s.id), ['s6', 's5', 's3', 's2', 's1'])
  storage.set(h.HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, sessions: six }))
  assert.deepEqual(h.readHistory().map((s) => s.id), ['s6', 's5', 's4', 's3', 's2'])
})

test('upsert replaces by id, moves the session to the top and drops the oldest past 5', () => {
  let list = []
  for (let t = 1; t <= 5; t++) list = h.upsertSession(list, session(`s${t}`, t))
  assert.deepEqual(list.map((s) => s.id), ['s5', 's4', 's3', 's2', 's1'])
  list = h.upsertSession(list, { ...session('s2', 9), stops: 4 })
  assert.deepEqual(list.map((s) => s.id), ['s2', 's5', 's4', 's3', 's1'])
  assert.equal(list[0].stops, 4)
  list = h.upsertSession(list, session('s6', 10))
  assert.deepEqual(list.map((s) => s.id), ['s6', 's2', 's5', 's4', 's3'])
  assert.equal(h.HISTORY_LIMIT, 5)
})

test('decode skips corrupt rows and duplicates, defaults optional fields, keeps rows with bad maps', () => {
  for (const raw of [null, '', '{', '[]', '{"version":2,"sessions":[]}', '{"version":1}']) assert.deepEqual(h.decodeHistory(raw), [])
  const raw = JSON.stringify({ version: 1, sessions: [
    session('ok', 5), session('ok', 4), { ...session('bad-map', 3), map: '{broken' },
    { id: 'no seed', seed: '', mode: 'artist', map: '' }, { id: 'x', seed: 'X', mode: 'playlist', map: '' },
    { id: 'bad.id', seed: 'X', mode: 'artist', map: '' }, { id: 'defaults', seed: 'D', mode: 'track', map: map(), stops: -1, updatedAt: 'soon' },
    null, 7,
  ] })
  const list = h.decodeHistory(raw)
  assert.deepEqual(list.map((s) => s.id), ['ok', 'bad-map', 'defaults'])
  assert.equal(list[2].stops, 0)
  assert.equal(list[2].updatedAt, 0)
  assert.equal(list[2].mode, 'track')
  assert.equal(h.sessionMap(list[1]).status, 'invalid')
  assert.equal(h.sessionMap(list[0]).status, 'ready')
  assert.equal(h.sessionMap({ ...session('empty', 1), map: '' }).status, 'invalid')
  assert.equal('pending' in list[0], false)
  assert.equal(h.decodeHistory(JSON.stringify({ version: 1, sessions: [{ ...session('p', 1), pending: true }] }))[0].pending, true)
})

test('a map saved in tunegraph:map:v1 still loads as the newest session', () => {
  storage.set(snap.MAP_STORAGE_KEY, map('legacy'))
  const list = h.readHistory()
  assert.equal(list.length, 1)
  assert.equal(list[0].seed, 'Seed legacy')
  assert.equal(list[0].map, map('legacy'))
  assert.equal(h.sessionMap(list[0]).status, 'ready')
  // The fold is written back, so the session keeps its id on the next load.
  assert.equal(h.readHistory()[0].id, list[0].id)
  // A legacy map beside history joins it; a damaged legacy map is then ignored.
  storage.set(h.HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, sessions: [session('old', 1)] }))
  assert.deepEqual(h.readHistory().map((s) => s.seed), ['Seed legacy', 'Seed old'])
  storage.set(snap.MAP_STORAGE_KEY, '{broken')
  assert.deepEqual(h.readHistory().map((s) => s.seed), ['Seed legacy', 'Seed old'])
})

test('a damaged legacy map with no history still shows as a map that cannot be restored', () => {
  storage.set(snap.MAP_STORAGE_KEY, '{broken')
  const list = h.readHistory()
  assert.equal(list.length, 1)
  assert.equal(list[0].seed, 'Last map')
  assert.equal(h.sessionMap(list[0]).status, 'invalid')
})

test('a newer single-map copy of the newest session replaces its map; the same copy changes nothing', () => {
  const list = [session('a', 2, 'radiohead'), session('b', 1, 'bjork')]
  assert.equal(h.foldLegacyMap(list, list[0].map), list)
  assert.equal(h.foldLegacyMap(list, null), list)
  const edited = map('radiohead', 'artist', 3)
  const folded = h.foldLegacyMap(list, edited)
  assert.deepEqual(folded.map((s) => s.id), ['a', 'b'])
  assert.equal(folded[0].map, edited)
  const other = h.foldLegacyMap(list, map('portishead'), 3)
  assert.deepEqual(other.map((s) => s.seed), ['Seed portishead', 'Seed radiohead', 'Seed bjork'])
})

test('sessionFromGraph takes seed, mode and stops from the graph, in both modes', () => {
  for (const kind of ['artist', 'track']) {
    const graph = snap.decodeMap(map('root', kind, 2)).snapshot.graph
    graph.journey = ['root', 'root-0']
    const s = h.sessionFromGraph('id1', graph, 'raw', 42)
    assert.deepEqual(s, { id: 'id1', seed: 'Seed root', mode: kind, stops: 2, updatedAt: 42, map: 'raw' })
  }
})

test('merge keeps the newer copy per id, then the newest 5; undo restores within the cap', () => {
  const cloud = [session('a', 5), session('b', 3), session('c', 1)]
  const local = [{ ...session('a', 4), stops: 9 }, { ...session('b', 6), stops: 7 }, session('d', 2), session('e', 7), session('f', 0)]
  const merged = h.mergeSessions(cloud, local)
  assert.deepEqual(merged.map((s) => s.id), ['e', 'b', 'a', 'd', 'c'])
  assert.equal(merged.find((s) => s.id === 'a').stops, 1)
  assert.equal(merged.find((s) => s.id === 'b').stops, 7)
  assert.deepEqual(h.mergeSessions([], []), [])
  const kept = [session('x', 10)]
  assert.deepEqual(h.restoreSessions(kept, [session('y', 5), session('x', 1)]).map((s) => s.id), ['x', 'y'])
  const full = [1, 2, 3, 4, 5].map((t) => session(`n${t}`, 10 + t))
  assert.deepEqual(h.restoreSessions(full, [session('old', 1)]).map((s) => s.id), ['n5', 'n4', 'n3', 'n2', 'n1'])
})

test('pull keeps a local map at least as new, fetches the rest, and keeps a row when a fetch fails', async () => {
  const meta = (id, updated_at) => ({ id, seed: `Seed ${id}`, mode: 'artist', stops: 2, updated_at })
  const local = [session('a', 5), session('b', 1)]
  const asked = []
  const pulled = await h.pullSessions([meta('c', 9), meta('a', 5), meta('b', 3), meta('gone', 2)], local, async (id) => {
    asked.push(id)
    if (id === 'gone') throw new Error('offline')
    return map(id, 'artist', 2)
  })
  assert.deepEqual(asked.sort(), ['b', 'c', 'gone'])
  assert.deepEqual(pulled.map((s) => s.id), ['c', 'a', 'b', 'gone'])
  assert.equal(pulled[1].map, local[0].map)
  assert.equal(pulled[2].map, map('b', 'artist', 2))
  assert.equal(pulled[3].map, '')
  assert.equal(h.sessionMap(pulled[3]).status, 'invalid')
})

test('a full quota drops the oldest maps until the rest fit; blocked storage is safe', () => {
  const list = [5, 4, 3, 2, 1].map((t) => session(`s${t}`, t))
  globalThis.localStorage = { ...memory(), setItem: (key, value) => {
    if (JSON.parse(value).sessions.length > 2) throw new Error('quota')
    storage.set(key, value)
  } }
  assert.equal(h.writeHistory(list), true)
  assert.deepEqual(h.readHistory().map((s) => s.id), ['s5', 's4'])
  assert.equal(h.writeHistory([]), true)
  assert.equal(storage.has(h.HISTORY_STORAGE_KEY), false)
  globalThis.localStorage = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') }, removeItem() { throw Error('blocked') } }
  assert.deepEqual(h.readHistory(), [])
  assert.equal(h.writeHistory(list), false)
  assert.equal(h.writeHistory([]), false)
})

test('row copy: today with 24-hour time, older days use the Library words, stops pluralise', () => {
  const now = new Date(2026, 9, 16, 18, 0).getTime()
  assert.equal(h.historyWhen(new Date(2026, 9, 16, 14, 32).getTime(), now), 'today, 14:32')
  assert.equal(h.historyWhen(new Date(2026, 9, 16, 9, 5).getTime(), now), 'today, 09:05')
  assert.equal(h.historyWhen(new Date(2026, 9, 15, 23, 59).getTime(), now), 'yesterday')
  assert.equal(h.historyWhen(new Date(2026, 9, 1, 12).getTime(), now), '1 Oct')
  assert.equal(h.historyWhen(0, now), '')
  const at = new Date(2026, 9, 16, 14, 32).getTime()
  assert.equal(h.historySub({ ...session('a', at), stops: 3 }, now), 'Artist · 3 stops · today, 14:32')
  assert.equal(h.historySub({ ...session('a', at), mode: 'track', stops: 1 }, now), 'Song · 1 stop · today, 14:32')
  assert.equal(h.historySub({ ...session('a', 0), stops: 0 }, now), 'Artist · 0 stops')
  assert.equal(h.historyNote(false), 'Kept on this device. The last 5 maps save on their own.')
  assert.equal(h.historyNote(true), 'Synced to your account. The last 5 maps save on their own.')
})

test('new session ids pass the server id rule', () => {
  const ids = new Set(Array.from({ length: 20 }, () => h.newSessionId()))
  assert.equal(ids.size, 20)
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/)
})
