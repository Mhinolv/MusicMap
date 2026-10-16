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

test('intro copy sits on a --bg knockout in Studio Sky text tokens, smaller on phones (#62)', () => {
  assert.equal(finalValue('.start-intro', 'display'), 'flex')
  assert.equal(finalValue('.start-intro', 'flex-direction'), 'column')
  assert.equal(finalValue('.start-intro', 'align-items'), 'flex-start', 'knockout hugs the text instead of the full column')
  for (const selector of ['.start-intro__title', '.start-intro__text']) {
    assert.equal(finalValue(selector, 'margin'), '0')
    assert.equal(finalValue(selector, 'background'), 'var(--bg)', `${selector} never sits directly on contour lines`)
    assert.equal(finalValue(selector, 'box-shadow'), '0 0 0 6px var(--bg)')
  }
  assert.equal(finalValue('.start-intro__title', 'color'), 'var(--text)')
  assert.equal(finalValue('.start-intro__title', 'text-transform'), 'uppercase')
  assert.equal(finalValue('.start-intro__title', 'font'), '700 34px/1.05 var(--font-label)')
  assert.equal(finalValue('.start-intro__text', 'color'), 'var(--muted)')
  assert.equal(finalValue('.start-intro__text', 'max-width'), '64ch')
  const media = '(max-width: 640px)'
  assert.equal(finalValue('.start-intro__title', 'font-size', media), '24px')
  assert.equal(finalValue('.start-intro__text', 'font-size', media), '12px')
  assert.equal(finalValue('.start-intro', 'margin-bottom', media), '-8px')
  assert.ok(!all.some((r) => r.selectors.some((s) => s.startsWith('.start-intro')) && /amber|cyan|sky/.test(Object.values(r.decls).join(' '))),
    'no amber, cyan or sky accents')
})

test('phones (640px and below) keep the top-anchored column (#53 owner decision)', () => {
  const media = '(max-width: 640px)'
  for (const selector of ['.start', '.start--library']) {
    assert.equal(finalValue(selector, 'margin', media), '0 16px', `${selector} is not vertically centred on phones`)
    assert.equal(finalValue(selector, 'padding', media), '24px 0 32px')
    assert.equal(finalValue(selector, 'width', media), 'auto')
  }
})

test('phone toasts on the start screen and in the Library drawer span the width at the bottom (#85)', () => {
  const media = '(max-width: 640px)'
  assert.equal(finalValue('.toast', 'left', media), '12px', 'toast uses 12px insets, not a centred half width')
  assert.equal(finalValue('.toast', 'right', media), '12px')
  assert.equal(finalValue('.toast', 'transform', media), 'none', 'no translateX(-50%) shrink-to-fit')
  assert.equal(finalValue('.toast', 'max-width', media), 'none')
  assert.equal(finalValue('.toast', 'top', media), 'auto')
  assert.equal(finalValue('.toast', 'bottom', media), 'calc(12px + env(safe-area-inset-bottom))', 'bottom, clear of the title and drawer tabs')
  assert.equal(finalValue('.toast', 'justify-content', media), 'space-between', 'text left, Undo right')
  assert.equal(finalValue('.app--empty .toast', 'top', media), undefined, 'the start-screen top pin is gone')
  // Desktop placement stays centred at the bottom.
  assert.equal(finalValue('.toast', 'left'), '50%')
  assert.equal(finalValue('.toast', 'transform'), 'translateX(-50%)')
  assert.equal(finalValue('.toast', 'bottom'), '20px')
  assert.equal(finalValue('.toast', 'z-index'), '40')
})

test('phone start screen keeps the word mark, a 280px account popover and a denser column (#87)', () => {
  const media = '(max-width: 640px)'
  // Account popover: the desktop 280px shape under its button, not a full-width sheet over the intro.
  for (const prop of ['left', 'right', 'width', 'border-width']) {
    assert.equal(finalValue('.account-menu', prop, media), undefined, `no phone override of .account-menu ${prop}`)
  }
  assert.equal(finalValue('.account-menu', 'width'), '280px')
  assert.equal(finalValue('.account-menu', 'max-width'), 'calc(100vw - 24px)', 'never wider than the phone')
  // With the popover open, the start column moves below it, so the intro title shows in full (QA attempt 1).
  assert.equal(finalValue('.app--empty:has(> #account-menu) .start', 'padding-top', media), 'calc(var(--account-menu-h, 0px) + 20px)')
  assert.equal(finalValue('.app--empty:has(> #account-menu) .start', 'padding-top'), undefined, 'desktop keeps its layout')
  const menu = readFileSync(new URL('../frontend/src/components/AccountMenu.tsx', import.meta.url), 'utf8')
  assert.match(menu, /host\.style\.setProperty\('--account-menu-h'/, 'the popover publishes its height on its host')
  assert.match(menu, /host\.style\.removeProperty\('--account-menu-h'\)/, 'the height clears when the popover closes')
  // Header: icon Library and account buttons, so the word mark always shows.
  assert.ok(!all.some((r) => r.media === media && r.selectors.some((s) => s.includes('.start-header__name')) && r.decls.display === 'none'),
    'the word mark never hides on phones')
  assert.equal(finalValue('.start-header .start-header__icon', 'width', media), '44px')
  assert.equal(finalValue('.start-header .start-header__icon', 'height', media), '44px')
  const screen = readFileSync(new URL('../frontend/src/components/StartScreen.tsx', import.meta.url), 'utf8')
  assert.match(screen, /<LibraryButton icon=\{narrow\}/, 'phone start header uses the Library icon, as in the map header')
  const app = readFileSync(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /account=\{accountEntry\(narrow \? \{ icon: true/, 'phone start header uses the account icon')
  // Denser column: 16px gaps and a 100x60 thumbnail beside the resume title.
  assert.equal(finalValue('.start', 'gap', media), '16px')
  assert.equal(finalValue('.resume', 'flex-direction', media), 'row')
  assert.equal(finalValue('.resume', 'gap', media), '16px')
  assert.equal(finalValue('.resume__map', 'width', media), '100px')
  assert.equal(finalValue('.resume__map', 'height', media), '60px')
  assert.equal(finalValue('.resume__actions', 'flex-basis', media), '100%', 'actions take their own row below')
  assert.equal(finalValue('.resume__facts', 'grid-template-columns', media), 'repeat(2, minmax(0, 1fr))', 'facts fit beside the thumbnail')
})
