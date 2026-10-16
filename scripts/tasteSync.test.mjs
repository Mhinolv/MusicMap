// Taste sync rules (#76): sync steps, the device marker, profile compare and toasts. No browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-taste-sync-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/tasteSync.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
// tsc keeps extensionless imports; node needs `.js`.
for (const file of ['tasteSync.js', 'taste.js']) {
  const path = join(output, file)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.js'"))
}
const s = await import(pathToFileURL(join(output, 'tasteSync.js')).href)

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}
const profile = (overrides = {}) => ({ liked_artists: [], liked_tracks: [], liked_genres: [], disliked: [], notes: '', ...overrides })

test('status text and colours match the design notes', () => {
  assert.deepEqual(s.SYNC_TEXT, {
    synced: 'Synced', saving: 'Saving…',
    offline: 'Offline. Saved on this device.', failed: "Couldn't sync. Saved on this device.",
  })
  assert.deepEqual(['synced', 'saving', 'offline', 'failed'].map(s.syncWarns), [false, false, true, true])
  assert.equal(s.SYNC_FAILED_TOAST, "Couldn't sync your taste. It's saved on this device.")
  assert.equal(s.CLEARED_ALL_TOAST, 'Taste cleared on all your devices.')
  assert.equal(s.CLEAR_ALL_CONFIRM, 'This clears your profile on all your devices.')
})

test('sync step: merge for a new device or another account, push pending edits, else pull', () => {
  assert.equal(s.nextSyncStep(null, 'u1'), 'merge')
  assert.equal(s.nextSyncStep({ user: 'u2', pending: true }, 'u1'), 'merge')
  assert.equal(s.nextSyncStep({ user: 'u1', pending: true }, 'u1'), 'push')
  assert.equal(s.nextSyncStep({ user: 'u1', pending: false }, 'u1'), 'pull')
})

test('marker round trip, tolerant decoding, edits and sign-out', () => {
  store.clear()
  assert.equal(s.readSyncMarker(), null)
  s.writeSyncMarker({ user: 'u1', pending: false })
  assert.deepEqual(s.readSyncMarker(), { user: 'u1', pending: false })
  s.writeSyncMarker(s.editedMarker(s.readSyncMarker()))
  assert.deepEqual(s.readSyncMarker(), { user: 'u1', pending: true })
  // An unlinked device has no marker to mark: the next sign-in merges.
  assert.equal(s.editedMarker(null), null)
  for (const raw of ['not json', 'null', '{}', '{"user":""}', '{"user":5}', '[]']) {
    store.set(s.TASTE_SYNC_KEY, raw)
    assert.equal(s.readSyncMarker(), null, raw)
  }
  store.set(s.TASTE_SYNC_KEY, '{"user":"u1","pending":"yes"}')
  assert.deepEqual(s.readSyncMarker(), { user: 'u1', pending: false })
  s.writeSyncMarker(null)
  assert.equal(store.has(s.TASTE_SYNC_KEY), false)
  assert.notEqual(s.TASTE_SYNC_KEY, 'tunegraph:taste:v1', 'the v1 profile key keeps its shape')
})

test('blocked storage never throws', () => {
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  try {
    assert.equal(s.readSyncMarker(), null)
    assert.doesNotThrow(() => s.writeSyncMarker({ user: 'u1', pending: true }))
    assert.doesNotThrow(() => s.writeSyncMarker(null))
  } finally { globalThis.localStorage = saved }
})

test('sameTaste compares every list in order and the notes; empty equals null', () => {
  const a = profile({ liked_artists: ['Radiohead', 'Portishead'], disliked: ['Polka'], notes: 'Slow' })
  assert.equal(s.sameTaste(a, structuredClone(a)), true)
  assert.equal(s.sameTaste(null, null), true)
  assert.equal(s.sameTaste(null, profile()), true)
  assert.equal(s.sameTaste(profile(), null), true)
  assert.equal(s.sameTaste(a, null), false)
  assert.equal(s.sameTaste(null, a), false)
  assert.equal(s.sameTaste(a, { ...a, liked_artists: ['Portishead', 'Radiohead'] }), false)
  for (const list of ['liked_artists', 'liked_tracks', 'liked_genres', 'disliked']) {
    assert.equal(s.sameTaste(a, { ...a, [list]: [...a[list], 'Extra'] }), false, list)
  }
  assert.equal(s.sameTaste(a, { ...a, notes: 'Fast' }), false)
})

test('merge toast: added, added with cap, cap only, and nothing', () => {
  assert.deepEqual(s.mergeToast({ added: 3, capped: [] }), { msg: 'Added your taste from this device to your account.' })
  assert.deepEqual(s.mergeToast({ added: 1, capped: ['liked_artists'] }), {
    msg: 'Added your taste from this device to your account.', lines: ["Some entries didn't fit. Each list keeps 50."],
  })
  assert.deepEqual(s.mergeToast({ added: 0, capped: ['disliked'] }), { msg: "Some entries didn't fit. Each list keeps 50." })
  assert.equal(s.mergeToast({ added: 0, capped: [] }), null)
})

test('failure status: offline browser or network error is Offline; a server error is Failed', () => {
  assert.equal(s.failureStatus(false, 500), 'offline')
  assert.equal(s.failureStatus(true, 0), 'offline')
  assert.equal(s.failureStatus(true, 401), 'failed')
  assert.equal(s.failureStatus(true, 503), 'failed')
})
