/**
 * Build all three extension targets sequentially into dist/ (or dist-firefox/
 * with --firefox):
 * background (es|iife) → content (iife) → control (html popup). The first
 * target cleans the output; the later ones append. Pass --watch for dev
 * rebuilds.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox switches the manifest and background bundle for the Firefox build.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}

// --store builds into dist-store/ (or dist-firefox-store/) with the manifest's
// `key` removed, which is what a store requires: the repository manifests carry
// one to pin the extension id, and the Chrome Web Store refuses an upload that
// has it. The id a store assigns instead is what the bridge must be told.
if (process.argv.includes('--store')) {
  process.env.EXT_STORE = '1'
}

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.control.config.ts',
]

/**
 * Run Vite through Node, not through a shim.
 *
 * `vite.cmd` cannot be spawned without `shell: true` on current Node — Windows
 * returns `EINVAL`, and `shell: true` with an argument list is deprecated
 * (DEP0190) because the arguments get concatenated rather than escaped. Naming
 * Vite's JavaScript entry point and running it with this same Node removes the
 * question: no shell, no shim, no escaping, identical on every platform. Same
 * trick as `benchmark/lib/browser-install.mjs`, and for the same reason.
 */
function viteCommand() {
  const entry = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (existsSync(entry)) return { command: process.execPath, prefix: [entry] }
  // A hoisted install can put it somewhere else; fall back to PATH.
  return { command: process.platform === 'win32' ? 'vite.cmd' : 'vite', prefix: [] }
}

const { command, prefix } = viteCommand()

if (watch) {
  // 三个 watcher 并行启动（串行时第一个永不停机，后面的永远不会启动）。
  const children = configs.map((config) => spawn(command, [...prefix, 'build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
} else {
  for (const config of configs) {
    const result = spawnSync(command, [...prefix, 'build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
    })
    // A spawn that never started (missing binary, EINVAL) has `status === null`
    // and reports the reason only in `error`; without this the build exited 1 with
    // no output at all, which is the least debuggable failure there is.
    if (result.error !== undefined) {
      console.error(`Could not start the Vite build: ${result.error.message}`)
      process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
