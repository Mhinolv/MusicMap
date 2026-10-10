// #58: connection rows stack the fit label under the song name at every width. CSS contract only; no browser.
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
/** Every media query (other than '') that sets `prop` on `selector`. */
const mediaSetting = (selector, prop) =>
  all.filter((r) => r.media && r.selectors.includes(selector) && prop in r.decls).map((r) => r.media)

const PHONE = '(max-width: 640px)'

test('desktop rows wrap so the fit label sits under the song name (#58)', () => {
  assert.equal(finalValue('.connections__row', 'flex-wrap'), 'wrap', '.connections__row wraps outside the media query')
  assert.equal(finalValue('.connections__row', 'min-height'), '32px', 'unlabelled rows stay a single 32px line')
  assert.equal(finalValue('.connections__row', 'padding'), '4px 0')
  assert.equal(finalValue('.connections__name', 'flex-basis'), 'calc(100% - 22px)', 'name takes line 1 after the counter')
  assert.notEqual(finalValue('.connections__name', 'min-width'), '38%', 'no 38% floor reserving a label column')
  assert.equal(finalValue('.connections__name', 'white-space'), 'nowrap', 'name stays one line with ellipsis')
  assert.equal(finalValue('.connections__name', 'text-overflow'), 'ellipsis')
})

test('the label is line 2, left-aligned under the name, and its band may wrap (#58)', () => {
  assert.equal(finalValue('.connections__label', 'margin-left'), '22px', '14px counter + 8px gap')
  assert.equal(finalValue('.connections__label', 'justify-content'), 'flex-start')
  assert.equal(finalValue('.connections__label', 'text-align'), 'left')
  assert.notEqual(finalValue('.connections__label .fit-band', 'flex-wrap'), 'nowrap',
    'Leaning: Conflicts with your dislikes + pips reflows to two lines instead of a squeezed column')
  assert.equal(finalValue('.connections__label .fit-band', 'justify-content'), 'flex-start')
  assert.equal(finalValue('.connections__label .fit-pips', 'flex'), 'none', 'pips stay together as a unit')
})

test('the phone sheet keeps its layout and only adds 44px rows (#58, #37)', () => {
  assert.equal(finalValue('.connections__row', 'min-height', PHONE), '44px')
  for (const [selector, prop] of [['.connections__row', 'flex-wrap'], ['.connections__name', 'flex-basis'],
    ['.connections__name', 'min-width'], ['.connections__label', 'margin-left'], ['.connections__label', 'justify-content'],
    ['.connections__label .fit-band', 'flex-wrap'], ['.connections__label .fit-band', 'justify-content']]) {
    assert.deepEqual(mediaSetting(selector, prop), [], `${selector} ${prop} comes from the shared base rule only`)
  }
})

test('the connection-row rules leave the Check my taste card alone (#58)', () => {
  assert.equal(finalValue('.fit-band', 'flex-wrap'), 'wrap')
  assert.equal(finalValue('.fit-band', 'display'), 'flex')
  assert.equal(finalValue('.fit-band', 'justify-content'), undefined, 'no unscoped alignment override')
})
