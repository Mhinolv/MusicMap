import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8')

test('hover preserves the saved state colour (#21)', () => {
  const hoverRules = [...css.matchAll(/\.icon-btn:hover\s*\{([^}]+)\}/g)]
  assert.ok(hoverRules.length, 'icon hover has a background affordance')
  for (const [, declarations] of hoverRules) {
    assert.doesNotMatch(declarations, /(?:^|;)\s*color\s*:/,
      'icon hover must not override the saved state colour')
    assert.match(declarations, /background\s*:/)
  }
  // #32 retired the bookmark icon for a SAVE / SAVED text toggle with the same rule.
  assert.match(css, /\.save-toggle\[aria-pressed="true"\]\s*\{\s*color:\s*var\(--amber\);\s*border-color:\s*var\(--amber\)/)
  const saveHover = [...css.matchAll(/(?:^|\})\s*([^{}]*:hover[^{}]*)\{([^}]+)\}/g)]
    .filter(([, selector]) => /^\.btn:hover$|\.panel__save|\.save-toggle/.test(selector.trim()))
  assert.ok(saveHover.length >= 2, 'base and inspector hover rules found')
  for (const [, selector, declarations] of saveHover) {
    assert.doesNotMatch(declarations, /(?:^|;)\s*(?:color|border-color)\s*:/, `${selector.trim()} must not override the saved amber`)
  }
})

test('search box focus shows no highlight while other controls keep their ring (#33)', () => {
  const ring = css.match(/([^{}]*):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--cyan\)/)
  assert.ok(ring, 'global focus ring still exists')
  assert.match(ring[1], /\bbutton\b/, 'buttons keep the ring')
  assert.match(ring[1], /\[tabindex\]/, 'ARTIST/SONG switch and other controls keep the ring')
  assert.match(ring[1], /:not\([^)]*\.search__field input[^)]*\)/, 'search input is excluded from the ring')
  assert.doesNotMatch(css, /\.search__field:focus-within/, 'search group border does not change on focus')
  assert.doesNotMatch(css, /\.search__field input:focus(?:-visible)?\s*\{[^}]*(?:outline|border|box-shadow)\s*:\s*(?!none|0)/)
  // Excluding the input from the cyan ring is not enough: without this the browser default ring draws.
  assert.match(css, /(?:^|\})\s*\.search__field input\s*\{[^}]*\boutline:\s*none\b/, 'search input suppresses the browser default focus ring')
})

test('steer input focus shows only the cursor and the field keeps its width (#38)', () => {
  const ring = css.match(/([^{}]*):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--cyan\)/)
  assert.match(ring[1], /:not\([^)]*\.steer-words__field input[^)]*\)/, 'steer input is excluded from the ring')
  assert.doesNotMatch(css, /\.steer-words__field:focus-within/, 'steer field border does not change on focus')
  assert.match(css, /(?:^|\})\s*\.steer-words__field input\s*\{[^}]*\boutline:\s*none\b/, 'steer input suppresses the browser default focus ring')
  // .btn--ghost grows by default, which squeezed the field and scrolled typed text off the left.
  assert.match(css, /\.steer-words__form \.btn\s*\{[^}]*\bflex:\s*none\b/, 'Interpret button does not take half the row')
})

test('the steering instruction sits clear of the chips above it (#38 owner decision)', () => {
  const panel = readFileSync(new URL('../frontend/src/components/ArtistPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /className="panel__hint steer-hint">Pick up to 3/)
  const gap = css.match(/\.panel__hint\.steer-hint\s*\{[^}]*margin-top:\s*(\d+)px/)
  assert.ok(gap && Number(gap[1]) >= 6, 'gap at least the 6px chip-row gap')
})
