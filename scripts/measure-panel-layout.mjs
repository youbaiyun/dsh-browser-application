/**
 * Measure the panel's real layout at many viewport sizes.
 *
 * jsdom cannot answer this: it has no layout engine, so every geometry question
 * (is the composer on screen, did a row overflow, is the settings sheet taller
 * than a box) needs a real engine. This drives the system Chrome through
 * playwright-core and reports measured numbers rather than inspecting CSS text.
 *
 * Usage: node scripts/measure-panel-layout.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Reuse the benchmark's browser discovery instead of hardcoding a path: it
// already resolves Chrome/Chromium per platform, which is exactly the kind of
// Windows-only assumption this repository should not grow another copy of.
import { chromium, findChromiumExecutable } from '../benchmark/lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'extensions', 'dsh-browser', 'dist', 'control')

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const css = readFileSync(join(DIST, 'assets', 'index.css'), 'utf8')
const js = readFileSync(join(DIST, 'assets', 'index.js'), 'utf8')

/**
 * The panel expects the extension APIs. Stub the smallest surface that lets it
 * render, then let it paint: the measurement is about the layout, not the
 * connection.
 */
const STUB = `
  window.chrome = {
    runtime: {
      connect() {
        return {
          postMessage() {},
          disconnect() {},
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
        }
      },
      getURL: (p) => p,
      lastError: undefined,
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
`

const page_html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>${css}</style></head><body><div id="control-root"></div>
<script>${STUB}</script><script type="module">${js}</script></body></html>`

/**
 * Fill the transcript with a realistic amount of content.
 *
 * An empty panel proves nothing: the failure worth catching is content pushing
 * the composer off the bottom, or a row refusing to shrink. This drives the real
 * render path with real message shapes rather than injecting HTML, so what is
 * measured is what the panel actually draws.
 */
const FILL = (page) => page.evaluate(() => {
  const port = {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
  }
  // Reach the mounted panel through the handle the page publishes.
  const mounted = window.__dshPanel
  if (mounted === undefined) return 'no panel handle'
  const app = mounted.app
  const long = '这是一段比较长的正文，用来占用多行空间。'.repeat(6)
  const now = Date.now()
  app.handleMessage({
    type: 'state',
    state: {
      enabled: true,
      bridge: 'connected',
      caps: { snapshotMaxChars: 32000, maxInteractiveItems: 60 },
      affinity: {
        revision: 1, status: 'bound', pinned: true,
        controlled: { tabId: 1, title: 'Example', url: 'https://example.com', windowId: 1, index: 0 },
        active: { tabId: 1, title: 'Example', url: 'https://example.com', windowId: 1, index: 0 },
      },
      approvals: [],
      settings: {
        bridgeUrl: '', token: '', sharePageContent: 'auto', unrestrictedBrowserAccess: false,
        trustedActionOrigins: [], approvalNotifications: true, autoOpenPanel: true,
        tabSwitch: 'ask', sessionScope: 'fresh', pinnedSessionId: null, readWidth: 640,
      },
      sessionTrustedOrigins: [],
      activity: [],
      session: { id: 's1', turn: 'idle', pendingPrompt: false },
      timeline: [
        { id: 'r1', kind: 'request', text: '帮我把这个页面的标题读出来' },
        { id: 's1', kind: 'step', text: 'browser_snapshot', tool: 'browser_snapshot', state: 'done', at: now },
        { id: 'a1', kind: 'assistant', text: long },
        { id: 'r2', kind: 'request', text: '再点一下那个按钮' },
        { id: 's2', kind: 'step', text: 'browser_click', tool: 'browser_click', state: 'done', at: now },
        { id: 'a2', kind: 'assistant', text: long + long },
        { id: 's3', kind: 'step', text: 'browser_get_text', tool: 'browser_get_text', state: 'done', at: now },
        { id: 'a3', kind: 'assistant', text: long },
      ],
      policy: { openPagesForUser: true },
      replaced: false,
    },
  })
  return 'filled'
})

const SIZES = [
  ['very narrow', 280, 700],
  ['narrow', 320, 800],
  ['typical narrow', 360, 900],
  ['default side panel', 400, 900],
  ['comfortable', 500, 1000],
  ['wide panel', 700, 1000],
  ['very wide', 1000, 1000],
  ['short', 400, 420],
  ['very short', 400, 300],
  ['tiny', 280, 260],
  ['tall narrow laptop', 320, 1400],
]

const executablePath = await findChromiumExecutable()
if (executablePath === undefined) {
  console.log('no Chrome/Chromium found; skipping the layout measurement')
  process.exit(0)
}

const browser = await chromium.launch({ executablePath, headless: true })

const problems = []
for (const [label, width, height] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.setContent(page_html, { waitUntil: 'load' })
  await page.waitForTimeout(120)

  const filled = await FILL(page)
  await page.waitForTimeout(120)

  const measured = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }
    }
    const root = document.getElementById('control-root')
    const transcript = document.querySelector('.transcript')
    return {
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight,
      rootH: root === null ? null : Math.round(root.getBoundingClientRect().height),
      app: pick('.app'),
      header: pick('.header'),
      transcript: pick('.transcript'),
      composer: pick('.composer'),
      composerInput: pick('.composer__input'),
      // Proof the panel actually drew the fed conversation, so a passing
      // measurement cannot be an empty page quietly agreeing with itself.
      rows: document.querySelectorAll('.transcript__inner > *').length,
      scrolls: transcript === null ? false : transcript.scrollHeight > transcript.clientHeight + 1,
    }
  })

  // Open settings and measure the sheet too.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes('设置'))
      ?? document.querySelector('.header__actions button')
    btn?.click()
  })
  await page.waitForTimeout(120)
  const sheet = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
    }
    return { sheet: pick('.sheet'), body: pick('.sheet__body') }
  })

  const flags = []
  if (filled !== 'filled') flags.push(`could not feed the panel: ${filled}`)
  if (measured.rows < 5) flags.push(`panel drew only ${measured.rows} rows`)
  if (measured.docScrollW > measured.docClientW + 1) flags.push(`horizontal overflow ${measured.docScrollW}>${measured.docClientW}`)
  if (measured.rootH !== null && Math.abs(measured.rootH - height) > 1) flags.push(`root height ${measured.rootH} != ${height}`)
  if (measured.composer && measured.composer.bottom > height + 1) flags.push(`composer below viewport (${measured.composer.bottom})`)
  if (measured.transcript && measured.transcript.h < 1) flags.push('transcript has no height')
  if (sheet.sheet && Math.abs(sheet.sheet.h - height) > 1) flags.push(`sheet height ${sheet.sheet.h} != ${height}`)
  if (sheet.body && sheet.body.bottom > height + 1) flags.push(`sheet body past viewport (${sheet.body.bottom})`)

  const mark = flags.length === 0 ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${label.padEnd(22)} ${String(width).padStart(4)}x${String(height).padEnd(5)}`
    + ` rows=${String(measured.rows).padStart(2)} scroll=${measured.scrolls ? 'y' : 'n'}`
    + ` transcript=${String(measured.transcript?.h ?? '-').padStart(4)} composerBottom=${measured.composer?.bottom ?? '-'} sheet=${sheet.sheet?.h ?? '-'}`)
  for (const f of flags) {
    console.log(`       -> ${f}`)
    problems.push(`${label} ${width}x${height}: ${f}`)
  }
  await page.close()
}

await browser.close()

/*
 * Composer invariants.
 *
 * The input is the one control that changes height while the user types, so it
 * is where a layout regression hides. Each check below corresponds to a real
 * defect that shipped: a field taller than its text, a scrollbar on a short
 * draft, and an input sized from a fraction of the window.
 */
const composer = await chromium.launch({ executablePath, headless: true })
const cpage = await composer.newPage({ viewport: { width: 400, height: 900 } })
await cpage.setContent(page_html, { waitUntil: 'load' })
await cpage.waitForTimeout(150)

const composerProblems = []
const measureComposer = async (text) => {
  await cpage.evaluate((value) => {
    const input = document.querySelector('.composer__input')
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
  await cpage.waitForTimeout(40)
  return cpage.evaluate(() => {
    const input = document.querySelector('.composer__input')
    const box = document.querySelector('.composer__box')
    const btn = box.querySelector('button')
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 1
    const r = (el) => el.getBoundingClientRect()
    return {
      inputH: Math.round(r(input).height),
      boxH: Math.round(r(box).height),
      lineHeight,
      // Bottom of the field against the bottom of the button: level means the
      // button sits on the last line rather than below empty space.
      skew: Math.round(r(input).bottom - r(btn).bottom),
      scrolls: input.scrollHeight > input.clientHeight + 1,
    }
  })
}

const empty = await measureComposer('')
if (Math.abs(empty.inputH - empty.lineHeight) > 2) {
  composerProblems.push(`empty input is ${empty.inputH}px, not one line (${empty.lineHeight}px)`)
}
if (empty.scrolls) composerProblems.push('empty input shows a scrollbar')

for (const [label, text] of [['2 chars', '你好'], ['one line', '帮我打开这个页面']]) {
  const m = await measureComposer(text)
  if (Math.abs(m.inputH - m.lineHeight) > 2) composerProblems.push(`${label}: input is ${m.inputH}px, not one line`)
  if (m.scrolls) composerProblems.push(`${label}: input shows a scrollbar`)
  if (Math.abs(m.skew) > 3) composerProblems.push(`${label}: button is ${m.skew}px off the last line`)
}

const twoLines = await measureComposer('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十')
if (Math.abs(twoLines.inputH - twoLines.lineHeight * 2) > 3) {
  composerProblems.push(`two-line draft measures ${twoLines.inputH}px, expected about ${twoLines.lineHeight * 2}px`)
}
if (Math.abs(twoLines.skew) > 3) composerProblems.push(`two-line draft: button is ${twoLines.skew}px off the last line`)

// The cap must not follow the window: that is what made the same draft take a
// different share of the screen on different monitors.
const tall = await measureComposer('x'.repeat(4000))
const other = await composer.newPage({ viewport: { width: 400, height: 1400 } })
await other.setContent(page_html, { waitUntil: 'load' })
await other.waitForTimeout(150)
await other.evaluate(() => {
  const input = document.querySelector('.composer__input')
  input.value = 'x'.repeat(4000)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await other.waitForTimeout(60)
const tallOnBigWindow = await other.evaluate(() => Math.round(document.querySelector('.composer__input').getBoundingClientRect().height))
if (tall.inputH !== tallOnBigWindow) {
  composerProblems.push(`input height depends on the window: ${tall.inputH}px vs ${tallOnBigWindow}px`)
}
if (tall.inputH > 200) composerProblems.push(`input grew to ${tall.inputH}px, which crowds out the conversation`)
if (!tall.scrolls) composerProblems.push('a very long draft should scroll rather than keep growing')

await other.close()
await composer.close()

/*
 * Packaging integrity.
 *
 * Both checks below caught a real defect on the way to the first public release,
 * and neither is visible from running the extension locally.
 */
const packagingProblems = []

// 1. The PowerShell installer must carry a UTF-8 BOM. Windows PowerShell 5.1
//    otherwise decodes it with the machine's ANSI codepage and every Chinese
//    line becomes unreadable — while the script still runs, so it fails silently
//    and only for the user reading the output. An ordinary UTF-8 write drops the
//    mark, which is exactly how it went missing.
const ps1 = readFileSync(join(ROOT, 'scripts', 'install.ps1'))
const hasBom = ps1[0] === 0xef && ps1[1] === 0xbb && ps1[2] === 0xbf
if (!hasBom) {
  packagingProblems.push('scripts/install.ps1 has no UTF-8 BOM: Windows PowerShell 5.1 will render its Chinese output as mojibake')
}

// 2. A published repository must not still tell people to download from a
//    placeholder. Left in, the one-line installer 404s or fetches upstream.
//
//    The literal is assembled rather than written out, so the very search this
//    performs cannot rewrite its own needle: a bulk replace of the placeholder
//    across the repository turned this constant into the real name once, which
//    made the check report the correct value as missing.
const PLACEHOLDER = ['REPLACE', 'WITH', 'REPO'].join('_')
const toCheck = [
  'README.md', 'README.zh.md', 'scripts/install.sh', 'scripts/install.ps1',
  'packages/browser/bridge-browser/README.md', 'packages/browser/bridge-browser/README.zh.md',
]
const unreplaced = []
for (const file of toCheck) {
  try {
    const count = readFileSync(join(ROOT, file), 'utf8').split(PLACEHOLDER).length - 1
    if (count > 0) unreplaced.push(`${file} (${count})`)
  } catch { /* absent is fine */ }
}

console.log('')
console.log(`composer: empty=${empty.inputH}px (one line is ${empty.lineHeight}px) twoLines=${twoLines.inputH}px capped=${tall.inputH}px`)
for (const p of composerProblems) {
  console.log(`  FAIL ${p}`)
  problems.push(`composer: ${p}`)
}

console.log(`packaging: install.ps1 BOM=${hasBom ? 'present' : 'MISSING'}`)
if (unreplaced.length > 0) {
  // Reported, not failed: the placeholder is expected until the repository name
  // is known and substituted.
  console.log(`  NOTE still containing ${PLACEHOLDER}: ${unreplaced.join(', ')}`)
  console.log('  Replace these before publishing.')
}
for (const p of packagingProblems) {
  console.log(`  FAIL ${p}`)
  problems.push(`packaging: ${p}`)
}

console.log('')
console.log(problems.length === 0 ? 'all sizes laid out correctly' : `${problems.length} problem(s) found`)
