import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

/**
 * Shared build plumbing for the extension's three targets (background ES
 * service worker, iife content script, control-strip popup page). Each target
 * has its own config file; scripts/build.mjs runs them sequentially into one
 * dist/.
 */

/**
 * Build target: `chrome` (default) or `firefox` (set EXT_TARGET=firefox or
 * pass --firefox to scripts/build.mjs). Each target gets its own manifest and
 * output directory so both builds can coexist.
 */
export const browserTarget = process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'
export const targetManifest = browserTarget === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

const storeTarget = process.env.EXT_STORE === '1'
export const outDir = resolve(
  import.meta.dirname,
  storeTarget
    ? (browserTarget === 'firefox' ? 'dist-firefox-store' : 'dist-store')
    : (browserTarget === 'firefox' ? 'dist-firefox' : 'dist'),
)

/**
 * The manifest a store will accept.
 *
 * The repository's manifests carry a `key`, which pins the extension id — the
 * bridge's token-free loopback path is bound to that exact id, so a development
 * build needs it. A store refuses it outright: "清单文件中不得包含 key 字段"
 * (the Chrome Web Store's own wording). The store assigns the id instead, so the
 * `key` is dropped and nothing else is touched.
 */
function manifestForOutput(): string {
  const text = readFileSync(resolve(import.meta.dirname, targetManifest), 'utf8')
  if (!storeTarget) return text
  const parsed = JSON.parse(text) as Record<string, unknown>
  delete parsed.key
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/** Copy manifest, locale catalogs, icons, and the licence into the target's outDir. */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'manifest.json'), manifestForOutput(), 'utf8')
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
    // The licence travels with the build, not only with the repository: a packaged
    // extension is a distribution of the software, and MIT requires the notice and
    // the permission text to be included with copies of it. The repo root is one
    // level up from this package.
    copyFileSync(resolve(import.meta.dirname, '..', 'LICENSE'), resolve(outDir, 'LICENSE'))
  },
}

/** Shared plugins for every target: tsconfig paths (plugin protocol source,
 * SDK-like source consumption) plus the manifest copy. */
export const sharedPlugins = [tsconfigPaths({ projects: ['./tsconfig.json'] }), copyManifest]

/** Shared build options for the non-panel targets. */
export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    define: {
      'import.meta.env.EXT_TARGET': JSON.stringify(browserTarget),
    },
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: sharedPlugins,
  })
}
