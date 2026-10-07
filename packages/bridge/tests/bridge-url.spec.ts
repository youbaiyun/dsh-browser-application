import { describe, expect, it } from 'vitest'
import { bridgeWsUrlFromLocation, resolveBridgeWsUrl } from '../src/bridge-url.ts'

const loc = (over: Record<string, string> = {}) => ({
  protocol: 'http:',
  hostname: 'localhost',
  port: '3080',
  host: 'localhost:3080',
  ...over,
})

describe('bridgeWsUrlFromLocation', () => {
  it('normalizes localhost to 127.0.0.1 and appends the bridge path', () => {
    expect(bridgeWsUrlFromLocation(loc())).toBe('ws://127.0.0.1:3080/ext/bridge')
  })

  it('uses wss for https and drops an empty port', () => {
    expect(bridgeWsUrlFromLocation(loc({ protocol: 'https:', hostname: 'example.com', port: '' })))
      .toBe('wss://example.com/ext/bridge')
  })
})

describe('resolveBridgeWsUrl', () => {
  it('prefers a usable discovery response', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ wsUrl: 'ws://127.0.0.1:9999/ext/bridge' }),
    })) as unknown as typeof fetch
    expect(await resolveBridgeWsUrl(loc(), fakeFetch)).toBe('ws://127.0.0.1:9999/ext/bridge')
  })

  it('falls back to the reconstructed URL when discovery fails', async () => {
    const fakeFetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await resolveBridgeWsUrl(loc(), fakeFetch)).toBe('ws://127.0.0.1:3080/ext/bridge')
  })
})
