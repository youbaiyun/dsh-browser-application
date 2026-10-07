import { describe, expect, it } from 'vitest'
import { extensionOrigin, isLoopbackAddress, isTrustedExtensionOrigin } from '../src/server.ts'

/**
 * The two pure predicates behind the token-free loopback path.
 *
 * They are unit-tested separately from the socket tests in `server.spec.ts` so a
 * future edit to the predicate fails here with a precise reason, not only as a
 * connection that unexpectedly authenticated.
 */
const EXT_ID = 'test-extension-id'
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`
/** Another extension on the same machine: same scheme, different identity. */
const OTHER_EXT_ORIGIN = 'chrome-extension://some-other-installed-extension'

describe('isLoopbackAddress', () => {
  it('accepts every IPv4/IPv6 loopback spelling and nothing else', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address)).toBe(true)
    }
    for (const address of [undefined, '', '127.0.0.2', '192.168.1.5', '::2', 'localhost']) {
      expect(isLoopbackAddress(address as string | undefined)).toBe(false)
    }
  })
})

describe('isTrustedExtensionOrigin', () => {
  it('matches one named extension and rejects the scheme alone', () => {
    expect(extensionOrigin(EXT_ID)).toBe(EXT_ORIGIN)
    expect(isTrustedExtensionOrigin(EXT_ORIGIN, EXT_ID)).toBe(true)
    // The whole point of the predicate: a different extension is not this one.
    expect(isTrustedExtensionOrigin(OTHER_EXT_ORIGIN, EXT_ID)).toBe(false)
    expect(isTrustedExtensionOrigin('chrome-extension://', EXT_ID)).toBe(false)
    expect(isTrustedExtensionOrigin(undefined, EXT_ID)).toBe(false)
    // A string that only starts like the real origin must not pass either.
    expect(isTrustedExtensionOrigin(`${EXT_ORIGIN}.evil`, EXT_ID)).toBe(false)
  })

  it('trusts nothing when the configured id is empty', () => {
    expect(isTrustedExtensionOrigin(EXT_ORIGIN, '')).toBe(false)
  })
})
