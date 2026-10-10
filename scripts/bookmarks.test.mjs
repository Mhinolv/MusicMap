// Run with node --test scripts/bookmarks.test.mjs; no browser or extra dependencies.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-bookmarks-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/bookmarks.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const b = await import(pathToFileURL(join(output, 'bookmarks.js')).href)
const artist = (id = 'a', savedAt = 1) => ({ kind: 'artist', item: { id, name: `Artist ${id}` }, savedAt })
const track = (id = 'a', savedAt = 2) => ({ kind: 'track', item: { id, name: 'Song', artist: artist().item }, savedAt })
const encode = (items) => JSON.stringify({ version: 1, items })

test('decoding handles missing, corrupt, unknown-version and invalid storage', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}', '{"version":2,"items":[]}', '{"version":1,"items":{}}']) {
    assert.deepEqual(b.decodeBookmarks(raw), [])
  }
  assert.deepEqual(b.decodeBookmarks(encode([null, {}, { ...artist(), kind: 'other' },
    { ...artist(), item: { id: '', name: 'bad' } }, { ...track(), item: { id: 't', name: 'bad' } }])), [])
})

test('decoding keeps valid rows, defaults optional fields, deduplicates by kind and sorts newest first', () => {
  const entries = b.decodeBookmarks(encode([artist(), null, artist(), track(), { ...artist('b'), savedAt: 'bad' }]))
  assert.deepEqual(entries.map(b.bookmarkKey), ['track:a', 'artist:a', 'artist:b'])
  assert.equal(entries[2].savedAt, 0)
  assert.equal(entries[0].item.artist.name, 'Artist a')
  for (const savedAt of [-1, null, 'x']) assert.equal(b.decodeBookmarks(encode([{ ...artist(), savedAt }]))[0].savedAt, 0)
})

test('save supports both modes, duplicate names, duplicate ids and the exact 200 cap', () => {
  let entries = b.addBookmark([], artist())
  assert.equal(entries.length, 1)
  assert.equal(b.addBookmark(entries, artist()), entries)
  entries = b.addBookmark(entries, track())
  assert.equal(entries.length, 2)
  const sameName = { ...track('b'), item: { ...track('b').item, artist: artist('different').item } }
  assert.equal(b.addBookmark(entries, sameName).length, 3)
  const full = Array.from({ length: 200 }, (_, i) => artist(String(i)))
  assert.equal(b.addBookmark(full, artist('new')), full)
  assert.equal(b.addBookmark(full, full[0]), full)
  assert.equal(b.addBookmark(full.slice(1), artist('new')).length, 200)
  assert.equal(b.decodeBookmarks(encode([...full, artist('overflow')])).length, 200)
  assert.equal(b.BOOKMARK_FULL_MESSAGE, 'Saved list is full (200). Remove some to save more.')
})

test('Undo restores remove/clear without overwriting newer saves or duplicating entries', () => {
  assert.deepEqual(b.restoreBookmarks([], []), [])
  assert.deepEqual(b.restoreBookmarks([], [artist(), track()]).map(b.bookmarkKey), ['track:a', 'artist:a'])
  assert.deepEqual(b.restoreBookmarks([artist('new', 3)], [artist(), track()]).map(b.bookmarkKey), ['artist:new', 'track:a', 'artist:a'])
  assert.equal(b.restoreBookmarks([artist()], [artist()]).length, 1)
  const full = Array.from({ length: 200 }, (_, i) => artist(String(i)))
  assert.equal(b.restoreBookmarks(full, [track()]).length, 200)
  const almostFull = full.slice(1)
  assert.equal(b.restoreBookmarks(almostFull, [track(), artist('extra')]), almostFull)
})

test('node conversion stores references in both modes and rejects a song without its artist', () => {
  const node = { id: 'a', name: 'Artist a', kind: 'artist', expanded: true, loading: true, tags: ['rock'], imageUrl: 'image', mbid: 'mbid' }
  assert.deepEqual(b.nodeBookmark(node, 5), { kind: 'artist', item: { id: 'a', name: 'Artist a', image_url: 'image', mbid: 'mbid' }, savedAt: 5 })
  assert.equal(b.nodeBookmark({ ...node, kind: 'track' }, 5), null)
  const song = b.nodeBookmark({ ...node, kind: 'track', artist: artist().item }, 5)
  assert.equal(song.kind, 'track')
  assert.equal(song.item.artist.id, 'a')
  assert.equal(song.item.expanded, undefined)
})

test('storage round trip stays separate from taste and gracefully handles read/write errors', () => {
  const storage = new Map([['tunegraph:taste:v1', 'existing taste']])
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  assert.deepEqual(b.readBookmarks(), [])
  assert.equal(b.writeBookmarks([artist(), track()]), true)
  assert.equal(b.readBookmarks().length, 2)
  assert.equal(storage.get('tunegraph:taste:v1'), 'existing taste')
  assert.equal(JSON.parse(storage.get(b.BOOKMARK_STORAGE_KEY)).version, 1)
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }
  assert.deepEqual(b.readBookmarks(), [])
  assert.equal(b.writeBookmarks([artist()]), false)
  delete globalThis.localStorage
})
