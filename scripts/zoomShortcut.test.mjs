import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'tunegraph-zoom-'))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(process.execPath, [join(root, 'frontend/node_modules/typescript/bin/tsc'),
  join(root, 'frontend/src/graph/zoomShortcut.ts'), '--outDir', output,
  '--target', 'es2023', '--module', 'esnext', '--skipLibCheck', '--strict'])
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const { zoomShortcut } = await import(pathToFileURL(join(output, 'zoomShortcut.js')).href)

test('zoom keys, reciprocal steps and every input/dialog/modifier guard combination', () => {
  for (const typing of [false, true]) for (const dialog of [false, true]) for (const modified of [false, true]) {
    for (const key of ['+', '=', '-', 'z', 'Escape', '', '−']) {
      const expected = typing || dialog || modified ? undefined :
        key === '+' || key === '=' ? 1.4 : key === '-' ? 1 / 1.4 : undefined
      assert.equal(zoomShortcut(key, typing, dialog, modified), expected)
    }
  }
  assert.equal(zoomShortcut('+', false, false, false) * zoomShortcut('-', false, false, false), 1)
})
