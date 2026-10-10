import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const source = readFileSync(new URL('../frontend/src/graph/constellation.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { generateStarField, starRadius, labelLines, placeLabels, journeyPath } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const point = (id, overrides = {}) => ({ id, name: id, x: 200, y: 100, core: 6, ring: 13, mainWidth: 100, subWidth: 110, selected: false, root: false, journey: false, ...overrides })

test('star field is deterministic, bounded, sparse on mobile and reusable faint', () => {
  assert.deepEqual(generateStarField(0, 0, false), [])
  assert.deepEqual(generateStarField(0, 0, false, true), [])
  for (const mobile of [false, true]) for (const [w, h] of [[1, 1], [390, 844], [1440, 852], [10000, 10000]]) {
    const dots = generateStarField(w, h, mobile)
    assert.deepEqual(dots, generateStarField(w, h, mobile))
    assert.ok(dots.length <= (mobile ? 35 : 127))
    assert.equal(dots.filter(s => s.soft).length, dots.length ? mobile ? 3 : 7 : 0)
    assert.ok(dots.every(s => s.x >= 0 && s.x < w && s.y >= 0 && s.y < h && [0.5, 1, 1.5].includes(s.r)))
    // Start screen: about 1 dot per 29,000px², at most 42 plus 4 soft stars, on any viewport.
    const faint = generateStarField(w, h, mobile, true)
    const plain = faint.filter(s => !s.soft).length
    assert.equal(plain, Math.min(42, Math.floor(w * h / 29000)))
    assert.equal(faint.length - plain, plain ? 4 : 0)
    assert.ok(faint.every(s => s.x >= 0 && s.x < w && s.y >= 0 && s.y < h))
    if (plain) assert.ok(plain <= dots.filter(s => !s.soft).length)
  }
  assert.ok(generateStarField(1440, 900, false).length > generateStarField(390, 844, true).length)
  // Same seed and positions; every dim graph dot stays dim and brighter tones shift toward --sky-1.
  const graph = generateStarField(10000, 10000, false), faint = generateStarField(10000, 10000, false, true)
  const rank = { '#3A3D44': 0, '#5A5E66': 1, '#8A8E96': 2 }
  for (let i = 0; i < 42; i++) {
    assert.equal(faint[i].x, graph[i].x)
    assert.ok(rank[faint[i].color] <= rank[graph[i].color])
  }
})

test('core sizes clamp match, retain tiers and give selection precedence', () => {
  assert.equal(starRadius(0.6, 1, 1, false, false), 5.5)
  assert.equal(starRadius(0.9, 1, 1, false, false), 6.5)
  for (const match of [-1, 0, 0.6, 0.9, 1, 10, undefined]) for (const degree of [0, 10000]) for (const tier of [1, 0.92, 0.72, 0.58]) {
    assert.ok(starRadius(match, degree, tier, false, false) >= 5.5 * tier)
    assert.ok(starRadius(match, degree, tier, false, false) <= 6.5 * tier)
    for (const stop of [false, true]) assert.equal(starRadius(match, degree, tier, true, stop), 8 * tier)
    assert.equal(starRadius(match, degree, tier, false, true), 6 * tier)
  }
})

test('labels handle artist/song, root, unknown match and mobile variants', () => {
  for (const mobile of [false, true]) for (const root of [false, true]) for (const artist of [undefined, 'Portishead']) for (const match of [undefined, 0, 0.82]) {
    const lines = labelLines('Glory Box', artist, match, root, mobile)
    assert.equal(lines.main, 'Glory Box')
    assert.equal(lines.sub, mobile ? artist ?? '' : [artist, root ? 'ROOT' : match == null ? '' : `${Math.round(match * 100)}%`].filter(Boolean).join(' · '))
  }
  assert.equal(labelLines('a'.repeat(100), undefined, undefined, false, false).main.length, 20)
  assert.equal(labelLines('a'.repeat(100), undefined, undefined, false, true).main.length, 15)
})

test('desktop tries right, left at edge, then below; keeps a valid previous side', () => {
  const right = placeLabels([point('a')], 600, 300, false)
  assert.equal(right.get('a').side, 'right')
  assert.equal(placeLabels([point('a', { x: 550 })], 600, 300, false).get('a').side, 'left')
  const below = placeLabels([point('a', { x: 100, mainWidth: 150, subWidth: 150 })], 200, 300, false)
  assert.equal(below.get('a').side, 'below')
  assert.equal(placeLabels([point('a')], 600, 300, false, new Map([['a', { ...right.get('a'), side: 'left' }]])).get('a').side, 'left')
})

test('collisions hide sub before label and give selected/root/journey priority', () => {
  const a = point('a', { x: 100, y: 90, mainWidth: 50, subWidth: 50 })
  // Right has space for one line; below hits the lower boundary; left hits a core.
  const blockers = [point('b', { x: 135, y: 110 }), point('c', { x: 55, y: 85 })]
  const single = placeLabels([{ ...a, selected: true }, ...blockers], 200, 122, false).get('a')
  assert.equal(single.sub, false)
  assert.equal(single.hidden, false)
  for (const priority of ['selected', 'root', 'journey']) {
    const result = placeLabels([point('z', { [priority]: true, x: 100 }), point('a', { match: 1, x: 100 })], 250, 120, false)
    assert.equal(result.get('z').hidden, false)
    assert.equal(result.get('a').hidden, true)
  }
  assert.equal(placeLabels([point('a')], 1, 1, false).get('a').hidden, true)
  assert.equal(placeLabels([], 0, 0, false).size, 0)
})

test('dense placement is deterministic and mobile only places below', () => {
  const nodes = Array.from({ length: 100 }, (_, i) => point(String(i), { x: 35 + i % 10 * 40, y: 35 + Math.floor(i / 10) * 35, match: i / 100 }))
  for (const mobile of [true, false]) {
    const first = placeLabels(nodes, 450, 400, mobile)
    assert.deepEqual(first, placeLabels([...nodes].reverse(), 450, 400, mobile))
    assert.ok([...first.values()].some(p => p.hidden))
    if (mobile) assert.ok([...first.values()].every(p => p.side === 'below'))
  }
})

test('journey follows stop order, handles empty/single and splits missing stops', () => {
  const positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 20 }], ['c', { x: 30, y: 5 }]])
  assert.equal(journeyPath([], positions), '')
  assert.equal(journeyPath(['a'], positions), '')
  assert.equal(journeyPath(['c', 'a', 'b'], positions), 'M30,5L0,0L10,20')
  assert.equal(journeyPath(['a', 'missing', 'b', 'c'], positions), 'M0,0M10,20L30,5')
})


test('equal-priority collisions rank by match then name', () => {
  const low = point('a', { x: 100, match: 0.6 })
  const high = point('z', { x: 100, match: 0.9 })
  const ranked = placeLabels([low, high], 250, 120, false)
  assert.equal(ranked.get('z').hidden, false)
  assert.equal(ranked.get('a').hidden, true)
  const tied = placeLabels([low, { ...high, match: 0.6 }], 250, 120, false)
  assert.equal(tied.get('a').hidden, false)
  assert.equal(tied.get('z').hidden, true)
})
