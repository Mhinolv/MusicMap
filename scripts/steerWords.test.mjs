// Plain-word steering (#38) helpers and request contract; no browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-steer-words-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/steerWords.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
for (const file of ['steerWords.js', 'tasteError.js']) {
  const emitted = join(output, file)
  writeFileSync(emitted, readFileSync(emitted, 'utf8').replace("'./api'", "'./api.js'").replace("'./tasteError'", "'./tasteError.js'"))
}
const s = await import(pathToFileURL(join(output, 'steerWords.js')).href)
const { api, ApiError } = await import(pathToFileURL(join(output, 'api.js')).href)
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })

const TAGS = ['trip-hop', 'downtempo', '90s', 'electronic']
const reply = (outcome, tags = [], avoid = false) => ({ version: 1, outcome, tags, avoid_ignored: avoid, rubric_version: 'steer-tags-v1', simulated: true })

test('the request posts the text and the twelve-tag allowlist once', async () => {
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init })
    return { ok: true, json: async () => reply('proposed', ['trip-hop']) }
  }
  const tags = Array.from({ length: 15 }, (_, i) => `tag ${i}`)
  const result = await api.tasteSteer('tr:portishead|glory box', 'darker', s.steerAllowlist(tags))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/taste/steer-tags')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { item_id: 'tr:portishead|glory box', text: 'darker', tags: tags.slice(0, 12) })
  assert.deepEqual(result.tags, ['trip-hop'])
})

test('allowlist keeps short tag lists whole and in order', () => {
  assert.deepEqual(s.steerAllowlist([]), [])
  assert.deepEqual(s.steerAllowlist(TAGS), TAGS)
  assert.equal(s.steerAllowlist(Array.from({ length: 12 }, (_, i) => i)).length, 12)
})

test('proposed chips are only the song\'s own tags, at most three', () => {
  assert.deepEqual(s.proposedChips(reply('proposed', ['trip-hop', 'downtempo']), TAGS), ['trip-hop', 'downtempo'])
  assert.deepEqual(s.proposedChips(reply('proposed', ['trip-hop', 'dark ambient']), TAGS), ['trip-hop'], 'never an invented tag')
  assert.deepEqual(s.proposedChips(reply('proposed', TAGS), TAGS), TAGS.slice(0, 3))
  assert.deepEqual(s.proposedChips(reply('no_match', ['trip-hop']), TAGS), [], 'only proposed outcomes give chips')
  assert.deepEqual(s.proposedChips(reply('low_confidence'), TAGS), [])
})

test('every outcome explains what was and was not applied', () => {
  assert.deepEqual(s.steerNotices(reply('proposed', ['trip-hop']), TAGS), [], 'positive')
  assert.deepEqual(s.steerNotices(reply('proposed', ['trip-hop'], true), TAGS), [s.AVOID_NOTICE], 'mixed')
  assert.deepEqual(s.steerNotices(reply('no_match', [], true), TAGS), [s.AVOID_NOTICE], 'negated')
  assert.deepEqual(s.steerNotices(reply('no_match'), TAGS), [s.NO_MATCH_NOTICE], 'unsupported')
  assert.deepEqual(s.steerNotices(reply('low_confidence'), TAGS), [s.LOW_CONFIDENCE_NOTICE], 'ambiguous')
  assert.deepEqual(s.steerNotices(reply('low_confidence', [], true), TAGS), [s.AVOID_NOTICE, s.LOW_CONFIDENCE_NOTICE])
  assert.deepEqual(s.steerNotices(reply('proposed', ['dark ambient']), TAGS), [s.NO_MATCH_NOTICE], 'all chips dropped')
  assert.equal(s.AVOID_NOTICE, "Steering away from a sound isn't supported yet, so that part was left out.")
})

test('errors: 503 has its own copy, busy/timeout/unreadable reuse #36', () => {
  assert.equal(s.steerErrorMessage(new ApiError('no key', 503)), 'Plain-word steering is not configured on this server.')
  assert.equal(s.steerErrorMessage(new ApiError('rate', 429)), 'JEV is busy. Try again shortly.')
  assert.equal(s.steerErrorMessage(new ApiError('timed out', 504)), 'JEV took too long to answer. Try again.')
  assert.equal(s.steerErrorMessage(new ApiError('invalid response', 502)), "JEV sent an answer we couldn't read. Try again.")
  for (const err of [new ApiError('bad', 422), new ApiError('Network error', 0), new Error('x')]) {
    assert.equal(s.steerErrorMessage(err), "Couldn't interpret that right now. Please retry.")
  }
})

/** SteerWords' first frame (hooks stubbed to their initial values). */
function render(props) {
  const source = ts.transpileModule(readFileSync(new URL('../frontend/src/components/SteerWords.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  runInNewContext(source, {
    exports, require: (name) => name === 'react/jsx-runtime' ? require(name)
      : name === 'react' ? { useState: (initial) => [initial, () => {}], useRef: (current) => ({ current }), useEffect() {} }
        : name === '../steerWords' ? s : {},
  })
  const elements = []
  const visit = (element) => {
    if (!element || typeof element !== 'object') return
    elements.push(element)
    for (const child of [element.props?.children].flat(Infinity)) visit(child)
  }
  visit(exports.SteerWords(props))
  return elements
}

test('the empty form is labelled, bounded and cannot submit', () => {
  const elements = render({ itemId: 'x', tags: TAGS, onApply() {} })
  const input = elements.find((el) => el.type === 'input')
  assert.equal(input.props['aria-label'], 'Describe the direction for the next expansion')
  assert.equal(input.props.maxLength, 200)
  assert.equal(input.props.readOnly, false)
  const submit = elements.find((el) => el.type === 'button' && el.props.type === 'submit')
  assert.equal(submit.props.children, 'Interpret')
  assert.equal(submit.props.disabled, true, 'empty field')
  assert.ok(elements.some((el) => el.props?.children === "Picks from this song's tags only."))
  assert.ok(elements.some((el) => el.type === 'form'))
  assert.ok(!elements.some((el) => el.props?.className === 'steer-words__count'), 'no counter under 160 characters')
})
