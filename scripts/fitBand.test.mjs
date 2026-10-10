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
    assert.deepEqual(f.bandFor({ outcome: 'fit', level }), { key, label, tone, pips })
  })
  assert.equal(f.FIT_PIPS, 5)
})

test('uncertainty outcomes sit outside the scale, with no pips or leaning band', () => {
  for (const level of [null, 0, 4]) {
    const insufficient = f.bandFor({ outcome: 'insufficient_evidence', level })
    assert.equal(insufficient.label, 'Not enough information')
    assert.equal(insufficient.pips, 0)
    const uncertain = f.bandFor({ outcome: 'uncertain', level })
    assert.equal(uncertain.label, 'Uncertain estimate')
    assert.equal(uncertain.pips, 0)
    assert.equal(uncertain.tone, 'uncertain')
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
    "The model's answer was split, so no fit is shown.")
  assert.equal(f.uncertainHint(f.bandFor({ outcome: 'fit', level: 0 }), 'track'), null)
})
