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
  // Phone map header (#34): the search field opens from the Find icon.
  if (!(await page.$(input)) && (await page.$('.topbar__find'))) await page.click('.topbar__find')
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

/** Saves a real map, rewrites its journey to `stops` stops, then reloads to the start screen. */
async function resumeFixture(page, { song = false, stops = 2 } = {}) {
  if (song) {
    await search(page, 'song', 'Creep', 'Creep')
    await waitForNodes(page, 3)
  } else await artistGraph(page)
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 2)
  const raw = await page.evaluate((count) => {
    const map = JSON.parse(localStorage.getItem('tunegraph:map:v1'))
    const leaves = map.nodes.filter((n) => n.id !== map.rootId)
    map.journey = [map.rootId, ...leaves.slice(0, count - 1).map((n) => n.id)]
    map.selectedNodeId = map.journey.at(-1)
    return JSON.stringify(map)
  }, stops)
  // Install after the live app's pagehide flush, before React reads storage.
  await page.evaluateOnNewDocument((value) => localStorage.setItem('tunegraph:map:v1', value), raw)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.resume-card--ready', { visible: true })
}

/** Selects the top On map row and expands it from the inspector, making a second journey stop. */
async function expandTopRow(page) {
  await page.waitForSelector('.nav-row', { visible: true })
  await page.click('.nav-row')
  await page.waitForSelector('.nav-row[aria-pressed="true"]')
  await page.waitForSelector('.panel .btn--primary:not([disabled])', { visible: true })
  await page.click('.panel .btn--primary')
  await page.waitForFunction(() => document.querySelectorAll('.nav-stop').length === 2)
}

/** Rewrites the saved map with `edit` (run in the page), then resumes it from the start screen. */
async function resumeEdited(page, edit, arg) {
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('tunegraph:map:v1') ?? 'null')?.nodes?.length > 2)
  const raw = await page.evaluate(edit, arg)
  // Install after the live app's pagehide flush, before React reads storage.
  await page.evaluateOnNewDocument((value) => localStorage.setItem('tunegraph:map:v1', value), raw)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.resume-card .btn--primary')
  await page.click('.resume-card .btn--primary')
  await page.waitForSelector('.nav-row', { visible: true })
}

/** Library fixtures with known ages; reload so the start screen reads them. */
async function libraryFixture(page, { saved = true, excluded = true } = {}) {
  await page.evaluate(({ saved, excluded }) => {
    const day = 86400000, now = Date.now()
    const song = (id, name, artist, age) => ({ kind: 'track', item: { id, name, artist: { id: artist, name: artist } }, savedAt: now - age * day })
    localStorage.setItem('tunegraph:bookmarks:v1', JSON.stringify({ version: 1, items: saved ? [
      song('glory-box', 'Glory Box', 'Portishead', 0), song('teardrop', 'Teardrop', 'Massive Attack', 0),
      { kind: 'artist', item: { id: 'sigur-ros', name: 'Sigur Rós' }, savedAt: now - day },
      song('karma-police', 'Karma Police', 'Radiohead', 12),
    ] : [] }))
    localStorage.setItem('tunegraph:exclusions:v1', JSON.stringify({ version: 1, items: excluded ? [
      song('no-surprises', 'No Surprises', 'Radiohead', 3), song('unfinished', 'Unfinished Sympathy', 'Massive Attack', 0),
    ] : [] }))
  }, { saved, excluded })
  await page.reload({ waitUntil: 'networkidle0' })
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
      if (settings.viewport === MOBILE) await page.click('.sheet__handle')
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
      if (settings.viewport === MOBILE) await page.click('.sheet__handle')
      await waitForSettle(page)
      return 'Song tag steering; artist and expanded tags remain plain'
    },
  })),
  // #38 plain-word steering on Creep (mock tags: alternative, 90s, rock, alternative rock,
  // grunge). Mock fixtures: a named tag is emphasized, "less <tag>" is an ignored avoid.
  ...[
    { name: 'steer-words-empty', expect: "Picks from this song's tags only." },
    { name: 'steer-words-pending', text: 'more rock and grunge', hang: true, expect: 'Interpreting…' },
    { name: 'steer-words-proposed', text: 'more rock and grunge', expect: 'Interpreted as:' },
    { name: 'steer-words-avoid', text: 'grunge but less rock', expect: "Steering away from a sound isn't supported yet, so that part was left out." },
    { name: 'steer-words-no-match', text: 'with bagpipes', expect: "None of this song's tags matched. Try words closer to the tags below, or pick them yourself." },
    { name: 'steer-words-error', text: 'darker', respond: 504, expect: 'JEV took too long to answer. Try again.' },
    { name: 'steer-words-expanded', expanded: true },
    { name: 'steer-words-mobile', text: 'more rock and grunge', expect: 'Interpreted as:', viewport: MOBILE, userAgent: MOBILE_UA,
      extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] },
  ].map(({ viewport = DESKTOP, ...settings }) => ({
    ...settings,
    viewport,
    async run(page) {
      if (settings.respond || settings.hang) {
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          if (!request.url().includes('/api/taste/steer-tags')) return request.continue()
          if (settings.respond) {
            return request.respond({ status: settings.respond, contentType: 'application/json',
              body: JSON.stringify({ error: 'timed out', provider: 'jev' }) })
          }
          // hang: leave the request pending so Interpreting… stays on screen
        })
      }
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await page.waitForSelector('.tags .tag')
      await page.waitForFunction(() => document.querySelector('.panel__actions .btn--primary')?.textContent.includes('Connections expanded'))
      if (viewport === MOBILE) await page.click('.panel__handle')
      if (settings.expanded) {
        if (await page.$('.steer-words')) throw new Error('an expanded song must not show the plain-word form')
        await waitForSettle(page)
        return 'Expanded song: no plain-word form, plain tags'
      }
      await page.click('.panel__prune button[title="Undo this expansion: remove everything explored from here"]')
      await page.waitForSelector('.steer-words input')
      if (settings.text) {
        await page.type('.steer-words input', settings.text)
        await page.keyboard.press('Enter')
      }
      await page.waitForFunction((text) => [...document.querySelectorAll('.steer-words *')]
        .some((el) => el.textContent.includes(text)), {}, settings.expect)
      await page.$eval('.steer-words',(el) => el.scrollIntoView({ block: 'center' }))
      await sleep(200)
      return settings.expect
    },
  })),
  ...[
    { name: 'resume-map', viewport: DESKTOP, song: true, stops: 2 },
    { name: 'resume-map-mobile', viewport: MOBILE, userAgent: MOBILE_UA, song: true, stops: 2 },
    { name: 'resume-one-stop', viewport: DESKTOP, song: false, stops: 1 },
  ].map((options) => ({
    ...options,
    async run(page) {
      await resumeFixture(page, options)
      await page.waitForSelector('.resume__map circle')
      const title = await page.$eval('.resume__title', (el) => el.textContent)
      if (options.stops > 1 !== title.includes('›')) throw new Error(`unexpected resume title "${title}"`)
      if (await page.$('.search__map-it.btn--primary')) throw new Error('MAP IT must be outlined while RESUME shows')
      return `RESUME "${title}", ${options.stops} stop(s); search keeps initial focus`
    },
  })),
  {
    name: 'resume-invalid', viewport: DESKTOP,
    async run(page) {
      await page.evaluate(() => localStorage.setItem('tunegraph:map:v1', '{broken'))
      await page.reload()
      await page.waitForSelector('.resume-card--invalid', { visible: true })
      await page.waitForSelector('.search__map-it.btn--primary')
      return 'Corrupt snapshot offers START FRESH only; MAP IT is primary'
    },
  },
  {
    name: 'library-badge-exclusions', viewport: DESKTOP,
    async run(page) {
      await libraryFixture(page, { saved: false })
      await page.waitForFunction(() => document.querySelector('.start-header .library-count')?.textContent === '2')
      return 'Badge counts not-suggested songs with nothing saved (#24)'
    },
  },
  ...[
    { name: 'library-start', viewport: DESKTOP },
    { name: 'library-start-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
  ].map((options) => ({
    ...options,
    async run(page) {
      await libraryFixture(page)
      await page.click('.start-header .library-button')
      await page.waitForSelector('.library-drawer', { visible: true })
      await page.waitForFunction(() => document.activeElement?.id === 'saved-tab')
      return 'Start screen with the library drawer open on Saved'
    },
  })),
  // #46: the static Contour backdrop behind each start-screen state.
  ...[
    { name: 'start-desktop', viewport: DESKTOP },
    { name: 'start-resume', viewport: DESKTOP, fixture: 'resume' },
    { name: 'start-library', viewport: DESKTOP, fixture: 'library' },
    { name: 'start-mobile', viewport: MOBILE, userAgent: MOBILE_UA },
    { name: 'start-short', viewport: { width: 1440, height: 600, deviceScaleFactor: 1 } },
  ].map((options) => ({
    ...options,
    async run(page) {
      if (options.fixture === 'resume') await resumeFixture(page, { stops: 2 })
      if (options.fixture === 'library') {
        await libraryFixture(page)
        await page.click('.start-header .library-button')
        await page.waitForSelector('.library-drawer', { visible: true })
      }
      await page.waitForSelector('.search--start', { visible: true })
      await page.waitForFunction(() => (document.querySelector('.start-backdrop .contour-index')?.getAttribute('d') ?? '').length > 0)
      const backdrop = await page.$eval('.start-backdrop', (svg) => ({
        hidden: svg.getAttribute('aria-hidden'), pointer: getComputedStyle(svg).pointerEvents,
        dots: svg.querySelectorAll('circle').length, top: Math.round(svg.getBoundingClientRect().top),
        kb: Math.round([...svg.querySelectorAll('path')].reduce((n, p) => n + (p.getAttribute('d') ?? '').length, 0) / 1024),
      }))
      if (backdrop.hidden !== 'true' || backdrop.pointer !== 'none' || backdrop.dots) throw new Error(`backdrop must be decorative contours only: ${JSON.stringify(backdrop)}`)
      if (await page.$('.start-sky')) throw new Error('old star sky must be gone')
      // #62: intro copy visible above NEW MAP, NEW MAP fully above the fold, no horizontal scroll.
      const intro = await page.evaluate(() => {
        // DOMRect does not serialise out of page.evaluate, so copy plain numbers.
        const box = (sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect()
          return r && { top: r.top, bottom: r.bottom, height: r.height }
        }
        const title = box('.start-intro__title')
        const text = box('.start-intro__text')
        const panel = box('.start-panel[aria-labelledby="new-map-title"]')
        return { title, text, panel, vh: innerHeight,
          scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth }
      })
      if (!intro.title?.height || !intro.text?.height) throw new Error(`intro copy must be visible: ${JSON.stringify(intro)}`)
      if (intro.text.bottom > intro.panel.top) throw new Error(`intro must sit above NEW MAP: ${JSON.stringify(intro)}`)
      if (intro.panel.bottom > intro.vh) throw new Error(`NEW MAP must stay above the fold: ${JSON.stringify(intro)}`)
      if (intro.scrollX) throw new Error('start screen must not scroll horizontally')
      return `Contour backdrop below the header (top ${backdrop.top}px), ${backdrop.kb} KB of path data; intro above NEW MAP (top ${Math.round(intro.panel.top)}px)`
    },
  })),
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
        await page.waitForSelector('.library-drawer', { visible: true })
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
      await page.waitForSelector('.library-drawer', { visible: true })
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
      await page.waitForSelector('.library-drawer', { visible: true })
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
      await page.waitForSelector('.search--start', { visible: true })
      await page.waitForSelector('.search__map-it.btn--primary')
      if (await page.$('.resume-card')) throw new Error('fresh start must not offer RESUME')
      return 'NEW MAP only; MAP IT is the amber primary'
    },
  },
  {
    name: 'artist-graph',
    viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      if (await page.$('.journey__follow, .map-nav__follow')) throw new Error('artist map shows song switch')
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
      await page.waitForSelector('.map-nav__follow[aria-checked="false"]', { visible: true })
      // Owner decision on #31: ON MAP lists the root's first connections before any expand.
      await page.waitForFunction(() => document.querySelectorAll('.nav-row').length === document.querySelectorAll('g.node').length - 1)
      return `${await nodeCount(page)} songs; Follow journey off; every leaf listed On map`
    },
  },
  {
    name: 'song-journey-on', viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await page.click('.map-nav__follow[aria-checked="false"]')
      await page.waitForSelector('.map-nav__follow[aria-checked="true"]')
      await expandTopRow(page)
      // The expanded song is both the current stop (amber) and the selection (cyan row).
      await page.waitForFunction(() => document.querySelector('.nav-stop:last-child.is-current [aria-current="step"]')
        && document.querySelector('.nav-row[aria-pressed="true"]'))
      await waitForSettle(page)
      return 'Follow journey on; 2 stops, current stop amber, selected On map row cyan'
    },
  },
  {
    name: 'artist-journey-on-map', viewport: DESKTOP,
    async run(page) {
      await artistGraph(page)
      await expandTopRow(page)
      if (await page.$('.map-nav__follow')) throw new Error('artist map shows the Follow journey switch')
      await waitForSettle(page)
      return `artist journey with 2 stops; ON MAP lists ${await page.$$eval('.nav-row', (rows) => rows.length)} artists`
    },
  },
  {
    name: 'journey-collapse-undo', viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await expandTopRow(page)
      await page.click('.nav-stop:last-child .nav-stop__collapse')
      // ON MAP keeps one row per remaining leaf after the branch goes.
      await page.waitForFunction(() => document.querySelectorAll('.nav-stop').length === 1
        && document.querySelectorAll('.nav-row').length === document.querySelectorAll('g.node').length - 1
        && document.querySelector('.toast__action')?.textContent === 'Undo')
      await waitForSettle(page)
      return 'collapsed the second stop from the pane; ON MAP in sync; undo toast shown'
    },
  },
  {
    name: 'journey-follow-over-cap', viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await resumeEdited(page, (count) => {
        const map = JSON.parse(localStorage.getItem('tunegraph:map:v1'))
        const root = map.nodes.find((n) => n.id === map.rootId)
        root.expanded = true
        const stops = Array.from({ length: count }, (_, i) => ({ id: `stop-${i}`, name: `Journey stop ${i + 1}`, kind: 'track',
          artist: { id: 'stop-artist', name: 'Stop Artist' }, subtitle: 'Stop Artist', expanded: true, parentId: root.id }))
        map.nodes.push(...stops)
        map.edges.push(...stops.map((n, i) => ({ id: `cap-${i}`, source: root.id, target: n.id, similarity: 0.3 + i / 200 })))
        map.journey = [root.id, ...stops.map((n) => n.id)]
        map.focusId = map.selectedNodeId = stops.at(-1).id
        return JSON.stringify(map)
      }, 51)
      await page.waitForSelector('.map-nav__follow[aria-disabled="true"]')
      await page.waitForFunction(() => document.querySelectorAll('.nav-stop').length === 52)
      await waitForSettle(page)
      return '52 stops: Follow journey disabled at 0.45 opacity; newest stop scrolled into view'
    },
  },
  {
    name: 'nav-long-names', viewport: DESKTOP,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await resumeEdited(page, () => {
        const map = JSON.parse(localStorage.getItem('tunegraph:map:v1'))
        const leaf = map.nodes.find((n) => n.id !== map.rootId)
        leaf.name = 'An Extraordinarily Long Song Title That Cannot Possibly Fit In The Left Pane (Extended Remix)'
        leaf.expanded = true
        map.journey = [map.rootId, leaf.id]
        map.focusId = map.selectedNodeId = leaf.id
        return JSON.stringify(map)
      })
      await page.waitForFunction(() => [...document.querySelectorAll('.nav-stop__name, .nav-row__name')]
        .filter((el) => el.textContent.startsWith('An Extraordinarily')).every((el) => el.scrollWidth > el.clientWidth))
      await waitForSettle(page)
      return 'long song name ellipsized in the journey stop and the On map row'
    },
  },
  ...[
    { name: 'mobile-song-journey-on', viewport: MOBILE, userAgent: MOBILE_UA,
      extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] },
  ].map((settings) => ({
    ...settings,
    async run(page) {
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      await page.click('#sheet-tab-journey')
      await page.waitForSelector('.sheet .map-nav__follow[aria-checked="false"]', { visible: true })
      await page.click('.sheet .map-nav__follow')
      await page.waitForSelector('.sheet .map-nav__follow[aria-checked="true"]')
      // Select a leaf through its existing keyboard control, avoiding sheet overlap.
      const leaf = await page.$('g.node:not(.is-root)')
      if (!leaf) throw new Error('no song leaf')
      // ElementHandle.focus() rejects SVG; use the node's native DOM focus.
      await page.evaluate((node) => node.focus(), leaf)
      await page.keyboard.press('Enter')
      await page.waitForSelector('#sheet-tab-inspector[aria-selected="true"]')
      await waitForPanel(page)
      await page.waitForFunction(() => [...document.querySelectorAll('.panel__hint')]
        .some((el) => el.textContent.includes('Next expansion follows your')))
      await page.click('#sheet-tab-journey')
      await page.waitForSelector('#sheet-panel-journey .nav-stop', { visible: true })
      await waitForSettle(page)
      return 'Follow journey on in the JOURNEY tab; selecting a leaf switched to INSPECTOR with the next-expansion hint'
    },
  })),
  // #34 phone sheet states. Coarse pointer; Studio Sky is dark only.
  ...[
    { name: 'mobile-peek', state: 'peek' },
    { name: 'mobile-on-map-tab', state: 'onmap' },
    { name: 'mobile-artist-inspector', state: 'artist' },
    { name: 'mobile-full-sheet', state: 'full' },
    { name: 'mobile-search-overlay', state: 'search' },
  ].map((settings) => ({
    ...settings, viewport: MOBILE, userAgent: MOBILE_UA,
    extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }],
    async run(page) {
      if (settings.state === 'artist') await artistGraph(page)
      else {
        await search(page, 'song', 'Creep', 'Creep')
        await waitForNodes(page, 3)
      }
      await waitForPanel(page)
      if (await page.$('.topbar .header-taste, .topbar .header-undo')) throw new Error('the phone header has no Taste or Undo')
      const tabs = await page.$$eval('.sheet__tabs [role="tab"]', (els) => els.map((el) => [el.textContent, el.getBoundingClientRect().height]))
      if (tabs.length !== 3 || tabs.some(([, h]) => h < 44)) throw new Error(`tabs must be three 44px targets: ${JSON.stringify(tabs)}`)
      if (settings.state === 'peek') {
        await page.click('.panel [aria-label="Close inspector"]')
        await page.waitForSelector('.sheet.sheet--peek #sheet-tab-journey[aria-selected="true"]')
      } else if (settings.state === 'onmap') {
        await page.click('#sheet-tab-onmap')
        await page.waitForSelector('#sheet-panel-onmap .nav-row', { visible: true })
        const short = await page.$$eval('#sheet-panel-onmap .nav-row', (rows) => rows.filter((row) => row.getBoundingClientRect().height < 44).length)
        if (short) throw new Error(`${short} On map rows are under 44px`)
      } else if (settings.state === 'full') {
        await page.click('.sheet__handle')
        await page.waitForSelector('.sheet.sheet--full')
        await sleep(350) // height transition
        const [header, sheet] = await page.$$eval('.topbar, .sheet', (els) => els.map((el) => el.getBoundingClientRect().toJSON()))
        if (sheet.top < header.bottom) throw new Error('the full sheet must leave the header visible')
      } else if (settings.state === 'search') {
        await page.click('.topbar__find')
        await page.waitForSelector('.topbar__search input[role="combobox"]', { visible: true })
        await page.type('.topbar__search input[role="combobox"]', 'Radio', { delay: 20 })
        await page.waitForSelector('.topbar__search .search__item', { visible: true })
      }
      await waitForSettle(page)
      return `${settings.state}: tabs ${tabs.map(([label]) => label).join(' | ')}`
    },
  })),
  // #24: phone toasts sit above the sheet and never cover the header, search or tabs.
  // The combined cases answer a leaf's expansion with a shortfall plus a journey fallback.
  ...[
    { name: 'mobile-toast-above-sheet', viewport: MOBILE, userAgent: MOBILE_UA },
    { name: 'mobile-combined-toast', viewport: MOBILE, userAgent: MOBILE_UA, combined: true },
    { name: 'combined-toast', viewport: DESKTOP, combined: true },
  ].map((settings) => ({
    ...settings,
    ...(settings.viewport === MOBILE ? { extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] } : {}),
    async run(page) {
      const mobile = settings.viewport === MOBILE
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      if (!settings.combined) {
        await page.click('.exclusion-toggle')
      } else {
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          if (!/\/api\/tracks\/[^/]+\/similar/.test(request.url())) return request.continue()
          const tracks = ['One', 'Two', 'Three'].map((name, i) => ({ id: `combined-${i}`, name: `Combined ${name}`,
            artist: { id: 'combined-artist', name: 'Combined Artist' }, similarity: 0.6 - i / 10, shared_tags: [] }))
          return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
            track: null, tracks, excluded_count: 2, ranking: { mode: 'parent', stop_count: 2, fallback_reason: 'timeout' } }) })
        })
        if (mobile) await page.click('#sheet-tab-onmap')
        const row = mobile ? '#sheet-panel-onmap .nav-row' : '.map-nav .nav-row'
        await page.waitForSelector(row, { visible: true })
        await page.click(row)
        await page.waitForSelector('.panel .btn--primary:not([disabled])', { visible: true })
        await page.click('.panel .btn--primary')
        await page.waitForSelector('.toast--lines .toast__lines span:nth-child(2)', { visible: true })
      }
      await page.waitForSelector('.toast', { visible: true })
      if (mobile) {
        const box = await page.evaluate(() => {
          const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON()
          return { toast: rect('.toast'), header: rect('.topbar'), tabs: rect('.sheet__tabs') }
        })
        if (box.toast.top < box.header.bottom) throw new Error('toast covers the header')
        if (box.toast.bottom > box.tabs.top) throw new Error(`toast covers the sheet tabs: ${JSON.stringify(box)}`)
      }
      await waitForSettle(page)
      return settings.combined ? 'shortfall and journey fallback stacked in one toast' : "Won't suggest toast above the half sheet"
    },
  })),
  // #36 taste check outcomes. Mock fixtures pick the outcome from profile/tag overlap
  // (backend/app/services/jev.py::mock_judgment); Creep's tags are alternative, 90s, rock,
  // alternative rock, grunge. Every mock result carries the Simulated badge.
  ...[
    { name: 'taste-check-song-strong', kind: 'song', profile: { liked_genres: ['grunge', '90s'] }, expect: 'Strong fit' },
    { name: 'taste-check-song-likely', kind: 'song', profile: { liked_genres: ['grunge'] }, expect: 'Likely fit' },
    { name: 'taste-check-song-mixed', kind: 'song', profile: { liked_genres: ['grunge', 'rock'], disliked: ['90s'] }, expect: 'Mixed signals' },
    { name: 'taste-check-song-unlikely', kind: 'song', profile: { liked_genres: ['grunge'], disliked: ['90s', 'rock'] }, expect: 'Unlikely fit' },
    { name: 'taste-check-song-conflict', kind: 'song', profile: { liked_genres: ['jazz'], disliked: ['grunge'] }, expect: 'Conflicts with your dislikes' },
    { name: 'taste-check-song-insufficient', kind: 'song', profile: { liked_genres: ['jazz'] }, expect: 'Not enough information' },
    // #51: the mock split fixture leans Mixed (level 2) and carries the Simulated badge.
    { name: 'taste-check-song-uncertain', kind: 'song', profile: { liked_genres: ['grunge'], disliked: ['90s'] }, expect: "The model's answer was split, so this is a tentative lean, not a firm fit." },
    // #51 tentative levels the fixtures can't reach: `reply` answers the check with that result.
    { name: 'taste-check-song-tentative-likely', kind: 'song', profile: { liked_genres: ['grunge'] }, reply: { outcome: 'uncertain', level: 3, score: 3.2, confidence: 0.2 }, expect: "The model's answer was split, so this is a tentative lean, not a firm fit." },
    { name: 'taste-check-song-tentative-conflict', kind: 'song', profile: { liked_genres: ['jazz'], disliked: ['grunge'] }, reply: { outcome: 'uncertain', level: 0, score: 0.3, confidence: 0.3 }, expect: "The model's answer was split, so this is a tentative lean, not a firm fit." },
    { name: 'taste-check-song-tentative-strong', kind: 'song', profile: { liked_genres: ['grunge', '90s'] }, reply: { outcome: 'uncertain', level: 4, score: 3.8, confidence: 0.1 }, expect: "The model's answer was split, so this is a tentative lean, not a firm fit." },
    { name: 'taste-check-song-uncertain-fallback', kind: 'song', profile: { liked_genres: ['grunge'] }, reply: { outcome: 'uncertain', level: null, score: null, confidence: 0.1 }, expect: 'Uncertain estimate' },
    { name: 'taste-check-mobile-tentative-mixed', kind: 'song', viewport: MOBILE, userAgent: MOBILE_UA, profile: { liked_genres: ['grunge'], disliked: ['90s'] }, expect: "The model's answer was split, so this is a tentative lean, not a firm fit." },
    { name: 'taste-check-artist-strong', kind: 'artist', profile: { liked_artists: ['Radiohead'], liked_genres: ['art rock'] }, expect: 'Strong fit' },
    { name: 'taste-check-timeout', kind: 'song', profile: { liked_genres: ['grunge'] }, respond: 504, expect: 'JEV took too long to answer. Try again.' },
    { name: 'taste-check-loading', kind: 'song', profile: { liked_genres: ['grunge'] }, hang: true, expect: 'JEV is checking (up to 5 seconds).' },
    { name: 'taste-check-mobile-conflict', kind: 'song', viewport: MOBILE, userAgent: MOBILE_UA, profile: { liked_genres: ['jazz'], disliked: ['grunge'] }, expect: 'Conflicts with your dislikes' },
    { name: 'taste-check-mobile-insufficient', kind: 'song', viewport: MOBILE, userAgent: MOBILE_UA, profile: { liked_genres: ['jazz'] }, expect: 'Not enough information' },
  ].map(({ viewport = DESKTOP, ...settings }) => ({
    ...settings,
    viewport,
    async run(page) {
      await page.evaluate((profile) => localStorage.setItem('tunegraph:taste:v1', JSON.stringify({
        liked_artists: [], liked_tracks: [], liked_genres: [], disliked: [], notes: '', ...profile,
      })), settings.profile)
      await page.reload({ waitUntil: 'networkidle0' })
      if (settings.respond || settings.hang || settings.reply) {
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          if (!request.url().includes('/api/taste/evaluate')) return request.continue()
          if (settings.reply) {
            return request.respond({ status: 200, contentType: 'application/json',
              body: JSON.stringify(tasteReply(JSON.parse(request.postData()), settings.reply)) })
          }
          if (settings.respond) {
            return request.respond({ status: settings.respond, contentType: 'application/json',
              body: JSON.stringify({ error: 'timed out', provider: 'jev' }) })
          }
          // hang: leave the request pending so the loading state stays on screen
        })
      }
      await search(page, settings.kind, settings.kind === 'artist' ? 'Radiohead' : 'Creep', settings.kind === 'artist' ? 'Radiohead' : 'Creep')
      await waitForPanel(page)
      if (viewport === MOBILE) await page.click('.sheet__handle')
      await page.click('.taste-check__actions .btn:not(.btn--ghost)')
      await page.waitForFunction((text) => [...document.querySelectorAll('.taste-check *')]
        .some((el) => el.textContent.trim() === text), {}, settings.expect)
      await page.$eval('.taste-check', (el) => el.scrollIntoView({ block: 'center' }))
      await sleep(200)
      return settings.expect
    },
  })),
  // #37 "Check these connections" after Creep's expansion. Its seven mock children are
  // Glory Box, Karma Police, The Smoke, Hearing Damage, Hysteria, Where Is My Mind? and
  // Hoppípolla; this profile gives Strong/Likely fits, Conflicts, Not enough information,
  // and the fixture's malformed seventh answer ("Couldn't check"). Mock results are Simulated.
  ...[
    { name: 'connections-idle', expect: 'Check these connections' },
    { name: 'connections-no-profile', profile: null, expect: 'Add preferences' },
    { name: 'connections-pending', click: true, hang: true, expect: 'Checking…' },
    { name: 'connections-mixed-simulated', click: true, expect: "Couldn't check" },
    { name: 'connections-error', click: true, respond: 504, expect: 'JEV took too long to answer. Try again.' },
    // #51: the second row is a tentative Likely (ring pips, "Leaning:"), counted on its own.
    { name: 'connections-tentative', click: true, replyTentative: true, expect: 'Leaning:' },
    // Its own notes give it fresh cache keys: the backend still holds the desktop scenario's
    // answers, which would make this a one-song retry that the fixture answers.
    { name: 'connections-mobile', click: true, viewport: MOBILE, userAgent: MOBILE_UA,
      profile: { liked_genres: ['trip-hop', 'electronic'], disliked: ['rock'], notes: 'phone' },
      extraMedia: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }], expect: "Couldn't check" },
  ].map(({ viewport = DESKTOP, profile = { liked_genres: ['trip-hop', 'electronic'], disliked: ['rock'] }, ...settings }) => ({
    ...settings,
    viewport,
    async run(page) {
      if (profile) {
        await page.evaluate((profile) => localStorage.setItem('tunegraph:taste:v1', JSON.stringify({
          liked_artists: [], liked_tracks: [], liked_genres: [], disliked: [], notes: '', ...profile,
        })), profile)
        await page.reload({ waitUntil: 'networkidle0' })
      }
      if (settings.respond || settings.hang || settings.replyTentative) {
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          if (!request.url().includes('/api/taste/connections/evaluate')) return request.continue()
          if (settings.replyTentative) {
            return request.respond({ status: 200, contentType: 'application/json',
              body: JSON.stringify(tentativeConnections(JSON.parse(request.postData()))) })
          }
          if (settings.respond) {
            return request.respond({ status: settings.respond, contentType: 'application/json',
              body: JSON.stringify({ error: 'timed out', provider: 'jev' }) })
          }
          // hang: leave the batch pending so every row shows Checking…
        })
      }
      await search(page, 'song', 'Creep', 'Creep')
      await waitForNodes(page, 3)
      await waitForPanel(page)
      if (viewport === MOBILE) await page.click('.sheet__handle')
      await page.waitForSelector('.connections-check .connections__row')
      if (settings.click) await page.click('.connections-check .btn--ghost')
      await page.waitForFunction((text) => [...document.querySelectorAll('.connections-check *')]
        .some((el) => el.textContent.trim() === text), {}, settings.expect)
      await page.$eval('.connections-check', (el) => el.scrollIntoView({ block: 'center' }))
      await sleep(200)
      return `${await page.$$eval('.connections__row', (rows) => rows.length)} rows; ${settings.expect}`
    },
  })),
  {
    name: 'connections-artist-regression', viewport: DESKTOP,
    async run(page) {
      await page.evaluate(() => localStorage.setItem('tunegraph:taste:v1', JSON.stringify({
        liked_artists: [], liked_tracks: [], liked_genres: ['rock'], disliked: [], notes: '',
      })))
      await page.reload({ waitUntil: 'networkidle0' })
      await artistGraph(page)
      await waitForPanel(page)
      await page.waitForFunction(() => document.querySelector('.panel__actions .btn--primary')?.textContent.includes('Connections expanded'))
      if (await page.$('.connections-check')) throw new Error('artist panels must not show the connections check')
      return 'Expanded artist panel without the connections section'
    },
  },
  {
    name: 'taste-profile',
    viewport: DESKTOP,
    async run(page) {
      await page.waitForSelector('.start-header__taste', { visible: true })
      await page.click('.start-header__taste')
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

// #51: stubbed taste replies (declarations, so the scenario list above can use them).
// Creep's mock tags, as the real mock backend returns them.
function tasteReply(request, result) {
  return {
    version: 2, kind: request.kind, item_id: request.item_id, model: 'mock-fixture', rubric_version: 'snapshot',
    tags: ['alternative', '90s', 'rock', 'alternative rock', 'grunge'], simulated: true, ...result,
  }
}

function tentativeConnections(request) {
  const firm = [{ level: 4, score: 3.8 }, { level: 0, score: 0.2 }, { level: 3, score: 3.1 }]
  return {
    version: 1, model: 'mock-fixture', rubric_version: 'snapshot', simulated: true,
    results: request.item_ids.map((item_id, i) => i === 1
      ? { item_id, outcome: 'uncertain', level: 3, score: 3.2, confidence: 0.2 }
      : { item_id, outcome: 'fit', confidence: null, ...firm[i % firm.length] }),
  }
}

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
