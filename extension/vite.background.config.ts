import { browserTarget, copyManifest, outDir, targetBuild } from './vite.shared.ts'

/**
 * Background: Chrome loads an ES-module service worker (`"type": "module"`);
 * Firefox loads classic scripts in an event page, so the same entry is bundled
 * as an IIFE there. Keep the output filename identical (background.js).
 */
export default targetBuild(
  'src/background/index.ts',
  browserTarget === 'firefox' ? 'iife' : 'es',
  'background.js',
  true,
)

export { copyManifest, outDir }
