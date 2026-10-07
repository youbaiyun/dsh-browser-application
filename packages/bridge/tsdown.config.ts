import { defineConfig } from 'tsdown'

/**
 * The bridge ships two runtime entries: the plugin (index) and its invariant
 * companion. The wire protocol now lives in `@dsh-browser/protocol` and is
 * inlined by the bundler, so it is no longer a published entry of this package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
