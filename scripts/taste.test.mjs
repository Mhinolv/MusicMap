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

test('cross-list toggles move case-insensitive matches and legacy Remove clears both lists', () => {
  for (const liked of ['liked_artists', 'liked_tracks']) {
    for (const [source, target] of [[liked, 'disliked'], ['disliked', liked]]) {
      const previous = { ...t.emptyTaste(), [source]: [' Entry ', 'ENTRY'], notes: 'Keep notes' }
      const snapshot = structuredClone(previous)
      const next = t.toggleTaste(previous, target, 'entry')
      assert.deepEqual(next[source], [], 'moving must remove all opposite-list matches')
      assert.deepEqual(next[target], ['entry'])
      assert.equal(next.notes, 'Keep notes')
      assert.deepEqual(previous, snapshot, 'Undo snapshot must remain exact')
      const legacy = { ...previous, [target]: ['entry'] }
      const removed = t.toggleTaste(legacy, target, 'ENTRY')
      assert.deepEqual(removed[source], [], 'legacy Remove clears the opposite list')
      assert.deepEqual(removed[target], [])
    }
    const legacyLast = { ...t.emptyTaste(), [liked]: ['entry'], disliked: ['ENTRY'] }
    assert.equal(t.toggleTaste(legacyLast, liked, 'entry'), null)
    assert.equal(t.toggleTaste(legacyLast, 'disliked', 'entry'), null)
  }
})

test('each list accepts item 50, blocks 51, and allows removal at capacity', () => {
  for (const list of ['liked_artists', 'liked_tracks', 'disliked']) {
    const almost = { ...t.emptyTaste(), [list]: Array.from({ length: 49 }, (_, i) => `Item ${i}`) }
    const full = t.toggleTaste(almost, list, 'Last')
    assert.equal(full[list].length, 50)
    assert.equal(t.toggleTaste(full, list, 'Overflow'), full)
    assert.equal(t.toggleTaste(full, list, 'LAST')[list].length, 49)
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
const startScreen = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../frontend/src/startScreen.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(startScreen)
const sheet = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../frontend/src/sheet.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(sheet)
function panelHarness(initial = null, writable = true) {
  const writes = [], timers = [], updates = [], syncs = []
  const node = { id: 'a', kind: 'artist', name: 'Radiohead' }
  const graph = { nodes: new Map([['a', node]]), edges: new Map(), rootId: 'a', selectedNodeId: 'a', journey: [] }
  const mocks = {
    react: {
      useState: initial => [typeof initial === 'function' ? initial() : initial, next => updates.push(next)],
      useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), useEffect() {},
    },
    './taste': { ...t, readTaste: () => initial, writeTaste: next => { if (writable) writes.push(next); return writable } },
    './graph/mapSnapshot': { readMap: () => ({ status: 'none' }) },
    './history': { readHistory: () => [], sessionMap: () => ({ status: 'none' }) },
    './graph/useMusicGraph': { useMusicGraph: () => ({ graph, nodes: [node], edges: [] }), planPrune: () => null },
    './graph/journey': { journeyContext: () => [] },
    './graph/onMap': { onMapRows: () => ({ count: 1, rows: [] }), journeyStops: () => [], matchFact: () => null, stopNumber: String },
    './bookmarks': { readBookmarks: () => [], nodeBookmark: () => null },
    './exclusions': { readExclusions: () => [] },
    './startScreen': startScreen,
    './sheet': sheet,
    './components/ArtistPanel': { ArtistPanel: 'ArtistPanel' },
    './components/TasteToggle': { TasteToggle: 'TasteToggle' },
    './useTasteSync': { useTasteSync: () => ({ status: 'synced', edited: () => syncs.push(writes.at(-1)) }) },
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
  return { toggle, writes, timers, updates, syncs, toast: () => updates.findLast(update => update?.msg) }
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
  const full = { ...t.emptyTaste(), liked_artists: Array.from({ length: 50 }, (_, i) => `Artist ${i}`) }
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

test('every saved panel change and Undo starts a sync; a blocked write or full list does not (#76)', () => {
  const app = panelHarness()
  app.toggle('liked_artists', 'Radiohead')
  app.toggle('disliked', 'Radiohead')
  app.toast().action.run()
  assert.deepEqual(app.syncs, app.writes, 'each local write is followed by one sync of that profile')
  assert.equal(app.syncs.length, 3)
  const full = panelHarness({ ...t.emptyTaste(), liked_artists: Array.from({ length: 50 }, (_, i) => `Artist ${i}`) })
  full.toggle('liked_artists', 'Radiohead')
  assert.equal(full.syncs.length, 0)
  const blocked = panelHarness(null, false)
  blocked.toggle('liked_artists', 'Radiohead')
  assert.equal(blocked.syncs.length, 0)
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
      assert.equal(text(buttons[0]), liked ? 'In my taste · Remove' : 'Add to my taste')
      assert.equal(text(buttons[1]), disliked ? 'Not my taste · Remove' : 'Not my taste')
      assert.equal(buttons[0].props['aria-pressed'], liked)
      assert.equal(buttons[1].props['aria-pressed'], disliked)
      buttons.forEach(button => button.props.onClick())
      assert.deepEqual(calls, [[list, entry], ['disliked', entry]])
      const hints = elements.filter(el => el.type === 'p').map(text)
      assert.deepEqual(hints, [
        ...(liked ? [`In ${kind === 'artist' ? 'liked bands' : 'liked songs'}: ${entry.toUpperCase()}`] : []),
        ...(disliked ? [`In dislikes: ${entry}`] : []),
      ])
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


test('moves name source and target lists and Undo restores exact cross-list and legacy profiles', () => {
  for (const liked of ['liked_artists', 'liked_tracks']) {
    for (const [source, target] of [[liked, 'disliked'], ['disliked', liked]]) {
      const previous = { ...t.emptyTaste(), [source]: [' RADIOHEAD '], notes: 'Keep' }
      const app = panelHarness(previous)
      app.toggle(target, 'Radiohead')
      const label = list => list === 'liked_artists' ? 'liked bands' : list === 'liked_tracks' ? 'liked songs' : 'dislikes'
      assert.equal(app.toast().msg, `Moved “Radiohead” from ${label(source)} to ${label(target)}.`)
      assert.equal(app.timers.at(-1).ms, 7000)
      app.toast().action.run()
      assert.deepEqual(app.writes.at(-1), previous)
      const legacy = { ...previous, [target]: ['Radiohead'] }
      const remove = panelHarness(legacy)
      remove.toggle(target, 'Radiohead')
      assert.equal(remove.writes.at(-1)[source].length, 0)
      remove.toast().action.run()
      assert.deepEqual(remove.writes.at(-1), legacy)
    }
  }
})

test('Added and Removed toasts name each exact list', () => {
  for (const [list, label, entry] of [
    ['liked_artists', 'liked bands', 'Radiohead'],
    ['liked_tracks', 'liked songs', 'Creep — Radiohead'],
    ['disliked', 'dislikes', 'Creep — Radiohead'],
  ]) {
    const app = panelHarness()
    app.toggle(list, entry)
    assert.equal(app.toast().msg, `Added “${entry}” to ${label}.`)
    app.toggle(list, entry)
    assert.equal(app.toast().msg, `Removed “${entry}” from ${label}.`)
  }
})

test('full destinations block moves atomically and name each list', () => {
  for (const liked of ['liked_artists', 'liked_tracks']) {
    for (const [source, target] of [[liked, 'disliked'], ['disliked', liked]]) {
      const previous = { ...t.emptyTaste(), [source]: ['Radiohead'], [target]: Array.from({ length: 50 }, (_, i) => `Item ${i}`) }
      assert.equal(t.toggleTaste(previous, target, 'Radiohead'), previous)
      const app = panelHarness(previous)
      app.toggle(target, 'Radiohead')
      assert.equal(app.writes.length, 0)
      const label = target === 'liked_artists' ? 'liked bands' : target === 'liked_tracks' ? 'liked songs' : 'dislikes'
      assert.equal(app.toast().msg, `Your ${label} list is full (50).`)
      assert.equal(app.toast().action.label, 'Edit taste')
    }
  }
})

test('Edit taste saves up to 50 entries in all four lists, including full-length lines', () => {
  for (const count of [0, 15, 49, 50, 51]) {
    const entries = Array.from({ length: count }, (_, i) => String(i).padEnd(120, 'x'))
    const profile = { liked_artists: entries, liked_tracks: entries, liked_genres: entries, disliked: entries, notes: 'Keep' }
    let saved
    const elements = componentTree('TastePreferences', 'TastePreferences', { profile, onSave: next => { saved = next } })
    for (const field of elements.filter(el => el.type === 'textarea' && el.props.maxLength !== 500)) {
      assert.ok(field.props.maxLength >= 50 * 120 + 49)
    }
    elements.find(el => el.type === 'form').props.onSubmit({ preventDefault() {} })
    for (const list of ['liked_artists', 'liked_tracks', 'liked_genres', 'disliked']) {
      assert.deepEqual(Array.from(saved[list]), entries.slice(0, 50))
    }
  }
})

test('dialog head text and Sign in link follow the account state (#76)', () => {
  const profile = t.emptyTaste()
  const head = elements => text(elements.find(el => el.type === 'p'))
  const signIn = elements => elements.find(el => el.type === 'button' && text(el) === 'Sign in')
  const clear = elements => elements.find(el => el.type === 'button' && text(el) === 'Clear profile')
  let opened = 0, cleared = 0
  const out = componentTree('TastePreferences', 'TastePreferences', { profile, signedIn: false, onSignIn: () => { opened++ }, onClear: () => { cleared++ } })
  assert.equal(head(out), 'One entry per line. Saved in this browser; sent to JEV only when you check a song or artist.')
  assert.match(text(out.find(el => el.props?.className === 'taste-dialog__account')), /^Sign in to use this profile on your other devices\. $/)
  signIn(out).props.onClick()
  assert.equal(opened, 1)
  clear(out).props.onClick()
  assert.equal(cleared, 1, 'signed out, Clear profile clears at once')
  // Sign-in turned off: no hint and no link.
  const off = componentTree('TastePreferences', 'TastePreferences', { profile, signedIn: false })
  assert.equal(signIn(off), undefined)
  const on = componentTree('TastePreferences', 'TastePreferences', { profile, signedIn: true, syncStatus: 'synced', onSignIn: () => {}, onClear: () => { cleared++ } })
  assert.equal(head(on), 'One entry per line. Synced to your account; sent to JEV only when you check a song or artist.')
  assert.equal(signIn(on), undefined)
  clear(on).props.onClick()
  assert.equal(cleared, 1, 'signed in, Clear profile asks first and does not clear')
})


test('Spotify requests top 15 while merging up to 50 without truncating existing taste', async () => {
  const source = ts.transpileModule(readFileSync(new URL('../frontend/src/spotifyImport.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  for (const count of [0, 40, 50]) {
    const exports = {}
    const calls = []
    runInNewContext(source, {
      exports, URL, URLSearchParams,
      require: name => name === './taste' ? t : { api: { spotifyConfig: async () => ({ client_id: 'test' }) } },
      window: { location: { pathname: '/spotify/callback', search: '?state=test&code=code', origin: 'https://test' }, history: { replaceState() {} } },
      sessionStorage: { getItem: () => JSON.stringify({ state: 'test', verifier: 'test' }), removeItem() {} },
      fetch: async url => {
        if (String(url).includes('/api/token')) return { ok: true, json: async () => ({ access_token: 'test' }) }
        calls.push(String(url))
        return { ok: true, json: async () => ({ items: Array.from({ length: 15 }, (_, i) => ({ name: `Imported ${i}`, artists: [{ name: 'Artist' }] })) }) }
      },
    })
    const existing = Array.from({ length: count }, (_, i) => `Saved ${i}`)
    const previous = { ...t.emptyTaste(), liked_artists: existing, liked_tracks: existing, liked_genres: ['Pop'], disliked: ['Harsh'], notes: 'Keep' }
    const next = await exports.finishSpotifyImport(previous)
    assert.equal(calls.length, 2)
    for (const url of calls) assert.equal(new URL(url).searchParams.get('limit'), '15')
    for (const list of ['liked_artists', 'liked_tracks']) {
      assert.equal(next[list].length, Math.min(50, count + 15))
      assert.deepEqual(Array.from(next[list].slice(0, count)), existing)
    }
    assert.deepEqual(next.liked_genres, previous.liked_genres)
    assert.deepEqual(next.disliked, previous.disliked)
    assert.equal(next.notes, previous.notes)
  }
})
