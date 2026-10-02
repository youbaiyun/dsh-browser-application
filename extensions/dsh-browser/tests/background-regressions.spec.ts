// @vitest-environment jsdom

/**
 * Regression tests for the defects found while rewriting the worker.
 *
 * Each case here reproduces a real bug from that rewrite, so a future refactor
 * that reintroduces one of them fails loudly instead of shipping:
 *
 *  1. the keepalive reclaiming a bridge that handed its slot to another browser,
 *  2. turning unrestricted access off leaving an already-approved call running,
 *  3. two settings writes racing so the earlier one lands last,
 *  4. a timed-out tab rebind still moving the controlled tab afterwards,
 *  5. typed text and full URLs accumulating in the control strip's history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'
const REBIND_TIMEOUT_MS = 10_000

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
  }

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

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of [...listeners]) listener(...args) },
  }
}

function htmlTab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

function controlPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: CONTROL_PORT_NAME, postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

interface ControlMessageLike {
  type?: string
  state?: ControlState
  entry?: { id?: string; name?: string; summary?: string; state?: string }
  id?: string
  ok?: boolean
  error?: string
}

function sentMessages(postMessage: ReturnType<typeof vi.fn>): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: ReturnType<typeof vi.fn>): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

/** Every activity row the strip has been shown, in the order it saw them. */
function activityRows(postMessage: ReturnType<typeof vi.fn>): NonNullable<ControlMessageLike['entry']>[] {
  return sentMessages(postMessage).filter((message) => message.type === 'activity').map((message) => message.entry!)
}

/** The activity list carried by the newest full state snapshot. */
function activitySnapshot(postMessage: ReturnType<typeof vi.fn>): ControlState['activity'] {
  return latestState(postMessage)?.activity ?? []
}

async function openBridge(socket: FakeWebSocket): Promise<void> {
  socket.open()
  await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
}

function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  /** Frame documents `webNavigation` reports; a DOM tool needs at least frame 0. */
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onRuntimeMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const frames = options.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://example.com/1' }]
  const tabs = {
    get: vi.fn(async (tabId: number) => htmlTab(tabId)),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(async () => {}),
    create: vi.fn(async () => htmlTab(1)),
    update: vi.fn(async () => {
      // A page-level navigation is only "ready" once the replacement document
      // announces itself; the worker installs that listener before dispatching,
      // so answering here is deterministic rather than a timing race.
      onRuntimeMessage.emit(
        { type: 'DSH_CONTENT_READY' },
        { tab: { id: 1 }, frameId: 0, documentId: 'doc-2', url: 'https://example.com/reset' } as chrome.runtime.MessageSender,
        () => {},
      )
      return htmlTab(1)
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => ({ ok: true, result: { text: 'snapshot' } }))),
    reload: vi.fn(async () => {}),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      openPopup: vi.fn(async () => {}),
      // The toolbar icon has no popup: this listener is what opens the page.
      onClicked: chromeEvent<[chrome.tabs.Tab]>(),
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
      onButtonClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: onRuntimeMessage,
      onInstalled: chromeEvent<[]>(),
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    tabs,
    webNavigation: { getAllFrames: vi.fn(async () => frames), onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>() },
    scripting: { executeScript: vi.fn(async () => []) },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onAlarm, onConnect, tabs }
}

beforeEach(() => {
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('bridge replacement (close code 4000)', () => {
  it('does not reclaim the slot on the keepalive heartbeat', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    // The bridge hands the single slot to another browser.
    socket.close(4000, 'replaced')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    // The heartbeat must leave the other browser alone instead of evicting it
    // back and forth every thirty seconds.
    chromeMock.onAlarm.emit({ name: KEEPALIVE_ALARM, scheduledTime: Date.now() })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(FakeWebSocket.instances).toHaveLength(1)

    // An explicit user action is still allowed to claim the slot again.
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    control.onMessage.emit({ type: 'settings.update', id: 'reclaim', settings: { bridgeUrl: BRIDGE_URL } })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'reclaim', ok: true })
  })
})

describe('revoking unrestricted browser access', () => {
  it('cancels a call that captured the grant before it reaches the page', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true }
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: async (items) => { settings = items.dshSettings as Record<string, unknown> },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // A snapshot first: element targeting is validated against the document the
    // worker last saw, exactly as it is in a real session. It must complete
    // before `sendMessage` starts hanging.
    socket.receive({ t: 'tool.call', id: 'snap-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1', ok: true }))
    })
    const pendingDispatch = new Promise<unknown>(() => {})
    chromeMock.tabs.sendMessage.mockImplementation(() => pendingDispatch)
    socket.receive({
      t: 'tool.call',
      id: 'call-1',
      name: 'browser_click',
      args: { index: 3 },
      expiresAt: Date.now() + 60_000,
    })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'revoke-1',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'revoke-1', ok: true })
    })

    // The revocation is what got persisted, and the call never answered success.
    expect(settings.unrestrictedBrowserAccess).toBe(false)
    expect(socket.sent).toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'call-1',
      ok: false,
    }))
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-1', ok: true }))
  })

  it('persists the restrictive value and still answers the call it withdrew', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true }
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: async (items) => { settings = items.dshSettings as Record<string, unknown> },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // A snapshot baseline, and then a page action the worker dispatches.
    socket.receive({ t: 'tool.call', id: 'snap-4', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-4', ok: true }))
    })
    socket.receive({ t: 'tool.call', id: 'call-4', name: 'browser_click', args: { index: 1 }, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(2)
    })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'revoke-4',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'revoke-4', ok: true })
    })

    // The revocation is what got persisted, the strip is told, and the answer to
    // the in-flight call still arrives so the model is never left waiting.
    expect(settings.unrestrictedBrowserAccess).toBe(false)
    expect(latestState(control.postMessage)?.settings.unrestrictedBrowserAccess).toBe(false)
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-4' }))
  })
})

describe('settings write ordering', () => {
  it('keeps the last of two rapid updates in storage', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL }
    const written: Record<string, unknown>[] = []
    let releaseSecondWrite!: () => void
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: (items) => {
        // Only settings writes belong to the sequence this test counts. The
        // worker's diagnostic probe writes its own key to the same store, and
        // letting it in would renumber the writes this test reasons about.
        if (!('dshSettings' in items)) return Promise.resolve()
        const index = written.length
        settings = items.dshSettings as Record<string, unknown>
        written.push(settings)
        // Write 0 is the boot migration, write 1 is the first patch, write 2 is
        // the second. Making the *middle* one slow is what exposes a missing
        // queue: write 2 would land first, then the stale write 1 would land
        // last and silently undo the user's later choice.
        if (index !== 1) return Promise.resolve()
        return new Promise<void>((resolve) => { releaseSecondWrite = resolve })
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
    await vi.waitFor(() => { expect(written).toHaveLength(1) })

    control.onMessage.emit({ type: 'settings.update', id: 'w1', settings: { sharePageContent: 'off' } })
    await vi.waitFor(() => { expect(written).toHaveLength(2) })
    control.onMessage.emit({ type: 'settings.update', id: 'w2', settings: { approvalNotifications: false } })
    // The queued second patch must not reach storage while the first is open.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(written).toHaveLength(2)

    releaseSecondWrite()
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'w2', ok: true })
    })
    expect(written).toHaveLength(3)

    const persisted = settings as { sharePageContent?: string; approvalNotifications?: boolean }
    expect(persisted.sharePageContent).toBe('off')
    expect(persisted.approvalNotifications).toBe(false)
  })
})

describe('tab rebind deadline', () => {
  it('leaves the binding alone when the tab query resolves after the deadline', async () => {
    let releaseQuery!: (tabs: chrome.tabs.Tab[]) => void
    let slow = false
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      tabQuery: () => {
        if (!slow) return Promise.resolve([htmlTab(1)])
        return new Promise<chrome.tabs.Tab[]>((resolve) => { releaseQuery = resolve })
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
    // The first successful page tool binds the controlled tab to tab 1.
    socket.receive({ t: 'tool.call', id: 'bind-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'bind-1', ok: true }))
      expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(1)
    })

    vi.useFakeTimers()
    slow = true
    control.onMessage.emit({ type: 'affinity.rebind', id: 'slow-rebind' })
    await vi.advanceTimersByTimeAsync(REBIND_TIMEOUT_MS + 10)
    expect(control.postMessage).toHaveBeenCalledWith({
      type: 'affinity.rebind.result',
      id: 'slow-rebind',
      ok: false,
      error: 'timeout',
    })

    // The late answer arrives after the user was already told the attempt failed.
    vi.useRealTimers()
    releaseQuery([htmlTab(2)])
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(1)
    const results = sentMessages(control.postMessage)
      .filter((message) => message.type === 'affinity.rebind.result' && message.id === 'slow-rebind')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, error: 'timeout' })
  })
})

describe('control strip activity privacy', () => {
  it('never echoes typed text or a full URL into the activity list', async () => {
    const chromeMock = mockChrome({
      // Unrestricted access keeps this about what the log records, not about
      // answering approvals.
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true } }),
      tabSendMessage: async () => ({ ok: true, result: { text: 'typed' } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // A snapshot first: element targeting is validated against the document the
    // worker last saw, exactly as it is in a real session.
    socket.receive({ t: 'tool.call', id: 'snap-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1', ok: true }))
    })
    socket.receive({
      t: 'tool.call',
      id: 'type-1',
      name: 'browser_type',
      args: { index: 2, text: 'hunter2-correct-horse' },
      expiresAt: Date.now() + 60_000,
    })
    socket.receive({
      t: 'tool.call',
      id: 'nav-1',
      name: 'browser_navigate',
      args: { url: 'https://example.com/reset?token=secret-value' },
      expiresAt: Date.now() + 60_000,
    })
    await vi.waitFor(() => {
      const rows = activityRows(control.postMessage)
      expect(rows.some((row) => row.id === 'type-1' && row.state === 'done')).toBe(true)
      expect(rows.some((row) => row.id === 'nav-1' && row.state === 'done')).toBe(true)
    })

    // Ask for a fresh snapshot the way the strip does, so the assertion reads
    // the authoritative list instead of whichever push arrived last.
    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(activitySnapshot(control.postMessage)).toHaveLength(3)
    })

    const serialized = JSON.stringify(activitySnapshot(control.postMessage))
    expect(serialized).not.toContain('hunter2-correct-horse')
    expect(serialized).not.toContain('secret-value')
    // The useful, non-secret parts are still there.
    expect(serialized).toContain('https://example.com')
    expect(serialized).toContain('21 chars')
  })
})
