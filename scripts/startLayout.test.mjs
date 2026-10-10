import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8')

/** Flat list of { media, selectors, decls } for every style rule, in source order. */
function rules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const walk = (from, media) => {
    let i = from
    let start = from
    while (i < text.length) {
      const ch = text[i]
      if (ch === '}') return i + 1
      if (ch === '{') {
        const prelude = text.slice(start, i).trim()
        if (prelude.startsWith('@')) {
          // @keyframes blocks nest too; their media key never matches a lookup.
          i = walk(i + 1, prelude.startsWith('@media') ? prelude.slice(6).trim() : prelude)
        } else {
          const end = text.indexOf('}', i)
          const decls = {}
          for (const part of text.slice(i + 1, end).split(';')) {
            const colon = part.indexOf(':')
            if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
          }
          out.push({ media, selectors: prelude.split(',').map((s) => s.trim()), decls })
          i = end + 1
        }
        start = i
        continue
      }
      i++
    }
    return i
  }
  walk(0, '')
  return out
}

const all = rules(css)
/** The last value of `prop` among rules for `selector` in exactly `media` ('' = no media query). */
function finalValue(selector, prop, media = '') {
  let value
  for (const rule of all) {
    if (rule.media === media && rule.selectors.includes(selector) && prop in rule.decls) value = rule.decls[prop]
  }
  return value
}

test('start column is centred both ways below the header above 640px (#53)', () => {
  assert.equal(finalValue('.app--empty', 'display'), 'flex', 'start screen is a flex container')
  assert.equal(finalValue('.app--empty', 'flex-direction'), 'column')
  assert.equal(finalValue('.start-header', 'flex'), 'none', 'header keeps its 48px when the column overflows')
  assert.equal(finalValue('.start', 'margin'), 'auto', 'auto margins centre the column horizontally and vertically')
  assert.equal(finalValue('.start', 'flex'), 'none', 'column never shrinks, so short screens scroll')
  assert.equal(finalValue('.start', 'padding-block'), '40px', '40px minimum clearance above and below')
  assert.match(finalValue('.start', 'width'), /^min\(900px, 100% - 2 \* var\(--start-gutter\)\)$/)
  assert.equal(finalValue('.start', '--start-gutter'), 'clamp(24px, 5.5vw, 80px)')
  assert.ok(!all.some((r) => r.selectors.includes('.start') && /^\d/.test(r.decls['margin-top'] ?? '')),
    'no fixed top offset')
})

test('with the library open above 860px the column centres in the width left of the 380px drawer (#53)', () => {
  const width = finalValue('.start--library', 'width')
  assert.equal(width, 'var(--start-w)')
  assert.equal(finalValue('.start--library', '--start-w'), 'min(900px, 100% - 380px - 2 * var(--start-gutter))')
  assert.equal(finalValue('.start--library', 'margin-left'), 'calc((100% - 380px - var(--start-w)) / 2)',
    'equal space on both sides of the column within the area left of the drawer')
  // 641-860px: the drawer overlays the column, which centres in the full width again.
  assert.equal(finalValue('.start--library', '--start-w', '(max-width: 860px)'), 'min(900px, 100% - 2 * var(--start-gutter))')
  assert.equal(finalValue('.start--library', 'margin-left', '(max-width: 860px)'), 'auto')
})

test('phones (640px and below) keep the top-anchored column (#53 owner decision)', () => {
  const media = '(max-width: 640px)'
  for (const selector of ['.start', '.start--library']) {
    assert.equal(finalValue(selector, 'margin', media), '0 16px', `${selector} is not vertically centred on phones`)
    assert.equal(finalValue(selector, 'padding', media), '24px 0 32px')
    assert.equal(finalValue(selector, 'width', media), 'auto')
  }
})
