import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/**
 * Rewrite Vite's asset URLs to be relative to `control/index.html`'s own folder.
 *
 * Vite defaults to root-absolute URLs and its `base` option cannot express
 * "relative to this nested html file": `base: './'` emits `../control/...` for
 * this entry, which escapes to `dist/` and 404s. The page is loaded as
 * `control/index.html` under both `chrome-extension://` and `moz-extension://`,
 * so `./assets/...` is the only form that resolves in both.
 */
const relativeControlAssets: Plugin = {
  name: 'dsh-relative-control-assets',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html: string): string {
      return html.replaceAll('="/control/assets/', '="./assets/').replaceAll('="control/assets/', '="./assets/')
    },
  },
}

/** Control strip: dependency-free vanilla DOM page (html entry). */
export default defineConfig({
  plugins: [...sharedPlugins, relativeControlAssets],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'control/index.html'),
      output: {
        entryFileNames: 'control/assets/[name].js',
        chunkFileNames: 'control/assets/[name]-[hash].js',
        assetFileNames: 'control/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
