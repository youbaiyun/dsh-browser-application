/**
 * Generate the extension's whale icons from the real DeepSeek mark.
 *
 * The previous version drew the whale from ellipses and polygons — the old script
 * admitted as much, calling the result "a whale at a glance". It was not the
 * DeepSeek whale: one eye became a plain hole, the other disappeared, and the
 * belly cut-out was a polygon instead of a curve. A logo approximated by hand is
 * not the logo.
 *
 * Two published vectors were compared by rendering both. The full-lockup one
 * (`logos:deepseek`, viewBox 0 0 512 109) is the whale plus the "deepseek"
 * wordmark, so scaling it to an icon size shrinks the whale into a corner and
 * blurs it. The square one (`@lobehub/icons-static-svg`) is the mark alone,
 * already normalised to a 24×24 box, and it holds its eye and belly at 16 px.
 *
 * The source is fetched at build time rather than pasted in, so the geometry is
 * never retyped by hand — a transcription slip would reintroduce exactly the
 * problem this replaced. Fetching needs the network; the path is cached next to
 * this script so a build without one still works.
 *
 * Usage:
 *     node scripts/make-whale-icons.mjs <out-dir>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, findChromiumExecutable } from '../benchmark/lib/chromium.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, 'deepseek-whale.path')

const SOURCE = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/deepseek.svg'
const SIZES = [16, 32, 48, 128, 256]

/** Pull the path out of the source SVG, or fall back to the cached copy. */
const loadPath = async () => {
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000) })
    if (res.ok) {
      const svg = await res.text()
      const d = /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1]
      // A whale mark is one path with real curve commands; anything else means
      // the response was not the artwork (a 404 page, a redirect, a proxy notice).
      if (d !== undefined && /[Cc]/.test(d) && d.length > 800 && !/[<>]/.test(d)) {
        writeFileSync(CACHE, d)
        console.log('  source: fetched from the icon set')
        return d
      }
      console.log('  source: response was not the expected artwork')
    } else {
      console.log(`  source: HTTP ${res.status}`)
    }
  } catch (error) {
    console.log(`  source: unavailable (${error.message})`)
  }
  if (!existsSync(CACHE)) {
    console.error('no cached path and the source is unreachable')
    process.exit(1)
  }
  console.log('  source: cached copy')
  return readFileSync(CACHE, 'utf8')
}

const executablePath = await findChromiumExecutable()
if (executablePath === undefined) {
  console.error('no Chrome/Chromium found; cannot rasterise')
  process.exit(1)
}

const d = await loadPath()
console.log(`  path: ${d.length} characters`)

const browser = await chromium.launch({ executablePath, headless: true })

/**
 * Render one size with a transparent background.
 *
 * The viewBox is inset so the mark is not flush against the toolbar edges, and
 * the inset grows as the icon shrinks: the whale has fine detail around the eye
 * and belly, and at 16 px those strokes are about one device pixel, so crowding
 * them against the border makes the whole thing read as a smudge. Fewer pixels
 * for the mark is the better trade at the small end.
 */
const INSET = { 16: 0.82, 32: 0.88, 48: 0.92, 128: 0.94, 256: 0.96 }
const render = async (size) => {
  const scale = INSET[size] ?? 0.92
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <g transform="translate(12 12) scale(${scale}) translate(-12 -12)">
    <path fill="#000" d="${d}"/>
  </g>
</svg></body></html>`
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  await page.setContent(html, { waitUntil: 'load' })
  await page.waitForTimeout(60)
  const shot = await page.screenshot({ omitBackground: true })
  await page.close()
  return shot
}

const out = process.argv[2] ?? '.'
mkdirSync(out, { recursive: true })
for (const size of SIZES) {
  writeFileSync(join(out, `icon${size}.png`), await render(size))
}
await browser.close()

// The panel references a 256 px copy; keep it in step with the rest.
writeFileSync(join(out, 'deepseek-256.png'), await (async () => {
  const b = await chromium.launch({ executablePath, headless: true })
  const p = await b.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
  await p.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24"><path fill="#000" d="${d}"/></svg>
</body></html>`, { waitUntil: 'load' })
  await p.waitForTimeout(60)
  const shot = await p.screenshot({ omitBackground: true })
  await b.close()
  return shot
})())

console.log(`  wrote icon{${SIZES.join(',')}}.png and deepseek-256.png to ${out}`)
