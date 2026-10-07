import { copyManifest, outDir, targetBuild } from './vite.shared.ts'

/** Content script: classic script (content scripts cannot be ES modules). */
export default targetBuild('src/content/index.ts', 'iife', 'content.js', false)

export { copyManifest, outDir }
