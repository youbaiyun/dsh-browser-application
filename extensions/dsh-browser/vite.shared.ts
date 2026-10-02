import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
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

export const outDir = resolve(import.meta.dirname, browserTarget === 'firefox' ? 'dist-firefox' : 'dist')

/** Copy manifest, locale catalogs, and icons into the target's outDir. */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    copyFileSync(resolve(import.meta.dirname, targetManifest), resolve(outDir, 'manifest.json'))
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
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
