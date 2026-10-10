import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// Load only the scenario definitions: no Puppeteer import or browser launch.
const source = readFileSync(new URL('./snapshot.mjs', import.meta.url), 'utf8')
const scenarios = runInNewContext(
  `${source.slice(source.indexOf('const scenarios = ['), source.indexOf('// ---- runner'))}\nscenarios`,
  {
    DESKTOP: {}, MOBILE: {}, MOBILE_UA: '',
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
