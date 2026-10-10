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
  await page.waitForFunction((n) => document.querySelectorAll('g.node').length >= n, { timeout }, min)
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
