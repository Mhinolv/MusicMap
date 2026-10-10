// Verify the request contract without a browser or GUI.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-steering-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/api.ts'), '--outDir', output, '--target', 'es2023',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--strict'], { cwd: root })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const { api } = await import(pathToFileURL(join(output, 'api.js')).href)
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })

for (const emphasized of [undefined, [], ['dream pop'], ['dream pop', 'R&B', '90s / pop']]) {
  test(`song request round-trips ${emphasized?.length ?? 0} emphasized tags with other controls`, async () => {
    let url
    globalThis.fetch = async (path) => {
      url = new URL(path, 'http://test')
      return { ok: true, json: async () => ({ tracks: [], ranking: { steering_matched: true } }) }
    }
    const result = await api.trackSimilar('tr:a|song', 7, undefined, ['seed', 'old'], ['excluded'], emphasized)
    assert.deepEqual(url.searchParams.getAll('emphasized_tags'), emphasized ?? [])
    assert.deepEqual(url.searchParams.getAll('trail'), ['seed', 'old'])
    assert.deepEqual(url.searchParams.getAll('excluded'), ['excluded'])
    assert.equal(url.searchParams.get('limit'), '7')
    assert.equal(result.ranking.steering_matched, true)
  })
}

test('a subsequent request without emphasis sends none; artist contract stays unchanged', async () => {
  const paths = []
  globalThis.fetch = async (path) => {
    paths.push(path)
    return { ok: true, json: async () => ({ artists: [], tracks: [] }) }
  }
  await api.trackSimilar('song', 7, undefined, undefined, undefined, ['rock'])
  await api.trackSimilar('song')
  await api.similar('artist')
  assert.equal(new URL(paths[1], 'http://test').searchParams.has('emphasized_tags'), false)
  assert.equal(paths[2], '/api/artists/artist/similar?limit=7')
})
