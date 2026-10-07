// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    // The real bridge always answers `hello` with a policy, so the fake one
    // does too; a fixture that omits it is rejected by the frame parser and the
    // connection silently never authenticates.
    const delivered = isRecord(frame) && frame.t === 'hello.ok' && frame.policy === undefined
      ? { ...frame, policy: { openPagesForUser: true } }
      : frame
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(delivered) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient address recovery', () => {
  const sinks = { onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} }

  it('re-resolves the address once the current one looks permanently gone', async () => {
    // The desktop app picks its port at startup, so a restart can land
    // elsewhere. Without this the retry loop probes the dead port forever and
    // the keepalive refuses to intervene while the state is `reconnecting`.
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const probe = vi.fn(async (url: string) => url.includes(':3081'))
    const rediscover = vi.fn(async () => 'ws://127.0.0.1:3081/ext/bridge')
    const client = new BridgeClient(sinks, probe, () => true, rediscover)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(rediscover).toHaveBeenCalled()
    // The moved address is what actually gets dialled.
    expect(probe).toHaveBeenCalledWith('ws://127.0.0.1:3081/ext/bridge')
    expect(FakeWebSocket.instances.at(-1)?.url).toBe('ws://127.0.0.1:3081/ext/bridge')
    client.stop()
  })

  it('asks only once per threshold while the address has not moved', async () => {
    // A bridge that is merely down must not turn into a discovery loop: the
    // probe would hammer six ports on every retry.
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const rediscover = vi.fn(async () => 'ws://127.0.0.1:3080/ext/bridge')
    const client = new BridgeClient(sinks, async () => false, () => true, rediscover)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    // Two failures: below the threshold, so discovery has not run at all.
    await vi.advanceTimersByTimeAsync(600)
    expect(rediscover).not.toHaveBeenCalled()

    // Past the threshold, discovery runs — but the unchanged answer is not
    // treated as a move, so the backoff keeps growing instead of resetting.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(rediscover.mock.calls.length).toBeLessThanOrEqual(2)
    client.stop()
  })

  it('leaves a manually entered address alone', async () => {
    // The background only supplies the callback for auto-discovered addresses;
    // this pins that a typed address is never silently replaced.
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const probe = vi.fn(async (_url: string) => false)
    const client = new BridgeClient(sinks, probe, () => true, undefined)

    client.start('ws://127.0.0.1:9/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(5_000)

    const probed = probe.mock.calls.map((call) => call[0])
    expect(probed.length).toBeGreaterThan(0)
    expect(probed.every((url) => url === 'ws://127.0.0.1:9/ext/bridge')).toBe(true)
    client.stop()
  })
})

describe('BridgeClient connection probe', () => {
  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
