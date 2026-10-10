// Offscreen UI snapshot helper for TuneGraph. Run by scripts/snapshot.sh, which starts
// the mock backend and the Vite dev server first.
//
// Usage: node scripts/snapshot.mjs <base-url> <out-dir>
// Writes <out-dir>/<scenario>-light.png, <scenario>-dark.png and manifest.json.
// Every scenario has its own timeout; failures are recorded and the run continues.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [baseUrl, outDir] = process.argv.slice(2)
if (!baseUrl || !outDir) {
  console.error('usage: node scripts/snapshot.mjs <base-url> <out-dir>')
  process.exit(2)
}

// puppeteer-core lives in frontend/node_modules (a devDependency of the frontend).
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url))
const { default: puppeteer } = await import(pathToFileURL(frontendRequire.resolve('puppeteer-core')).href)

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SCENARIO_TIMEOUT_MS = Number(process.env.SNAPSHOT_TIMEOUT_MS || 45000)

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 }
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- helpers -----------------------------------------------------------------------

/** Sets prefers-color-scheme (plus any extra media features) through CDP in one call,
 *  since puppeteer's emulateMediaFeatures rejects hover/pointer. */
async function setScheme(ctx, scheme) {
  const features = [{ name: 'prefers-color-scheme', value: scheme }, ...(ctx.extraMedia ?? [])]
  await ctx.cdp.send('Emulation.setEmulatedMedia', { media: '', features })
}

async function search(page, mode, query, pick) {
  const input = 'input[role="combobox"]'
  await page.waitForSelector(input, { visible: true })
  if (mode === 'song') {
    const isSong = await page.$eval('.search__mode [role="radio"]:nth-child(2)', (b) => b.getAttribute('aria-checked') === 'true')
    if (!isSong) await page.click('.search__mode [role="radio"]:nth-child(2)')
  }
  await page.click(input)
  await page.type(input, query, { delay: 20 })
  await page.waitForSelector('.search__item', { visible: true })
  const items = await page.$$('.search__item')
  for (const item of items) {
    const name = await item.$eval('.search__name', (el) => el.textContent?.replace('♪', '').trim())
    if (name === pick) {
      await item.click()
      return
    }
  }
  throw new Error(`search result "${pick}" not found for query "${query}"`)
}

const nodeCount = (page) => page.$$eval('g.node', (els) => els.length)

async function waitForNodes(page, min, timeout = 15000) {
  await page.waitForFunction((n) => document.querySelectorAll('g.node').length >= n
    && document.querySelector('.star-field .sky-dot')
    && document.querySelector('g.node .node__hit')
    && document.querySelector('.journey-path'), { timeout }, min)
}

/** Polls node positions until the force simulation has effectively stopped moving. */
async function waitForSettle(page, { maxMs = 10000, quietMs = 600, tolerance = 0.5 } = {}) {
  const read = () =>
    page.$$eval('g.node', (els) =>
      els.map((el) => {
        const r = el.querySelector('.node__body')?.getBoundingClientRect()
        return r ? [r.x, r.y, r.width] : [0, 0, 0]
      }),
    )
  const start = Date.now()
  let prev = await read()
  let quietSince = Date.now()
  while (Date.now() - start < maxMs) {
    await sleep(150)
    const cur = await read()
    const moved =
      cur.length !== prev.length || cur.some((p, i) => Math.abs(p[0] - prev[i][0]) + Math.abs(p[1] - prev[i][1]) + Math.abs(p[2] - prev[i][2]) > tolerance)
    if (moved) quietSince = Date.now()
    else if (Date.now() - quietSince >= quietMs) return
    prev = cur
  }
}

/** Waits until the side/bottom panel has a title and is no longer loading. */
async function waitForPanel(page) {
  await page.waitForSelector('.panel .panel__title', { visible: true })
  await page.waitForFunction(() => !document.querySelector('.panel .panel__loading'), { timeout: 10000 })
  await sleep(400) // slide-in transition
}

/** Finds a visible, unexpanded neighbour whose .node__body is actually hit at its centre. */
async function neighbourPoint(page) {
  return page.evaluate(() => {
    for (const g of document.querySelectorAll('g.node:not(.is-root)')) {
      const body = g.querySelector('.node__body')
      if (!body) continue
      const r = body.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
      const hit = document.elementFromPoint(x, y)
      if (hit && g.contains(hit)) return { x, y, name: g.getAttribute('aria-label') }
    }
    return null
  })
}

async function artistGraph(page) {
  await search(page, 'artist', 'Radiohead', 'Radiohead')
  await waitForNodes(page, 3)
  await waitForSettle(page)
}

// ---- scenarios ---------------------------------------------------------------------

const scenarios = [
  {
    name: 'constellation-dense', viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 1)
      const denseMap = await page.evaluate(() => {
        const map = JSON.parse(localStorage.getItem('tunegraph:map:v1'))
        const root = map.nodes.find(n => n.id === map.rootId)
        map.nodes = [root, ...Array.from({ length: 36 }, (_, i) => ({
          id: `dense-${i}`, name: `Constellation discovery ${i + 1}`, kind: 'artist',
          expanded: false, parentId: root.id,
        }))]
        map.edges = map.nodes.slice(1).map((n, i) => ({ id: `edge-${i}`, source: root.id, target: n.id, similarity: 0.6 + i / 120 }))
        map.journey = [root.id, 'dense-0', 'dense-1']
        map.selectedNodeId = 'dense-1'
        return JSON.stringify(map)
      })
      // The live app flushes its old graph on pagehide. Install the fixture only
      // in the new document, after that flush and before React reads storage.
      await page.evaluateOnNewDocument(raw => localStorage.setItem('tunegraph:map:v1', raw), denseMap)
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('.resume-card .btn--primary')
      await page.click('.resume-card .btn--primary')
      await waitForNodes(page, 37)
      await waitForSettle(page)
      await page.click('[aria-label="Fit graph to view"]')
      await waitForSettle(page)
      await page.waitForFunction(() => document.querySelector('.journey-path')?.getAttribute('d')?.includes('L'))
      return '37 artist stars, long labels, collision hiding/flips and cyan selected journey stop'
    },
  },
  ...[
    { name: 'constellation-reduced-motion', viewport: DESKTOP, extraMedia: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
    { name: 'constellation-coarse-pointer', viewport: { ...DESKTOP, isMobile: true, hasTouch: true } },
  ].map(settings => ({
    ...settings,
    async run(page) {
      if (settings.name === 'constellation-coarse-pointer') {
        const coarseOnly = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches
          && !window.matchMedia('(max-width: 640px)').matches)
        if (!coarseOnly) throw new Error('coarse-pointer scenario requires native coarse pointer at desktop width')
      }
      await artistGraph(page)
      await page.waitForSelector('.graph.reduced-glow')
      await page.waitForFunction(() => !document.querySelector('.star-field .sky-halo')
        && [...document.querySelectorAll('.node__glow')].every(el => getComputedStyle(el).display === 'none'))
      return 'Rings retained; node glows and soft-star halos omitted'
    },
  })),
  ...[
    { name: 'shell-empty-inspector', viewport: DESKTOP, empty: true },
    { name: 'shell-song-selected', viewport: DESKTOP, song: true },
    { name: 'shell-undo-enabled', viewport: DESKTOP, prune: true },
    { name: 'shell-1024', viewport: { width: 1024, height: 800 } },
    { name: 'shell-900', viewport: { width: 900, height: 800 } },
  ].map((settings) => ({
    ...settings,
    async run(page) {
      await search(page, settings.song ? 'song' : 'artist', settings.song ? 'Creep' : 'Radiohead', settings.song ? 'Creep' : 'Radiohead')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      if (settings.empty) {
        await page.click('[aria-label="Close inspector"]')
        await page.waitForSelector('.inspector-empty', { visible: true })
      }
      if (settings.prune) {
        await page.click('.panel__prune button[title="Undo this expansion: remove everything explored from here"]')
        await page.waitForSelector('.header-undo[aria-disabled="false"]')
      }
      await page.waitForSelector('.statusbar', { visible: true })
      await waitForSettle(page)
      return 'Studio Sky shell with fixed inspector dock and live status bar'
    },
  })),

  ...[
    { name: 'taste-artist-added', viewport: DESKTOP, kind: 'artist', action: 'like' },
    { name: 'taste-song-added', viewport: DESKTOP, kind: 'song', action: 'like' },
    { name: 'taste-song-disliked', viewport: DESKTOP, kind: 'song', action: 'dislike' },
    { name: 'taste-mobile-added', viewport: MOBILE, userAgent: MOBILE_UA, kind: 'song', action: 'like' },
    { name: 'taste-full', viewport: DESKTOP, kind: 'artist', action: 'full' },
  ].map((settings) => ({
    ...settings,
    async run(page) {
      if (settings.action === 'full') {
        await page.evaluate(() => localStorage.setItem('tunegraph:taste:v1', JSON.stringify({
          liked_artists: Array.from({ length: 50 }, (_, i) => `Artist ${i}`),
          liked_tracks: [], liked_genres: [], disliked: [], notes: '',
        })))
        await page.reload({ waitUntil: 'networkidle0' })
      }
      await search(page, settings.kind, settings.kind === 'artist' ? 'Radiohead' : 'Creep', settings.kind === 'artist' ? 'Radiohead' : 'Creep')
      await waitForPanel(page)
      if (settings.viewport === MOBILE) await page.click('.panel__handle')
      await page.click(settings.action === 'dislike' ? '.taste-toggle__dislike' : '.taste-toggle__like')
      await page.waitForSelector('.toast__action', { visible: true })
      await page.waitForFunction((action) => document.querySelector('.toast__action')?.textContent === (action === 'full' ? 'Edit taste' : 'Undo'), {}, settings.action)
      return settings.action === 'full' ? 'Full taste list with Edit taste action' : 'Panel taste toggle with stored entry and Undo'
    },
  })),
  ...['artist', 'song'].flatMap((kind) => ['taste', 'dislikes'].map((target) => ({
    name: `taste-${kind}-moved-to-${target}`,
    viewport: DESKTOP,
    async run(page) {
      await search(page, kind, kind === 'artist' ? 'Radiohead' : 'Creep', kind === 'artist' ? 'Radiohead' : 'Creep')
      await waitForPanel(page)
      const first = target === 'taste' ? '.taste-toggle__dislike' : '.taste-toggle__like'
      const second = target === 'taste' ? '.taste-toggle__like' : '.taste-toggle__dislike'
      await page.click(first)
      await page.waitForSelector('.taste-toggle .panel__hint', { visible: true })
      await page.click(second)
      const likedLabel = kind === 'artist' ? 'liked bands' : 'liked songs'
      const destination = target === 'taste' ? likedLabel : 'dislikes'
      const source = target === 'taste' ? 'dislikes' : likedLabel
      await page.waitForFunction(({ source, destination }) => {
        const hints = document.querySelectorAll('.taste-toggle .panel__hint')
        const toast = document.querySelector('.toast')?.textContent ?? ''
        const entry = hints[0]?.textContent?.slice(`In ${destination}: `.length)
        return hints.length === 1 && hints[0].textContent.startsWith(`In ${destination}: `)
          && toast.includes(`Moved “${entry}” from ${source} to ${destination}.`)
          && document.querySelector('.toast__action')?.textContent === 'Undo'
      }, {}, { source, destination })
      return `Moved to ${target} with one stored hint and Undo`
    },
  }))),
  ...[
    { name: 'steering-unselected', viewport: DESKTOP, selectedTags: 0 },
    { name: 'steering-two', viewport: DESKTOP, selectedTags: 2 },
    { name: 'steering-three', viewport: DESKTOP, selectedTags: 3 },
    { name: 'steering-expanded', viewport: DESKTOP, expandedSong: true },
    { name: 'steering-artist-regression', viewport: DESKTOP, artistMode: true },
    { name: 'steering-mobile', viewport: MOBILE, userAgent: MOBILE_UA, selectedTags: 2,
      extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] },
  ].map((settings) => ({
    ...settings,
    async run(page) {
      await search(page, settings.artistMode ? 'artist' : 'song', settings.artistMode ? 'Radiohead' : 'Creep', settings.artistMode ? 'Radiohead' : 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await page.waitForSelector('.tags .tag')
      await page.waitForFunction(() => document.querySelector('.panel__actions .btn--primary')?.textContent.includes('Connections expanded'))
      if (settings.artistMode || settings.expandedSong) {
        if (await page.$('button.tag')) throw new Error('expanded/artist tags must be plain')
      } else {
        await page.click('.panel__prune button[title="Undo this expansion: remove everything explored from here"]')
        await page.waitForSelector('button.tag--steering')
        const chips = await page.$$('button.tag--steering')
        if (chips.length < 4) throw new Error('fixture needs at least four tags')
        for (let i = 0; i < settings.selectedTags; i++) await chips[i].click()
        await page.waitForFunction((count) => document.querySelectorAll('button.tag[aria-pressed="true"]').length === count, {}, settings.selectedTags)
        if (settings.selectedTags) await page.waitForFunction(() => [...document.querySelectorAll('.panel__hint')].some((el) => el.textContent.includes('Steering:')))
        if (settings.selectedTags === 3 && !(await page.$('button.tag[aria-disabled="true"]'))) throw new Error('fourth chip must be disabled')
      }
      if (settings.viewport === MOBILE) await page.click('.panel__handle')
      await waitForSettle(page)
      return 'Song tag steering; artist and expanded tags remain plain'
    },
  })),
  ...[
    { name: 'resume-map', viewport: DESKTOP },
    { name: 'resume-map-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
  ].map((options) => ({
    ...options,
    async run(page) {
      await artistGraph(page)
      await waitForSettle(page)
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 1)
      await page.reload()
      await page.waitForSelector('.resume-card', { visible: true })
      return 'Last map available; search retains initial focus'
    },
  })),
  {
    name: 'resume-invalid', viewport: DESKTOP,
    async run(page) {
      await page.evaluate(() => localStorage.setItem('tunegraph:map:v1', '{broken'))
      await page.reload()
      await page.waitForSelector('.resume-card', { visible: true })
      return 'Corrupt snapshot offers Start fresh only'
    },
  },
  {
    name: 'resumed-map-toast', viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 1)
      await page.reload()
      await page.waitForSelector('.resume-card .btn--primary', { visible: true })
      await page.click('.resume-card .btn--primary')
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'Map restored.')
      return 'Artist map restored with four-second confirmation toast'
    },
  },
  {
    name: 'resumed-song-map', viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 2)
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 1)
      await page.reload()
      await page.waitForSelector('.resume-card .btn--primary', { visible: true })
      await page.click('.resume-card .btn--primary')
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'Map restored.')
      await waitForNodes(page, 2)
      await waitForPanel(page)
      await waitForSettle(page)
      return 'Song map restored with selection, trail and fitted view'
    },
  },
  ...[
    { name: 'song-not-suggested', viewport: DESKTOP },
    { name: 'song-not-suggested-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
    { name: 'not-suggested-list', viewport: DESKTOP },
    { name: 'not-suggested-list-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
    { name: 'not-suggested-empty', viewport: DESKTOP },
  ].map((options) => ({
    ...options,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForPanel(page)
      if (options.name !== 'not-suggested-empty') await page.click('.exclusion-toggle')
      if (options.name.startsWith('not-suggested')) {
        await page.click('.topbar .saved-entry')
        await page.waitForSelector('.saved-dialog', { visible: true })
        await page.click('#excluded-tab')
      }
    },
  })),
  {
    name: 'saved-empty',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.topbar .saved-entry')
      await page.waitForSelector('.saved-dialog', { visible: true })
    },
  },
  ...[
    { name: 'saved-discoveries', viewport: DESKTOP },
    { name: 'saved-discoveries-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
  ].map((options) => ({
    ...options,
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await search(page, 'song', 'Creep', 'Creep')
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await search(page, 'song', 'Glory Box', 'Glory Box')
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await page.click('.topbar .saved-entry')
      await page.waitForSelector('.saved-dialog', { visible: true })
    },
  })),
  {
    name: 'saved-remove-undo',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await page.click('.topbar .saved-entry')
      await page.click('.saved-list .icon-btn')
      await page.waitForSelector('.toast__action', { visible: true })
    },
  },
  {
    name: 'saved-artist-panel',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await waitForSettle(page)
    },
  },
  {
    name: 'saved-song-panel',
    viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await waitForSettle(page)
    },
  },
  {
    name: 'saved-mobile-panel',
    viewport: MOBILE,
    userAgent: MOBILE_UA,
    extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }],
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await waitForSettle(page)
    },
  },
  {
    name: 'saved-full',
    viewport: DESKTOP,
    async run(page) {
      await page.evaluate(() => localStorage.setItem('tunegraph:bookmarks:v1', JSON.stringify({
        version: 1,
        items: Array.from({ length: 200 }, (_, i) => ({ kind: 'artist', item: { id: `saved-${i}`, name: `Discovery ${i + 1}` }, savedAt: i })),
      })))
      await page.reload({ waitUntil: 'networkidle0' })
      await artistGraph(page)
      await waitForPanel(page)
      await page.click('.bookmark-toggle')
      await page.waitForSelector('.toast', { visible: true })
      await waitForSettle(page)
    },
  },
  {
    name: 'empty',
    viewport: DESKTOP,
    async run(page) {
      await page.waitForSelector('.hero .search', { visible: true })
    },
  },
  {
    name: 'artist-graph',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      if (await page.$('.journey__follow')) throw new Error('artist map shows song switch')
      const before = await nodeCount(page)
      const pt = await neighbourPoint(page)
      if (!pt) throw new Error('no clickable neighbour node found')
      await page.mouse.click(pt.x, pt.y, { count: 2 })
      await page.waitForFunction((n) => document.querySelectorAll('g.node').length > n, { timeout: 15000 }, before)
      await waitForSettle(page)
      // Close the panel so the expanded graph fills the stage.
      await page.keyboard.press('Escape')
      await page.waitForSelector('.panel', { hidden: true })
      await waitForSettle(page)
      return `expanded ${pt.name}; ${await nodeCount(page)} nodes`
    },
  },
  {
    name: 'artist-panel',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await waitForSettle(page)
      return `panel: ${await page.$eval('.panel__title', (el) => el.textContent)}`
    },
  },
  {
    name: 'song-graph',
    viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await waitForSettle(page)
      await page.waitForSelector('.journey__follow[aria-checked="false"]')
      return `${await nodeCount(page)} songs; Follow journey off`
    },
  },
  ...[
    { name: 'song-journey-on', viewport: DESKTOP },
    { name: 'mobile-song-journey-on', viewport: MOBILE, userAgent: MOBILE_UA,
      extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] },
  ].map((settings) => ({
    ...settings,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await page.waitForSelector('.journey__follow[aria-checked="false"]')
      await page.click('.journey__follow')
      // Select a leaf through its existing keyboard control, avoiding panel overlap.
      const leaf = await page.$('g.node:not(.is-root)')
      if (!leaf) throw new Error('no song leaf')
      // ElementHandle.focus() rejects SVG; use the node's native DOM focus.
      await page.evaluate((node) => node.focus(), leaf)
      await page.keyboard.press('Enter')
      await waitForPanel(page)
      await page.waitForFunction(() => [...document.querySelectorAll('.panel__hint')]
        .some((el) => el.textContent.includes('Next expansion follows your')))
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.journey')).opacity === '1')
      await waitForSettle(page)
      return 'Follow journey on, full-opacity trail and next-expansion hint'
    },
  })),
  {
    name: 'taste-profile',
    viewport: DESKTOP,
    async run(page) {
      await page.waitForSelector('.hero .taste-entry', { visible: true })
      await page.click('.hero .taste-entry')
      await page.waitForSelector('.taste-dialog', { visible: true })
      await sleep(300)
    },
  },
  {
    name: 'mobile-graph',
    viewport: MOBILE,
    userAgent: MOBILE_UA,
    extraMedia: [
      { name: 'hover', value: 'none' },
      { name: 'pointer', value: 'coarse' },
    ],
    async run(page) {
      await artistGraph(page)
      await waitForPanel(page)
      await waitForSettle(page)
      return `bottom sheet: ${await page.$eval('.panel__title', (el) => el.textContent)}`
    },
  },
]

// ---- runner ------------------------------------------------------------------------

async function runScenario(browser, sc) {
  const entry = { name: sc.name, light: null, dark: null, status: 'ok', note: '' }
  const context = await browser.createBrowserContext()
  let timer
  try {
    const work = (async () => {
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', (err) => errors.push(err.message))
      if (sc.userAgent) await page.setUserAgent(sc.userAgent)
      await page.setViewport(sc.viewport)
      const ctx = { cdp: await page.createCDPSession(), extraMedia: sc.extraMedia }
      await setScheme(ctx, 'light')
      await page.goto(baseUrl, { waitUntil: 'networkidle0' })
      // A blinking text caret would make otherwise identical captures differ.
      await page.addStyleTag({ content: '* { caret-color: transparent !important; }' })
      const note = (await sc.run(page)) || ''
      for (const scheme of ['light', 'dark']) {
        await setScheme(ctx, scheme)
        await sleep(250)
        const file = `${sc.name}-${scheme}.png`
        await page.screenshot({ path: join(outDir, file) })
        entry[scheme] = file
      }
      entry.note = [note, errors.length ? `page errors: ${errors.join(' | ')}` : ''].filter(Boolean).join('; ')
    })()
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${SCENARIO_TIMEOUT_MS} ms`), { timeout: true })), SCENARIO_TIMEOUT_MS)
    })
    work.catch(() => {}) // the race below reports it; avoid an unhandled rejection after a timeout
    await Promise.race([work, timeout])
  } catch (err) {
    entry.status = err.timeout ? 'timeout' : 'error'
    entry.note = err.message ?? String(err)
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => {})
  }
  return entry
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio'],
})
const manifest = []
try {
  for (const sc of scenarios) {
    const entry = await runScenario(browser, sc)
    manifest.push(entry)
    console.log(`${entry.status.padEnd(7)} ${entry.name}${entry.note ? ` (${entry.note})` : ''}`)
  }
} finally {
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await browser.close().catch(() => {})
}
