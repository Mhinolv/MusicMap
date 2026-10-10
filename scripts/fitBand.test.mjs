// Pure fit-band vocabulary tests (#36); no browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-fitband-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/fitBand.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const f = await import(pathToFileURL(join(output, 'fitBand.js')).href)

test('five Score levels map to named bands with 1-5 pips and design tones', () => {
  const expected = [
    ['conflict', 'Conflicts with your dislikes', 'conflict', 1],
    ['unlikely', 'Unlikely fit', 'dim', 2],
    ['mixed', 'Mixed signals', 'text', 3],
    ['likely', 'Likely fit', 'accent', 4],
    ['strong', 'Strong fit', 'accent', 5],
  ]
  expected.forEach(([key, label, tone, pips], level) => {
    assert.deepEqual(f.bandFor({ outcome: 'fit', level }), { key, label, tone, pips, tentative: false })
  })
  assert.equal(f.FIT_PIPS, 5)
})

test('not enough information never shows pips or a leaning band, whatever the level (#36)', () => {
  for (const level of [null, 0, 2, 4, Number.NaN]) {
    assert.deepEqual(f.bandFor({ outcome: 'insufficient_evidence', level }),
      { key: 'insufficient', label: 'Not enough information', tone: 'uncertain', pips: 0, tentative: false })
  }
})

test('uncertain estimates show the leaning band as tentative, always in the uncertain tone (#51)', () => {
  const expected = [
    ['conflict', 'Conflicts with your dislikes', 1],
    ['unlikely', 'Unlikely fit', 2],
    ['mixed', 'Mixed signals', 3],
    ['likely', 'Likely fit', 4],
    ['strong', 'Strong fit', 5],
  ]
  expected.forEach(([key, label, pips], level) => {
    assert.deepEqual(f.bandFor({ outcome: 'uncertain', level }), { key, label, tone: 'uncertain', pips, tentative: true })
  })
  // Same clamping and rounding as fit; a tentative Strong is never the accent tone.
  assert.equal(f.bandFor({ outcome: 'uncertain', level: 9 }).key, 'strong')
  assert.equal(f.bandFor({ outcome: 'uncertain', level: -1 }).key, 'conflict')
  assert.equal(f.bandFor({ outcome: 'uncertain', level: 2.6 }).key, 'likely')
  assert.notEqual(f.bandFor({ outcome: 'uncertain', level: 4 }).tone, 'accent')
})

test('an uncertain estimate without a finite level falls back to zero pips', () => {
  for (const level of [null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.deepEqual(f.bandFor({ outcome: 'uncertain', level }),
      { key: 'uncertain', label: 'Uncertain estimate', tone: 'uncertain', pips: 0, tentative: false })
  }
})

test('malformed fit levels are clamped or treated as uncertain, never a percent', () => {
  assert.equal(f.bandFor({ outcome: 'fit', level: 7 }).key, 'strong')
  assert.equal(f.bandFor({ outcome: 'fit', level: -2 }).key, 'conflict')
  assert.equal(f.bandFor({ outcome: 'fit', level: 2.6 }).key, 'likely')
  assert.equal(f.bandFor({ outcome: 'fit', level: null }).key, 'uncertain')
  assert.equal(f.bandFor({ outcome: 'fit', level: Number.NaN }).key, 'uncertain')
  assert.equal(f.bandFor({ outcome: 'surprise', level: 3 }).key, 'uncertain')
  for (let level = 0; level <= 4; level++) assert.doesNotMatch(f.bandFor({ outcome: 'fit', level }).label, /%/)
})

test('uncertain hints name the item kind and only exist for uncertainty states', () => {
  const insufficient = f.bandFor({ outcome: 'insufficient_evidence', level: null })
  assert.equal(f.uncertainHint(insufficient, 'track'),
    "Your preferences and this song's tags don't overlap enough to judge. Adding genres you like helps.")
  assert.match(f.uncertainHint(insufficient, 'artist'), /this artist's tags/)
  assert.equal(f.uncertainHint(f.bandFor({ outcome: 'uncertain', level: null }), 'track'),
    "The model's answer was split, so no fit could be estimated.")
  for (let level = 0; level <= 4; level++) {
    for (const kind of ['track', 'artist']) {
      const hint = f.uncertainHint(f.bandFor({ outcome: 'uncertain', level }), kind)
      assert.equal(hint, "The model's answer was split, so this is a tentative lean, not a firm fit.")
      assert.doesNotMatch(hint, /\d|%/, 'no confidence or score is ever shown')
    }
    assert.equal(f.uncertainHint(f.bandFor({ outcome: 'fit', level }), 'track'), null)
  }
})
