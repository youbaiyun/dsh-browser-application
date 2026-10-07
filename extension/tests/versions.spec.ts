/**
 * @vitest-environment jsdom
 *
 * The suite's shared setup stubs `Element.prototype` and `CSS`, so every spec
 * file needs the DOM environment whether or not it touches the DOM — including
 * this one, which only reads JSON.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * One version for the whole tree.
 *
 * The repository's headline claim is that the root package, the extension
 * package, and both manifests always agree, so a plugin list, a manifest and a
 * release tag cannot disagree. It has drifted before (the manifests carried
 * 0.37.1 while the tree said otherwise), so the claim is asserted here rather
 * than restated in prose.
 *
 * Plain file reads, on purpose: importing a `.json` here would pull in the
 * suite's jsdom setup, which needs `Element` and does not exist under the node
 * environment.
 */
const extensionDir = resolve(import.meta.dirname, '..')

function readVersion(relativePath: string): unknown {
  const parsed = JSON.parse(readFileSync(resolve(extensionDir, relativePath), 'utf8')) as { version?: unknown }
  return parsed.version
}

describe('version agreement', () => {
  it('keeps the extension package and both manifests on one version', () => {
    const packageVersion = readVersion('package.json')
    expect(packageVersion).toEqual(expect.any(String))
    expect(readVersion('manifest.json')).toBe(packageVersion)
    expect(readVersion('manifest.firefox.json')).toBe(packageVersion)
  })

  it('keeps the root package and the protocol package on the same version', () => {
    // The protocol has no manifest of its own, but it is one of the four packages
    // the README says move together.
    expect(readVersion('package.json')).toBe(readVersion('../package.json'))
    expect(readVersion('../packages/protocol/package.json')).toBe(readVersion('../package.json'))
    expect(readVersion('../packages/bridge/package.json')).toBe(readVersion('../package.json'))
    // The benchmark harness is the fourth package. It was missing from this test, which is
    // why it was the one a version bump could quietly leave behind.
    expect(readVersion('../benchmark/package.json')).toBe(readVersion('../package.json'))
  })
})
