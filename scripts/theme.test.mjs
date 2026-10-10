import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../frontend/src/index.css', import.meta.url), 'utf8')

test('icon hover preserves the saved state colour (#21)', () => {
  const hoverRules = [...css.matchAll(/\.icon-btn:hover\s*\{([^}]+)\}/g)]
  assert.ok(hoverRules.length, 'icon hover has a background affordance')
  for (const [, declarations] of hoverRules) {
    assert.doesNotMatch(declarations, /(?:^|;)\s*color\s*:/,
      'icon hover must not override the saved state colour')
    assert.match(declarations, /background\s*:/)
  }
  assert.match(css, /\.bookmark-toggle\.is-saved\s*\{\s*color:\s*var\(--(?:accent|amber)\)/)
})
