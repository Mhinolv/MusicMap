// Library sync (#79): rules, the device marker, toasts, and the sync hook with a fake React and API. No browser or GUI.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-library-sync-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/useLibrarySync.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')

// A fake React with stable hook slots across renders, and a fake API the tests drive.
writeFileSync(join(output, 'react.js'), `
let slots = [], index = 0
export const hooks = { effects: [], render(fn) { index = 0; this.effects = []; return fn() }, reset() { slots = [] } }
const slot = (init) => { const i = index++; if (!(i in slots)) slots[i] = init(); return slots[i] }
export const useRef = (value) => slot(() => ({ current: value }))
export const useState = (value) => { const s = slot(() => ({ value })); return [s.value, (next) => { s.value = next }] }
export const useCallback = (fn) => { const s = slot(() => ({ fn })); return s.fn }
export const useLayoutEffect = (fn) => { index++; fn() }
export const useEffect = (fn) => { index++; hooks.effects.push(fn) }
`)
writeFileSync(join(output, 'api.js'), `
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status } }
export const api = { calls: [], handlers: {} }
for (const name of ['userLibrary', 'putUserBookmarks', 'putUserExclusions', 'mergeUserLibrary']) {
  api[name] = (...args) => { api.calls.push([name, ...args]); return api.handlers[name](...args) }
}
`)
// tsc keeps extensionless imports; node needs `.js`. React and the API resolve to the fakes.
for (const file of readdirSync(output).filter((name) => name.endsWith('.js'))) {
  const path = join(output, file)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.js'").replace(/from 'react'/g, "from './react.js'"))
}
const s = await import(pathToFileURL(join(output, 'librarySync.js')).href)
const { useLibrarySync } = await import(pathToFileURL(join(output, 'useLibrarySync.js')).href)
const { hooks } = await import(pathToFileURL(join(output, 'react.js')).href)
const { api, ApiError } = await import(pathToFileURL(join(output, 'api.js')).href)

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

const artist = (id, savedAt = 1) => ({ kind: 'artist', item: { id, name: `Artist ${id}` }, savedAt })
const song = (id, savedAt = 1) => ({ kind: 'track', item: { id, name: `Song ${id}`, artist: { id: 'a', name: 'A' } }, savedAt })
const linked = (extra = {}) => ({ user: 'u1', bookmarks: false, exclusions: false, ...extra })
const wire = (items) => ({ version: 1, items })
// The decoders set absent optional fields to undefined; compare the stored JSON shape.
const plain = (value) => JSON.parse(JSON.stringify(value))
const wireLists = (bookmarks, exclusions, extra = {}) => ({ bookmarks: wire(bookmarks), exclusions: wire(exclusions), ...extra })

test('copy matches the design notes and the list caps', () => {
  assert.equal(s.LIBRARY_MERGE_ADDED, 'Added your Library from this device to your account.')
  assert.equal(s.LIBRARY_MERGE_CAPPED, "Some items didn't fit. Saved keeps 200 and Not suggested keeps 100.")
  assert.equal(s.LIBRARY_SYNC_FAILED_TOAST, "Couldn't sync your Library. It's saved on this device.")
  assert.equal(s.libraryNote(false), 'Kept on this device. Songs marked "Don\'t suggest again" move to Not suggested, where you can restore them.')
  assert.equal(s.libraryNote(true), 'Synced to your account. Songs marked "Don\'t suggest again" move to Not suggested, where you can restore them.')
})

test('the account popover shows the worst state of taste, history and Library', async () => {
  const { worstSync } = await import(pathToFileURL(join(output, 'tasteSync.js')).href)
  assert.equal(worstSync(), 'synced')
  assert.equal(worstSync('synced', 'synced', 'synced'), 'synced')
  assert.equal(worstSync('synced', 'saving', 'synced'), 'saving')
  assert.equal(worstSync('saving', 'offline', 'synced'), 'offline')
  assert.equal(worstSync('offline', 'synced', 'failed'), 'failed')
  assert.equal(worstSync('failed', 'saving', 'offline'), 'failed')
})

test('merge toast: added, added with cap, cap only, and nothing', () => {
  assert.deepEqual(s.libraryMergeToast({ added: 2, capped: [] }), { msg: s.LIBRARY_MERGE_ADDED })
  assert.deepEqual(s.libraryMergeToast({ added: 1, capped: ['exclusions'] }), { msg: s.LIBRARY_MERGE_ADDED, lines: [s.LIBRARY_MERGE_CAPPED] })
  assert.deepEqual(s.libraryMergeToast({ added: 0, capped: ['bookmarks'] }), { msg: s.LIBRARY_MERGE_CAPPED })
  assert.equal(s.libraryMergeToast({ added: 0, capped: [] }), null)
})

test('sync step: merge for a new device or another account, push a pending list, else pull', () => {
  assert.equal(s.nextLibraryStep(null, 'u1'), 'merge')
  assert.equal(s.nextLibraryStep(linked({ user: 'u2', bookmarks: true }), 'u1'), 'merge')
  assert.equal(s.nextLibraryStep(linked({ bookmarks: true }), 'u1'), 'push')
  assert.equal(s.nextLibraryStep(linked({ exclusions: true }), 'u1'), 'push')
  assert.equal(s.nextLibraryStep(linked(), 'u1'), 'pull')
})

test('marker round trip, tolerant decoding, per-list edits and sign-out', () => {
  store.clear()
  assert.equal(s.readLibraryMarker(), null)
  s.writeLibraryMarker(linked())
  assert.deepEqual(s.readLibraryMarker(), linked())
  s.writeLibraryMarker(s.editedLibraryMarker(s.readLibraryMarker(), 'exclusions'))
  assert.deepEqual(s.readLibraryMarker(), linked({ exclusions: true }))
  assert.equal(s.editedLibraryMarker(null, 'bookmarks'), null)
  for (const raw of ['not json', 'null', '{}', '{"user":""}', '{"user":5}', '[]']) {
    store.set(s.LIBRARY_SYNC_KEY, raw)
    assert.equal(s.readLibraryMarker(), null, raw)
  }
  store.set(s.LIBRARY_SYNC_KEY, '{"user":"u1","bookmarks":"yes"}')
  assert.deepEqual(s.readLibraryMarker(), linked())
  s.writeLibraryMarker(null)
  assert.equal(store.has(s.LIBRARY_SYNC_KEY), false)
  for (const key of ['tunegraph:bookmarks:v1', 'tunegraph:exclusions:v1']) assert.notEqual(s.LIBRARY_SYNC_KEY, key, 'the v1 list keys keep their shape')
})

test('blocked storage never throws', () => {
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  try {
    assert.equal(s.readLibraryMarker(), null)
    assert.doesNotThrow(() => s.writeLibraryMarker(linked()))
    assert.doesNotThrow(() => s.writeLibraryMarker(null))
  } finally { globalThis.localStorage = saved }
})

test('sameEntries compares keys, order and save times', () => {
  const a = [song('s', 2), artist('x', 1)]
  assert.equal(s.sameEntries(a, structuredClone(a)), true)
  assert.equal(s.sameEntries([], []), true)
  assert.equal(s.sameEntries(a, [...a].reverse()), false)
  assert.equal(s.sameEntries(a, [song('s', 2), artist('x', 9)]), false)
  assert.equal(s.sameEntries(a, [song('s', 2), song('x', 1)]), false, 'an artist and a song with one id are different')
  assert.equal(s.sameEntries(a, a.slice(1)), false)
})

test('server lists go through the tolerant decoders: bad rows drop, songs only in Not suggested, caps hold', () => {
  const lists = s.decodeLibrary({
    bookmarks: { version: 1, items: [artist('x', 1), { kind: 'track', item: { id: 's', name: 'S' }, savedAt: 1 }, song('t', 5)] },
    exclusions: { version: 1, items: [artist('y'), song('e', 3), ...Array.from({ length: 120 }, (_, i) => song(`f${i}`, 2))] },
  })
  assert.deepEqual(lists.bookmarks.map((e) => e.item.id), ['t', 'x'])
  assert.equal(lists.exclusions.length, 100)
  assert.ok(lists.exclusions.every((e) => e.kind === 'track'))
  for (const bad of [null, undefined, {}, { bookmarks: 'x', exclusions: { version: 2, items: [] } }]) {
    assert.deepEqual(s.decodeLibrary(bad), { bookmarks: [], exclusions: [] })
  }
  const merge = s.decodeLibraryMerge({ bookmarks: wire([artist('x')]), added: 2, capped: ['exclusions', 'nope'] })
  assert.deepEqual(plain(merge), { bookmarks: [artist('x')], exclusions: [], added: 2, capped: ['exclusions'] })
  assert.deepEqual(s.decodeLibraryMerge({ added: -1, capped: 'bookmarks' }), { bookmarks: [], exclusions: [], added: 0, capped: [] })
})

// ---- the hook: merge, push, pull and account changes ------------------------------

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function mount({ bookmarks = [], exclusions = [], user = { id: 'u1' } } = {}) {
  hooks.reset()
  const h = {
    user, applied: [], merged: [], failed: 0,
    bookmarksRef: { current: bookmarks }, exclusionsRef: { current: exclusions },
  }
  h.render = () => {
    h.result = hooks.render(() => useLibrarySync({
      user: h.user, bookmarksRef: h.bookmarksRef, exclusionsRef: h.exclusionsRef,
      apply: (lists) => { h.applied.push(lists); h.bookmarksRef.current = lists.bookmarks; h.exclusionsRef.current = lists.exclusions },
      onMerged: (result) => h.merged.push(result),
      onWriteFailed: () => { h.failed += 1 },
    }))
    return h.result
  }
  h.render()
  return h
}
const mountAndSync = async (options) => {
  const h = mount(options)
  hooks.effects[0]()
  await settle()
  return h
}

beforeEach(() => {
  store.clear()
  api.calls.length = 0
  api.handlers = {}
})

test('first sign-in merges both lists, applies the account copy, links the device and reports the result', async () => {
  const local = { bookmarks: [artist('x')], exclusions: [song('e')] }
  const cloud = { bookmarks: [artist('x'), artist('y')], exclusions: [song('e')], added: 1, capped: [] }
  api.handlers.mergeUserLibrary = async () => wireLists(cloud.bookmarks, cloud.exclusions, { added: 1, capped: [] })
  const h = await mountAndSync(local)
  assert.deepEqual(api.calls, [['mergeUserLibrary', local.bookmarks, local.exclusions]])
  assert.deepEqual(plain(h.applied), [cloud])
  assert.deepEqual(plain(h.merged), [cloud])
  assert.deepEqual(s.readLibraryMarker(), linked())
  assert.equal(h.render().status, 'synced')
})

test('an edit pushes only its list, then the marker clears', async () => {
  s.writeLibraryMarker(linked())
  api.handlers.userLibrary = async () => wireLists([], [])
  const h = await mountAndSync()
  api.calls.length = 0
  api.handlers.putUserExclusions = async () => ({})
  h.exclusionsRef.current = [song('e', 9)]
  h.result.edited('exclusions')
  await settle()
  assert.deepEqual(api.calls, [['putUserExclusions', [song('e', 9)]]])
  assert.deepEqual(s.readLibraryMarker(), linked())
  // Undo or a later edit of the other list pushes that list.
  api.calls.length = 0
  api.handlers.putUserBookmarks = async () => ({})
  h.bookmarksRef.current = [artist('x', 3)]
  h.result.edited('bookmarks')
  await settle()
  assert.deepEqual(api.calls, [['putUserBookmarks', [artist('x', 3)]]])
})

test('a pull on another device replaces only the lists that changed, with no toast', async () => {
  const keep = [song('e', 4)]
  s.writeLibraryMarker(linked())
  api.handlers.userLibrary = async () => wireLists([artist('new', 8)], structuredClone(keep))
  const h = await mountAndSync({ bookmarks: [artist('old', 1)], exclusions: keep })
  assert.deepEqual(api.calls, [['userLibrary']])
  assert.equal(h.applied.length, 1)
  assert.deepEqual(plain(h.applied[0].bookmarks), [artist('new', 8)])
  assert.equal(h.applied[0].exclusions, keep, 'an unchanged list keeps its array')
  assert.deepEqual(h.merged, [])
  // The same lists again: nothing to apply.
  h.applied.length = 0
  hooks.effects[0]()
  await settle()
  assert.deepEqual(h.applied, [])
})

test('a local edit during a pull wins and is pushed on the next pass', async () => {
  s.writeLibraryMarker(linked())
  let release
  api.handlers.userLibrary = () => new Promise((resolve) => { release = () => resolve(wireLists([], [])) })
  api.handlers.putUserBookmarks = async () => ({})
  const h = mount({ bookmarks: [artist('x')] })
  hooks.effects[0]()
  await settle()
  h.bookmarksRef.current = [artist('x'), artist('y', 5)]
  h.result.edited('bookmarks')
  release()
  await settle()
  await settle()
  assert.deepEqual(h.applied, [], 'the pulled list must not replace the newer local edit')
  assert.deepEqual(api.calls.map(([name]) => name), ['userLibrary', 'putUserBookmarks'])
  assert.deepEqual(api.calls[1][1], [artist('x'), artist('y', 5)])
  assert.deepEqual(s.readLibraryMarker(), linked())
})

test('an edit during the merge merges again with the newer lists', async () => {
  let calls = 0
  api.handlers.mergeUserLibrary = async (bookmarks, exclusions) => { calls += 1; return wireLists(bookmarks, exclusions, { added: 0, capped: [] }) }
  const h = mount({ bookmarks: [artist('x')] })
  hooks.effects[0]()
  h.bookmarksRef.current = [artist('x'), artist('y')]
  await settle()
  await settle()
  assert.equal(calls, 2)
  assert.deepEqual(api.calls[1][1], [artist('x'), artist('y')])
  assert.equal(h.merged.length, 1)
})

test('a failed write shows Failed or Offline, calls onWriteFailed and keeps the list pending', async () => {
  s.writeLibraryMarker(linked({ bookmarks: true }))
  api.handlers.putUserBookmarks = async () => { throw new ApiError('store error', 502) }
  const h = await mountAndSync({ bookmarks: [artist('x')] })
  assert.equal(h.render().status, 'failed')
  assert.equal(h.failed, 1)
  assert.deepEqual(s.readLibraryMarker(), linked({ bookmarks: true }))
  api.handlers.putUserBookmarks = async () => { throw new ApiError('Network error', 0) }
  hooks.effects[0]()
  await settle()
  assert.equal(h.render().status, 'offline')
  // A failed pull changes the status but is not a write failure.
  s.writeLibraryMarker(linked())
  api.handlers.userLibrary = async () => { throw new ApiError('store error', 502) }
  hooks.effects[0]()
  await settle()
  assert.equal(h.failed, 2)
  assert.equal(h.render().status, 'failed')
})

test('sign-out during a request drops the answer; signed out, nothing syncs', async () => {
  let release
  api.handlers.mergeUserLibrary = () => new Promise((resolve) => { release = () => resolve(wireLists([artist('cloud')], [], { added: 0, capped: [] })) })
  const h = mount({ bookmarks: [artist('x')] })
  hooks.effects[0]()
  await settle()
  h.user = null
  h.render()
  release()
  await settle()
  assert.deepEqual(h.applied, [])
  assert.deepEqual(h.merged, [])
  assert.equal(s.readLibraryMarker(), null)
  api.calls.length = 0
  h.result.edited('bookmarks')
  hooks.effects[0]()
  await settle()
  assert.deepEqual(api.calls, [])
  assert.equal(h.render().status, 'synced')
})
