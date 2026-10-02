/**
 * Warn when a build artifact is older than the source that produces it.
 *
 * The desktop app loads `lib/index.js`, not `src/`, so editing the plugin
 * without rebuilding changes nothing that runs. The failure looks like "my edit
 * did nothing" and costs a restart to discover, which is exactly the kind of
 * silent mismatch this catches.
 *
 * Deliberately a warning, not a gate: a fresh checkout has source newer than any
 * artifact, and blocking there would be wrong. A wide window is used so that a
 * clone-then-install never warns, while an edit-then-run always does.
 *
 * Usage: node scripts/check-build-freshness.mjs [--strict]
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Only flag an artifact this far behind. Wide enough that a clone followed by an
 * install does not warn (all source files share the checkout timestamp, while
 * the artifacts an install produces land minutes later), and narrow enough that
 * a real edit-then-run is always reported.
 */
const WINDOW_MS = 15 * 60 * 1000

const TARGETS = [
  {
    label: 'bridge plugin',
    // Every directory that feeds lib/. The panel lives in control/, so scanning
    // only src/ would miss the most frequently edited files in this repository.
    src: ['packages/browser/bridge-browser/src'],
    artifacts: ['packages/browser/bridge-browser/lib/index.js'],
    hint: 'pnpm --filter @yuxianglin/dsh-bridge-browser run build',
    consequence: 'the desktop app loads lib/, so your source edit is not running',
  },
  {
    label: 'extension',
    src: ['extensions/dsh-browser/src', 'extensions/dsh-browser/control'],
    artifacts: ['extensions/dsh-browser/dist/background.js'],
    hint: 'pnpm --filter dsh-browser-extension run build',
    consequence: 'the browser loads the built extension, so reload it after building',
  },
]

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) out.push(full)
  }
  return out
}

const newest = (files) => {
  let best = { file: null, mtime: 0 }
  for (const file of files) {
    const { mtimeMs } = statSync(file)
    if (mtimeMs > best.mtime) best = { file, mtime: mtimeMs }
  }
  return best
}

const stale = []
for (const target of TARGETS) {
  const files = []
  for (const dir of target.src) {
    const full = join(ROOT, dir)
    if (existsSync(full)) walk(full, files)
  }
  if (files.length === 0) continue
  const source = newest(files)

  for (const artifact of target.artifacts) {
    const artifactPath = join(ROOT, artifact)
    const missing = !existsSync(artifactPath)
    // A missing artifact is the install path's business, not a stale build.
    if (missing) continue
    const artifactMtime = statSync(artifactPath).mtimeMs
    if (source.mtime - artifactMtime <= WINDOW_MS) continue
    stale.push({
      label: target.label,
      artifact,
      source: relative(ROOT, source.file).replace(/\\/g, '/'),
      behindMinutes: Math.round((source.mtime - artifactMtime) / 60_000),
      hint: target.hint,
      consequence: target.consequence,
    })
  }
}

if (stale.length === 0) {
  console.log('build freshness: ok')
  process.exit(0)
}

console.error('\n  STALE BUILD — the running code is older than the source:\n')
for (const item of stale) {
  console.error(`  ${item.label}: ${item.artifact}`)
  console.error(`    newest source : ${item.source}`)
  console.error(`    artifact is   : ~${item.behindMinutes} min older`)
  console.error(`    why it matters: ${item.consequence}`)
  console.error(`    fix           : ${item.hint}\n`)
}
console.error('  A source edit does nothing until this is rebuilt.\n')

if (process.argv.includes('--strict')) process.exit(1)
process.exit(0)
