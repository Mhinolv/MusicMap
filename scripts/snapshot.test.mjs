import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const decoderSource = readFileSync(new URL('../frontend/src/graph/mapSnapshot.ts', import.meta.url), 'utf8')
const decoderJs = ts.transpileModule(decoderSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { decodeMap } = await import(`data:text/javascript;base64,${Buffer.from(decoderJs).toString('base64')}`)

// Load only the scenario definitions: no Puppeteer import or browser launch.
const source = readFileSync(new URL('./snapshot.mjs', import.meta.url), 'utf8')
const scenarios = runInNewContext(
  `${source.slice(source.indexOf('const scenarios = ['), source.indexOf('// ---- runner'))}\nscenarios`,
  {
    DESKTOP: { width: 1440, height: 900, deviceScaleFactor: 1 }, MOBILE: {}, MOBILE_UA: '',
    artistGraph: async () => {},
    search: async () => {}, waitForNodes: async () => {},
    waitForPanel: async () => {}, waitForSettle: async () => {},
  },
)

for (const name of ['song-journey-on', 'mobile-song-journey-on']) {
  test(`${name} selects an SVG leaf and reaches the journey hint`, async () => {
    let focused = false
    let selected = false
    let enabled = false
    let hintChecked = false
    let opacityChecked = false
    // SVG elements support DOM focus, but Puppeteer's ElementHandle.focus()
    // rejects them because they are not HTMLElements.
    const svg = { focus() { focused = true } }
    const leaf = { async focus() { throw new Error('Cannot focus non-HTMLElement') } }
    const page = {
      async waitForSelector() {},
      async click(selector) {
        assert.equal(selector, '.journey__follow')
        enabled = true
      },
      async $(selector) {
        assert.equal(selector, 'g.node:not(.is-root)')
        return leaf
      },
      async evaluate(callback, handle) {
        assert.equal(handle, leaf)
        callback(svg)
      },
      keyboard: {
        async press(key) {
          assert.equal(key, 'Enter')
          assert.ok(focused, 'SVG leaf must receive DOM focus before Enter')
          selected = true
        },
      },
      async waitForFunction(callback) {
        assert.ok(enabled && selected)
        const result = runInNewContext(`(${callback.toString()})()`, {
          document: {
            querySelectorAll(selector) {
              assert.equal(selector, '.panel__hint')
              hintChecked = true
              return [{ textContent: 'Next expansion follows your 2-stop journey.' }]
            },
            querySelector(selector) {
              assert.equal(selector, '.journey')
              opacityChecked = true
              return {}
            },
          },
          getComputedStyle: () => ({ opacity: '1' }),
        })
        assert.equal(result, true)
      },
    }
    assert.equal(await scenarios.find((scenario) => scenario.name === name).run(page),
      'Follow journey on, full-opacity trail and next-expansion hint')
    assert.ok(hintChecked && opacityChecked)
  })

  test(`${name} reports a missing leaf`, async () => {
    const page = {
      async waitForSelector() {}, async click() {}, async $() { return null },
    }
    await assert.rejects(scenarios.find((scenario) => scenario.name === name).run(page),
      { message: 'no song leaf' })
  })
}

// Native touch emulation must trigger coarse pointer independently of narrow width.
test('constellation coarse pointer uses a touch-enabled desktop viewport', () => {
  const scenario = scenarios.find(s => s.name === 'constellation-coarse-pointer')
  assert.equal(scenario.viewport.hasTouch, true, 'coarse-pointer capture needs native touch emulation')
  assert.equal(scenario.viewport.isMobile, true)
  assert.ok(scenario.viewport.width > 640, 'coarse-pointer capture must not rely on narrow width')
  assert.ok(!scenario.extraMedia?.some(feature => feature.name === 'pointer'))
})

test('dense constellation survives pagehide persistence and restores all stops', async () => {
  const original = JSON.stringify({ version: 1, rootId: 'root', focusId: 'root',
    selectedNodeId: 'root', journey: ['root'], nodes: [
      { id: 'root', name: 'Radiohead', kind: 'artist', expanded: true },
      { id: 'leaf', name: 'Portishead', kind: 'artist', parentId: 'root' },
    ], edges: [{ id: 'root::leaf', source: 'root', target: 'leaf' }] })
  const storage = new Map([['tunegraph:map:v1', original]])
  const localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value) }
  const init = []
  const execute = (callback, ...args) => runInNewContext(`(${callback.toString()})(...args)`, { localStorage, args })
  let resumed
  let journeyChecked = false
  const page = {
    async evaluate(callback, ...args) { return execute(callback, ...args) },
    async evaluateOnNewDocument(callback, ...args) { init.push(() => execute(callback, ...args)) },
    async reload() {
      // App's pagehide listener flushes the live graph before the new document runs.
      localStorage.setItem('tunegraph:map:v1', original)
      for (const callback of init) callback()
    },
    async waitForSelector() {},
    async click(selector) {
      if (selector === '.resume-card .btn--primary') {
        resumed = JSON.parse(localStorage.getItem('tunegraph:map:v1'))
        assert.equal(resumed.nodes.length, 37, 'pagehide must not overwrite the dense fixture')
        const decoded = decodeMap(JSON.stringify(resumed))
        assert.equal(decoded.status, 'ready', 'fixture must pass the actual resume decoder')
        assert.equal(decoded.snapshot.graph.nodes.size, 37)
        assert.equal(decoded.snapshot.graph.selectedNodeId, 'dense-1')
        assert.deepEqual(decoded.snapshot.graph.journey, ['root', 'dense-0', 'dense-1'])
        assert.equal(resumed.selectedNodeId, 'dense-1')
        assert.deepEqual(resumed.journey, ['root', 'dense-0', 'dense-1'])
        assert.equal(new Set(resumed.nodes.map(n => n.id)).size, 37)
        assert.ok(resumed.edges.every(e => resumed.nodes.some(n => n.id === e.source)
          && resumed.nodes.some(n => n.id === e.target)))
      }
    },
    async waitForFunction(callback) {
      if (callback.toString().includes('localStorage')) assert.equal(execute(callback), true)
      else {
        const result = runInNewContext(`(${callback.toString()})()`, {
          document: { querySelector(selector) {
            assert.equal(selector, '.journey-path')
            journeyChecked = true
            return { getAttribute: () => 'M0,0L10,10L20,20' }
          } },
        })
        assert.equal(result, true)
      }
    },
  }
  await scenarios.find(s => s.name === 'constellation-dense').run(page)
  assert.ok(resumed && journeyChecked)
})

for (const [coarse, narrow] of [[false, false], [false, true], [true, true], [true, false]]) {
  test(`coarse capture verifies actual media: coarse=${coarse}, narrow=${narrow}`, async () => {
    let glowChecked = false
    const page = {
      async evaluate(callback) {
        return runInNewContext(`(${callback.toString()})()`, {
          window: { matchMedia: query => ({ matches: query === '(pointer: coarse)' ? coarse : narrow }) },
        })
      },
      async waitForSelector(selector) { assert.equal(selector, '.graph.reduced-glow') },
      async waitForFunction(callback) {
        assert.equal(runInNewContext(`(${callback.toString()})()`, {
          document: { querySelector: () => null, querySelectorAll: () => [{}] },
          getComputedStyle: () => ({ display: 'none' }),
        }), true)
        glowChecked = true
      },
    }
    const run = scenarios.find(s => s.name === 'constellation-coarse-pointer').run(page)
    if (coarse && !narrow) {
      await run
      assert.ok(glowChecked)
    } else {
      await assert.rejects(run, { message: 'coarse-pointer scenario requires native coarse pointer at desktop width' })
      assert.equal(glowChecked, false)
    }
  })
}
