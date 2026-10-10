// Pure persistence tests; no GUI or browser.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-exclusions-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/exclusions.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const emitted = join(output, 'exclusions.js')
writeFileSync(emitted, readFileSync(emitted, 'utf8').replace("'./bookmarks'", "'./bookmarks.js'"))
const e = await import(pathToFileURL(emitted).href)
const song = (id = 's', savedAt = 1) => ({ kind: 'track', item: { id, name: 'Song', artist: { id: 'a', name: 'Artist' } }, savedAt })
const encode = (items) => JSON.stringify({ version: 1, items })

test('tolerant decoding handles corruption, optional defaults, songs only and duplicate IDs', () => {
  for (const raw of [null, '', '{', 'null', '{}', '{"version":2,"items":[]}', '{"version":1,"items":{}}']) {
    assert.deepEqual(e.decodeExclusions(raw), [])
  }
  const decoded = e.decodeExclusions(encode([null, {}, song(), song(), { kind: 'artist', item: song().item },
    { ...song('bad'), item: { id: 'bad', name: 'Bad' } }, { ...song('new'), savedAt: 'bad' }]))
  assert.deepEqual(decoded.map(v => v.item.id), ['s', 'new'])
  assert.equal(decoded[1].savedAt, 0)
})

test('exact 100 cap, restore after remove/reset, deduplication and subsequent changes', () => {
  const full = Array.from({ length: 100 }, (_, i) => song(String(i), i))
  assert.equal(e.decodeExclusions(encode([...full, song('overflow')])).length, 100)
  assert.equal(e.addExclusion(full, song('overflow')), full)
  assert.equal(e.addExclusion(full, full[0]), full)
  assert.equal(e.addExclusion(full.slice(1), song('new')).length, 100)
  assert.deepEqual(e.addExclusion([], song()), [song()])
  assert.equal(e.addExclusion([song()], song()).length, 1)
  assert.equal(e.restoreExclusions(full, [song('new')]), full)
  assert.equal(e.restoreExclusions(full.slice(1), [song('new')]).length, 100)
  assert.equal(e.restoreExclusions(full, [full[0]]).length, 100)
  assert.deepEqual(e.restoreExclusions([], full), [...full].reverse())
  assert.deepEqual(e.restoreExclusions([song('later', 3)], [song('removed', 2)]).map(v => v.item.id), ['later', 'removed'])
  assert.deepEqual(e.restoreExclusions([], []), [])
})

test('reload round trip is independent of Saved and taste; blocked storage fails softly', () => {
  const storage = new Map([['tunegraph:taste:v1', 'taste'], ['tunegraph:bookmarks:v1', 'saved']])
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  assert.deepEqual(e.readExclusions(), [])
  assert.equal(e.writeExclusions([song()]), true)
  assert.deepEqual(JSON.parse(JSON.stringify(e.readExclusions())), [song()])
  assert.equal(storage.get('tunegraph:taste:v1'), 'taste')
  assert.equal(storage.get('tunegraph:bookmarks:v1'), 'saved')
  globalThis.localStorage = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  assert.deepEqual(e.readExclusions(), [])
  assert.equal(e.writeExclusions([song()]), false)
  delete globalThis.localStorage
})
