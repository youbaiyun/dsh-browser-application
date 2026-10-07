/**
 * Print the Chrome extension id that the built manifest produces.
 *
 * Chrome derives an unpacked/store id from the manifest's `key` (the first 16
 * bytes of the SHA-256 of the DER public key, mapped 0-9a-f → a-p). The bridge
 * binds its token-free loopback path to exactly that id, so the two must agree:
 * this is the check that keeps `DEFAULT_EXTENSION_ID` in
 * `packages/bridge/src/index.ts` honest instead of a remembered string.
 *
 * Usage: node extension/scripts/extension-id.mjs [dist|dist-firefox]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = process.argv[2] ?? 'dist'
const manifestPath = resolve(import.meta.dirname, '..', dir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} is missing — build that target first`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (typeof manifest.key !== 'string' || manifest.key === '') {
  console.error('this manifest declares no `key`, so Chrome assigns a path-derived id (not comparable)')
  process.exit(1)
}

const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
const id = [...digest.slice(0, 32)].map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('')
console.log(id)
