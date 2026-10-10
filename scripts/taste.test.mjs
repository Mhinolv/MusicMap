// Pure taste and persistence tests; no browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-taste-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/taste.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const t = await import(pathToFileURL(join(output, 'taste.js')).href)

test('artist/song formatting, missing artist, and 120-character boundary', () => {
  assert.equal(t.tasteEntry({ kind: 'artist', name: ' Radiohead ' }), 'Radiohead')
  assert.equal(t.tasteEntry({ kind: 'track', name: ' Creep ', artist: { name: ' Radiohead ' } }), 'Creep — Radiohead')
  for (const artist of [undefined, { name: '' }, { name: '  ' }]) {
    assert.equal(t.tasteEntry({ kind: 'track', name: 'Song', artist }), 'Song')
  }
  assert.equal(t.tasteEntry({ kind: 'track', name: 'x'.repeat(120), artist: { name: 'Artist' } }).length, 120)
})

test('every toggle creates, matches case/whitespace, removes all matches, and clears last entry', () => {
  for (const list of ['liked_artists', 'liked_tracks', 'disliked']) {
    const profile = t.toggleTaste(null, list, ' Entry ')
    assert.deepEqual(profile[list], ['Entry'])
    assert.equal(t.storedTasteEntry(profile, list, ' entry '), 'Entry')
    assert.equal(t.toggleTaste(profile, list, ' ENTRY '), null)
    const duplicates = { ...profile, [list]: ['Entry', ' entry '] }
    assert.equal(t.toggleTaste(duplicates, list, 'entry'), null)
    assert.equal(t.toggleTaste(profile, list, ''), profile)
    assert.equal(t.toggleTaste(profile, list, '  '), profile)
    assert.equal(profile[list].length, 1, 'input remains unchanged for Undo')
  }
  const song = t.toggleTaste(null, 'liked_tracks', 'Song — Artist')
  assert.deepEqual(song.liked_artists, [], 'liking a song does not add its artist')
})

test('each list accepts item 15, blocks 16, and allows removal at capacity', () => {
  for (const list of ['liked_artists', 'liked_tracks', 'disliked']) {
    const almost = { ...t.emptyTaste(), [list]: Array.from({ length: 14 }, (_, i) => `Item ${i}`) }
    const full = t.toggleTaste(almost, list, 'Last')
    assert.equal(full[list].length, 15)
    assert.equal(t.toggleTaste(full, list, 'Overflow'), full)
    assert.equal(t.toggleTaste(full, list, 'LAST')[list].length, 14)
    assert.equal(t.toggleTaste(almost, list, 'x'.repeat(121))[list].at(-1).length, 120)
  }
})

test('other preferences preserved, dislike-only and whitespace notes cannot be evaluated', () => {
  const previous = { liked_artists: ['Artist'], liked_tracks: ['Song'], liked_genres: ['Pop'], disliked: ['Harsh'], notes: 'Quiet music' }
  for (const list of ['liked_artists', 'liked_tracks', 'disliked']) {
    const next = t.toggleTaste(previous, list, 'New')
    for (const key of Object.keys(previous).filter(key => key !== list)) assert.deepEqual(next[key], previous[key])
  }
  assert.equal(t.hasPositiveTaste(null), false)
  assert.equal(t.hasPositiveTaste(t.toggleTaste(null, 'disliked', 'Harsh')), false)
  assert.equal(t.hasPositiveTaste({ ...t.emptyTaste(), notes: '  ' }), false)
  for (const key of ['liked_artists', 'liked_tracks', 'liked_genres', 'notes']) {
    assert.equal(t.hasPositiveTaste({ ...t.emptyTaste(), [key]: key === 'notes' ? 'note' : ['Entry'] }), true)
  }
  assert.equal(t.isEmptyTaste(t.toggleTaste(null, 'disliked', 'Harsh')), false)
})

test('v1 round trip, last-entry removal, exact Undo snapshot, and blocked/corrupt storage', () => {
  const storage = new Map([['tunegraph:bookmarks:v1', 'bookmarks'], ['tunegraph:exclusions:v1', 'exclusions']])
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  assert.equal(t.readTaste(), null)
  const before = t.toggleTaste(null, 'liked_tracks', 'Creep — Radiohead')
  assert.equal(t.writeTaste(before), true)
  assert.deepEqual(t.readTaste(), before)
  assert.equal(t.writeTaste(t.toggleTaste(before, 'liked_tracks', 'Creep — Radiohead')), true)
  assert.equal(storage.has(t.TASTE_STORAGE_KEY), false)
  assert.equal(t.writeTaste(before), true) // Undo restores the complete previous profile.
  assert.deepEqual(t.readTaste(), before)
  const dislikes = t.toggleTaste(null, 'disliked', 'Harsh')
  t.writeTaste(dislikes)
  assert.deepEqual(t.readTaste(), dislikes)
  assert.equal(storage.get('tunegraph:bookmarks:v1'), 'bookmarks')
  assert.equal(storage.get('tunegraph:exclusions:v1'), 'exclusions')
  for (const raw of ['{', 'null', '{}', JSON.stringify({ ...before, liked_artists: [null] })]) {
    storage.set(t.TASTE_STORAGE_KEY, raw)
    assert.equal(t.readTaste(), null)
  }
  globalThis.localStorage = {
    getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') }, removeItem() { throw Error('blocked') },
  }
  assert.equal(t.readTaste(), null)
  assert.equal(t.writeTaste(before), false)
  assert.equal(t.writeTaste(null), false)
  delete globalThis.localStorage
})

// Execute the actual App callbacks with React hooks replaced by a headless state harness.
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const appSource = ts.transpileModule(readFileSync(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
function panelHarness(initial = null, writable = true) {
  const writes = [], timers = [], updates = []
  const node = { id: 'a', kind: 'artist', name: 'Radiohead' }
  const graph = { nodes: new Map([['a', node]]), edges: new Map(), rootId: 'a', selectedNodeId: 'a', journey: [] }
  const mocks = {
    react: {
      useState: initial => [typeof initial === 'function' ? initial() : initial, next => updates.push(next)],
      useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), useEffect() {},
    },
    './taste': { ...t, readTaste: () => initial, writeTaste: next => { if (writable) writes.push(next); return writable } },
    './graph/mapSnapshot': { readMap: () => ({ status: 'none' }) },
    './graph/useMusicGraph': { useMusicGraph: () => ({ graph, nodes: [node], edges: [] }), planPrune: () => null },
    './graph/journey': { journeyContext: () => [] },
    './bookmarks': { readBookmarks: () => [], nodeBookmark: () => null },
    './exclusions': { readExclusions: () => [] },
    './components/ArtistPanel': { ArtistPanel: 'ArtistPanel' },
    './components/TasteToggle': { TasteToggle: 'TasteToggle' },
  }
  const exports = {}
  runInNewContext(appSource, {
    exports, require: name => name === 'react/jsx-runtime' ? require(name) : mocks[name] ?? {},
    window: { clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length } },
  })
  const elements = []
  const visit = element => {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(exports.default())
  const toggle = elements.find(el => el.type === 'ArtistPanel').props.tasteActions.props.onToggle
  return { toggle, writes, timers, updates, toast: () => updates.findLast(update => update?.msg) }
}

test('panel changes persist, announce seven-second Undo, and rapid toggles use the latest profile', () => {
  const app = panelHarness()
  app.toggle('liked_artists', 'Radiohead')
  assert.deepEqual(app.writes.at(-1).liked_artists, ['Radiohead'])
  assert.equal(app.toast().action.label, 'Undo')
  assert.equal(app.timers.at(-1).ms, 7000)
  const staleUndo = app.toast().action.run
  app.toggle('liked_tracks', 'Creep — Radiohead')
  staleUndo()
  assert.equal(app.writes.length, 2, 'older Undo cannot overwrite newer changes')
  app.toast().action.run()
  assert.deepEqual(app.writes.at(-1).liked_tracks, [])
  assert.deepEqual(app.writes.at(-1).liked_artists, ['Radiohead'])
  app.toggle('liked_artists', 'Radiohead')
  assert.equal(app.writes.at(-1), null)
  app.toast().action.run()
  assert.deepEqual(app.writes.at(-1).liked_artists, ['Radiohead'])
})

test('full list offers Edit taste without writes; blocked storage never announces success', () => {
  const full = { ...t.emptyTaste(), liked_artists: Array.from({ length: 15 }, (_, i) => `Artist ${i}`) }
  const app = panelHarness(full)
  app.toggle('liked_artists', 'Radiohead')
  assert.equal(app.writes.length, 0)
  assert.equal(app.toast().action.label, 'Edit taste')
  app.toast().action.run()
  assert.equal(app.updates.at(-1), true)
  const blocked = panelHarness(null, false)
  blocked.toggle('liked_artists', 'Radiohead')
  assert.equal(blocked.writes.length, 0)
  assert.match(blocked.toast().msg, /blocking local storage/)
  assert.equal(blocked.toast().action, undefined)
})

function componentTree(file, exportName, props) {
  const source = ts.transpileModule(readFileSync(new URL(`../frontend/src/components/${file}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  runInNewContext(source, {
    exports, require: name => name === 'react/jsx-runtime' ? require(name)
      : name === '../taste' ? t
        : name === 'react' ? { useState: initial => [initial, () => {}], useRef: current => ({ current }), useEffect() {} } : {},
  })
  const elements = []
  function visit(element) {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    if (typeof element.type === 'function') visit(element.type(element.props))
    else for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(exports[exportName](props))
  return elements
}
const text = element => [element.props?.children].flat(Infinity).filter(value => typeof value === 'string').join('')

test('toggle labels, stored hints, and click targets cover both modes and both lists', () => {
  for (const kind of ['artist', 'track']) {
    const node = { kind, name: 'Creep', artist: { name: 'Radiohead' } }
    const entry = t.tasteEntry(node)
    const list = kind === 'artist' ? 'liked_artists' : 'liked_tracks'
    for (const liked of [false, true]) for (const disliked of [false, true]) {
      const profile = { ...t.emptyTaste(), [list]: liked ? [entry.toUpperCase()] : [], disliked: disliked ? [entry] : [] }
      const calls = []
      const elements = componentTree('TasteToggle', 'TasteToggle', { node, profile, onToggle: (...args) => calls.push(args) })
      const buttons = elements.filter(el => el.type === 'button')
      assert.equal(text(buttons[0]), liked ? 'Remove from my taste' : 'Add to my taste')
      assert.equal(text(buttons[1]), disliked ? 'Remove from dislikes' : 'Not my taste')
      assert.equal(buttons[0].props['aria-pressed'], liked)
      assert.equal(buttons[1].props['aria-pressed'], disliked)
      buttons.forEach(button => button.props.onClick())
      assert.deepEqual(calls, [[list, entry], ['disliked', entry]])
      const hints = elements.filter(el => el.type === 'p').map(text)
      assert.equal(hints.length, Number(liked) + Number(disliked))
      if (liked) assert.ok(hints.some(hint => hint.includes(entry.toUpperCase())))
    }
  }
})

test('actions precede taste checking; dislike-only profiles show Add preferences for both modes', () => {
  for (const kind of ['artist', 'track']) for (const positive of [false, true]) {
    const profile = { ...t.emptyTaste(), disliked: ['Harsh'], liked_genres: positive ? ['Pop'] : [] }
    const actions = require('react/jsx-runtime').jsx('div', { id: 'taste-actions' })
    const elements = componentTree('TasteCheck', 'TasteCheck', { kind, itemId: 'id', profile, actions, onEdit() {} })
    const buttons = elements.filter(el => el.type === 'button').map(text)
    assert.deepEqual(buttons, positive ? ['Edit taste', 'Check my taste'] : ['Add preferences'])
    assert.ok(elements.indexOf(actions) < elements.findIndex(el => el.type === 'button'))
  }
})
