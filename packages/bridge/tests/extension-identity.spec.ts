import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTENSION_IDS } from '../src/index.ts'
import { isTrustedExtensionOrigin } from '../src/server.ts'

/**
 * The bridge skips its bearer token for exactly one loopback Origin, and that id
 * is a constant here while the real identity lives in the extension's manifest
 * `key`. Nothing else connects the two, so dropping or replacing the key in a
 * future build would silently break the token-free path — the extension would be
 * refused with close code 4002 and the panel would simply say "not connected".
 *
 * The extension is a sibling package: a standalone install of this plugin from
 * npm has no `extension/` next to it, so the check skips there rather than
 * failing for a file that was never shipped.
 */
const manifestPath = resolve(import.meta.dirname, '../../../extension/manifest.json')

/** Chrome: SHA-256 of the DER public key, first 16 bytes, hex mapped 0-9a-f → a-p. */
function chromeExtensionId(manifestKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest('hex')
  return [...digest.slice(0, 32)].map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('')
}

describe.skipIf(!existsSync(manifestPath))('extension identity', () => {
  it('derives the default token-free id from the extension manifest key', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: unknown }
    expect(manifest.key).toEqual(expect.any(String))
    expect(chromeExtensionId(manifest.key as string)).toBe(DEFAULT_EXTENSION_IDS[0])
  })

  it('keeps the launcher\'s install-detection name equal to that id', async () => {
    // `browser-launch.ts` cannot import this package's entry point (it would be a
    // cycle), so it carries its own copy for checking `<profile>/Extensions/<id>`.
    // A drift there would make the bridge report "not installed" for an install
    // that is present — the exact message the user relies on to decide what to do.
    const launcher = await import('../src/browser-launch.ts')
    const source = readFileSync(resolve(import.meta.dirname, '../src/browser-launch.ts'), 'utf8')
    expect(source).toContain(`const EXTENSION_DIRECTORY_NAME = '${DEFAULT_EXTENSION_IDS[0]}'`)
    expect(launcher).toBeDefined()
  })
})

describe('the token-free origin allowlist', () => {
  const dev = 'kdhkdgfcinfkmogifamoapmheihhcjfk'
  const store = 'agipnijjkpomaannkjkjliggoffdiaf'

  it('accepts every named id, so a store install needs no configuration', () => {
    // One build has two possible ids: a development load is pinned by the manifest
    // `key`, and the Web Store refuses a manifest carrying that key and assigns its
    // own. Both have to work, or a store user must paste a token in by hand.
    const ids = `${dev},${store}`
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ids)).toBe(true)
    expect(isTrustedExtensionOrigin(`chrome-extension://${store}`, ids)).toBe(true)
  })

  it('still refuses everything else, which is the whole point of the list', () => {
    // Without this the bypass is a prefix match on `chrome-extension://`, i.e. every
    // other extension installed on the machine, and any local process that sets the
    // header.
    const ids = `${dev},${store}`
    expect(isTrustedExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ids)).toBe(false)
    expect(isTrustedExtensionOrigin(`moz-extension://${dev}`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin('chrome-extension://', ids)).toBe(false)
    // A prefix or a truncation of a real id is not a real id.
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}x`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev.slice(0, -1)}`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin(undefined, ids)).toBe(false)
  })

  it('treats empty, blank and comma-only configuration as "no id configured"', () => {
    // The documented way to require the token everywhere. A trailing comma or stray
    // space must be harmless rather than silently unconfiguring the bridge, and an
    // empty entry must not match an empty origin.
    for (const ids of ['', '   ', ',', ' , ']) {
      expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ids)).toBe(false)
    }
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ` ${dev} , `)).toBe(true)
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, `${dev},`)).toBe(true)
  })

  it("defaults to naming both of this project's ids", () => {
    expect(DEFAULT_EXTENSION_IDS).toContain(dev)
    expect(DEFAULT_EXTENSION_IDS).toContain(store)
  })
})
