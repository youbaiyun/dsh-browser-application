// @vitest-environment jsdom

/**
 * Lifecycle and panel-protocol tests for the browser-execution worker.
 *
 * The bridge is not leased to anything: the worker connects as soon as its
 * settings load, because installing the extension is the choice. A
 * `dsh-control` port is only a panel that observes state and answers decisions.
 * These tests boot the real worker against a faked `chrome.*` and a fake
 * WebSocket, and assert that contract instead of the old panel-lease one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import type { ApprovalRequest } from '../src/security/approval.ts'
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

/** Caps the worker offers in its `hello`; the bridge echoes negotiated caps back. */
const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'

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

/** A panel port: named, and answerable. */
function controlPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = {
    name: CONTROL_PORT_NAME,
    postMessage,
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

type MessageSpy = ReturnType<typeof vi.fn>

/** One message the worker pushed to a panel, with the fields under test. */
interface ControlMessageLike {
  type?: string
  state?: ControlState
  request?: ApprovalRequest
  entry?: { id?: string; name?: string; state?: string }
  id?: string
  ok?: boolean
  error?: string
}

function sentMessages(postMessage: MessageSpy): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: MessageSpy): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

function approvalRequest(postMessage: MessageSpy): ApprovalRequest | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'approval.request').at(-1)?.request
}

/**
 * Open the fake socket and wait until the worker's `hello` has gone out.
 *
 * The client attaches its frame listener in the same turn that sends `hello`,
 * so a frame pushed while that turn is still pending would be delivered to
 * nobody.
 */
async function openBridge(socket: FakeWebSocket): Promise<void> {
  socket.open()
  await vi.waitFor(() => {
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })
}

function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabGet?: (tabId: number) => Promise<chrome.tabs.Tab>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabRemove?: (tabId: number) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  executeScript?: () => Promise<unknown>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onNotificationClicked = chromeEvent<[string]>()
  const onNotificationButtonClicked = chromeEvent<[string]>()
  const onInstalled = chromeEvent<[{ reason: string }]>()
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  const action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    // The toolbar icon has no popup; the side panel is opened by the browser.
    onClicked: chromeEvent<[chrome.tabs.Tab]>(),
  }
  const sidePanel = {
    open: vi.fn(async () => {}),
    setPanelBehavior: vi.fn(async () => {}),
  }
  const notifications = {
    create: vi.fn(async () => ''),
    clear: vi.fn(async () => true),
    onClicked: onNotificationClicked,
    onButtonClicked: onNotificationButtonClicked,
  }
  const tabs = {
    get: vi.fn(options.tabGet ?? (async (tabId: number) => htmlTab(tabId))),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(options.tabRemove ?? (async () => {})),
    create: vi.fn(async () => htmlTab(1)),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => {})),
    reload: vi.fn(async () => {}),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  const windows = {
    WINDOW_ID_NONE: -1,
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    onFocusChanged: chromeEvent<[number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action,
    alarms,
    notifications,
    sidePanel,
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
      onInstalled,
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs,
    webNavigation: {
      getAllFrames: vi.fn(async () => []),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: {
      executeScript: vi.fn(options.executeScript ?? (async () => [])),
    },
    windows,
  } as unknown as typeof chrome)
  return { action, alarms, notifications, onConnect, onInstalled, sidePanel, tabs, windows }
}

/**
 * The last-loaded copy of the worker module.
 *
 * A qued discovery retry holds the module graph alive and fires into it later,
 * so the teardown has to cancel through the same instance the test used. A plain
 * `import()` in afterEach would load a fresh copy and start new timers instead.
 */
let loadedWorker: { cancelPendingWork?: () => void } | undefined

afterEach(() => {
  loadedWorker?.cancelPendingWork?.()
  loadedWorker = undefined
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('connects from boot without any panel and reports caps to one that opens later', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')

    // No port was ever connected: the connection is not what starts the bridge.
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toBe('ws://127.0.0.1:3080/ext/bridge')
    expect(chromeMock.alarms.create).toHaveBeenCalledWith(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled()
    // The side panel is opened by the browser itself, not by an action handler.
    expect(chromeMock.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })

    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    // Connecting answers with the current view state immediately.
    expect(sentMessages(control.postMessage)[0]).toMatchObject({ type: 'state' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)).toMatchObject({
        enabled: true,
        bridge: 'connected',
        caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
      })
    })
  })

  it('always connects, because installing the extension is the choice', async () => {
    // There is no autoConnect setting: a panel that has to be told to connect is
    // a support burden, and a legacy stored value must not switch it off.
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { autoConnect: false } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // A legacy `autoConnect: false` must not stop the extension connecting, so
    // discovery has to succeed here for the socket below to exist at all.
    // The answer must be a `ws://` URL: the bridge-config reply is validated, and
    // a secure-scheme one would be skipped as unusable rather than dialled.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 })))

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(chromeMock.alarms.create).toHaveBeenCalledWith(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)).toMatchObject({ enabled: true, bridge: 'connecting' })
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('re-pushes state on state.request', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    control.postMessage.mockClear()

    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(sentMessages(control.postMessage)[0]).toMatchObject({ type: 'state' })
    })
  })

  it('authenticates with the stored token and publishes each connection state to an open panel', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, token: 'secret-token' } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connecting') })

    socket.open()
    await vi.waitFor(() => {
      expect(socket.sent[0]).toEqual({ t: 'hello', token: 'secret-token', caps: HELLO_CAPS })
    })
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
  })

  it('retries bridge discovery from the keepalive alarm when nothing answered at boot', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(6) })
    expect(FakeWebSocket.instances).toHaveLength(0)

    chromeMock.alarms.onAlarm.emit({ name: KEEPALIVE_ALARM, scheduledTime: Date.now() })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(12) })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('panel protocol', () => {
  it('acknowledges a settings save only after persistence and keeps the bridge for a policy change', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    /** Every settings save the worker attempted, in order. */
    const savedSettings: Record<string, unknown>[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      // Only the settings write is held open. The worker's diagnostic probe
      // writes its own key to the same store, and gating that too would stall
      // the very queue this test observes.
      localSet: async (items) => {
        if (!('dshSettings' in items)) return
        savedSettings.push(items.dshSettings as Record<string, unknown>)
        await settingsWrite
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'policy-1',
      settings: { unrestrictedBrowserAccess: true },
    })
    // Counted on settings saves rather than on every call to the store: the
    // worker also writes a diagnostic record, and that is not a settings save.
    await vi.waitFor(() => { expect(savedSettings).toHaveLength(1) })
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({
      type: 'settings.result',
      id: 'policy-1',
    }))

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'policy-1', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: true }),
    })
    // A policy change is not a connection change: the live socket stays.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('keeps the live socket across a layout preference change', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'settings.update', id: 'layout-1', settings: { fixedWidth: false } })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'layout-1', ok: true })
    })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(latestState(control.postMessage)).toMatchObject({ enabled: true, bridge: 'connected' })
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled()
  })

  it('reconnects to a newly entered bridge address', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    await openBridge(original)
    original.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({
      type: 'settings.update',
      id: 'url-1',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('wss://replacement.example/ext/bridge')
    expect(original.readyState).toBe(FakeWebSocket.CLOSED)
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'url-1', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ bridgeUrl: 'wss://replacement.example/ext/bridge' }),
    })
  })

  it('reports a settings persistence failure back to the panel that asked', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      // The failure under test is the settings save. Letting the diagnostic
      // probe's writes fail too would break settings persistence generally and
      // drag boot behaviour into a test about save handling.
      localSet: async (items) => {
        if ('dshSettings' in items) throw new Error('Storage is unavailable')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // Nothing is configured, so boot discovers. One discovery call yields the
    // socket this test needs; a refusal would leave the panel with no bridge at
    // all and turn a save-handling test into a discovery test.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 })))

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    const socketsBefore = FakeWebSocket.instances.length
    control.onMessage.emit({
      type: 'settings.update',
      id: 'failed-1',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'failed-1',
        ok: false,
        error: 'Storage is unavailable',
      })
    })
    // The failed save never reached the connection layer: the address it tried
    // to set was not dialled, and the live socket is untouched.
    expect(FakeWebSocket.instances).toHaveLength(socketsBefore)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('offers a pending approval to the panel and applies its decision to the tool call', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    const request = await vi.waitFor(() => {
      const pending = approvalRequest(control.postMessage)
      expect(pending?.id).toBeTypeOf('string')
      return pending!
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
    expect(sentMessages(control.postMessage)).toContainEqual(expect.objectContaining({
      type: 'activity',
      entry: expect.objectContaining({ id: 'close-1', state: 'running' }),
    }))

    // A panel that opens later still sees every decision that is still pending.
    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)?.approvals.map((entry) => entry.id)).toContain(request.id)
    })

    control.onMessage.emit({ type: 'approval.respond', id: request.id, decision: 'allow-once' })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-1', ok: true }))
    })
    await vi.waitFor(() => {
      expect(sentMessages(control.postMessage)).toContainEqual(expect.objectContaining({
        type: 'activity',
        entry: expect.objectContaining({ id: 'close-1', state: 'done' }),
      }))
    })
    expect(latestState(control.postMessage)?.approvals.map((entry) => entry.id)).not.toContain(request.id)
  })

  it('opens the panel itself when the model starts using the browser', async () => {
    // The user wants to watch the work happen — what it is looking for, what it
    // is downloading — so a browser tool call brings the panel forward.
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    // Opening the panel is not the panel's doing: no port is connected here.
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce() })
    // It targets the window in front of the user, not whichever window Chrome
    // happens to consider current.
    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ windowId: 1 })
  })

  it('leaves the panel alone while a plain conversation runs', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    // A prompt is a conversation, not a browser action. Drive it far enough that
    // the worker has really issued its RPCs, then assert nothing opened.
    socket.receive({
      t: 'event',
      frame: { rpcId: 'rpc-1', method: 'session/create', payload: {} },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })

  it('opens the panel once for a burst of browser work, not once per call', async () => {
    // A model that runs ten calls in a row must not fight the user ten times.
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const call = (id: string) => socket.receive({
      t: 'tool.call',
      id,
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    call('snap-1')
    call('snap-2')
    call('snap-3')
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-3' }))
    })

    expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce()
  })

  it('opens the panel again once the cooldown has passed', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const call = (id: string) => socket.receive({
      t: 'tool.call',
      id,
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })

    call('snap-1')
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce() })

    // A later turn is a new thing to watch, so the panel is brought forward again.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.now() + 61_000)
    call('snap-2')
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledTimes(2) })
    vi.useRealTimers()
  })

  it('honours autoOpenPanel being switched off', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, autoOpenPanel: false } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    // Let the call finish so the assertion is not racing it.
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1' }))
    })
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()
  })

  it('promotes "don\'t ask again" into the stored tab-switch setting', async () => {    // The per-switch prompt used to forget its own answer on every worker
    // restart, so the user was asked the same question forever. Answering with
    // "keep, don't ask again" must therefore be written to settings.
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.tabs.query).toHaveBeenCalled() })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'affinity.rebind', id: 'bind-1' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)?.affinity).toMatchObject({ controlled: { tabId: 1 } })
    })

    // The user switches away, which raises the prompt in the default `ask` mode.
    chromeMock.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
    const handoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      return state
    })

    control.onMessage.emit({
      type: 'affinity.respond',
      revision: handoff.affinity.revision,
      decision: 'keep-always',
    })
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.affinity.status).toBe('background') })

    // The preference, not just the pin, was persisted.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ tabSwitch: 'keep' }),
    })
    // And it is what a panel now sees, so the sheet shows the same answer.
    expect(latestState(control.postMessage)?.settings.tabSwitch).toBe('keep')
  })

  it('raises a system notification when an approval arrives with no panel open', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.notifications.create).toHaveBeenCalledWith(
        expect.stringMatching(/^dsh-approval:/),
        expect.objectContaining({ requireInteraction: true }),
      )
    })
    // Fail closed: no panel answered, so nothing may run yet.
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('applies an affinity keep/follow choice and rejects a stale revision', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.tabs.query).toHaveBeenCalled() })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'affinity.rebind', id: 'bind-1' })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'bind-1', ok: true })
    })
    expect(latestState(control.postMessage)?.affinity).toMatchObject({
      status: 'following',
      controlled: { tabId: 1 },
    })

    // A user tab switch suspends tool dispatch until the panel chooses.
    chromeMock.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
    const handoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      // The switch placeholder is replaced by the tab's real metadata.
      expect(state.affinity.active?.url).toBe('https://example.com/2')
      return state
    })
    expect(handoff.affinity.controlled).toMatchObject({ tabId: 1 })

    control.onMessage.emit({ type: 'affinity.respond', revision: handoff.affinity.revision, decision: 'keep' })
    const kept = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('background')
      return state
    })
    expect(kept.affinity.controlled).toMatchObject({ tabId: 1 })

    chromeMock.tabs.onActivated.emit({ tabId: 3, windowId: 1 })
    const secondHandoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      expect(state.affinity.active?.url).toBe('https://example.com/3')
      return state
    })
    control.onMessage.emit({
      type: 'affinity.respond',
      revision: secondHandoff.affinity.revision,
      decision: 'follow',
    })
    const followed = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('following')
      return state
    })
    expect(followed.affinity.controlled).toMatchObject({ tabId: 3 })

    // A decision about a switch the user already resolved changes nothing.
    const messageCount = sentMessages(control.postMessage).length
    control.onMessage.emit({ type: 'affinity.respond', revision: handoff.affinity.revision, decision: 'keep' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(sentMessages(control.postMessage)).toHaveLength(messageCount)
    expect(latestState(control.postMessage)?.affinity).toMatchObject({
      status: 'following',
      controlled: { tabId: 3 },
    })
  })
})

/**
 * First-run guidance.
 *
 * A freshly installed extension is not pinned to the toolbar and cannot pin
 * itself, so a user who installs from a file sees nothing appear. The
 * notification is the only thing standing between them and never finding it —
 * which is exactly the kind of feature that breaks quietly, because the people
 * who maintain it have already installed the extension and never see it again.
 */
describe('first-run guidance', () => {
  it('offers the toolbar hint on a fresh install', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.onInstalled.emit({ reason: 'install' })

    await vi.waitFor(() => {
      expect(chromeMock.notifications.create).toHaveBeenCalledWith(
        'dsh-onboarding',
        expect.objectContaining({ requireInteraction: true }),
      )
    })
    // The message has to say where the icon went, or it is just noise.
    const calls = chromeMock.notifications.create.mock.calls as unknown as [string, { message: string }][]
    expect(calls.at(-1)?.[1].message).toMatch(/toolbar|拼图/i)
  })

  it('stays quiet on an update, so an existing user is not told twice', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.onInstalled.emit({ reason: 'update' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(chromeMock.notifications.create).not.toHaveBeenCalled()
  })

  it('opens the panel when the hint is clicked, since that click is the required gesture', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.notifications.onClicked.emit('dsh-onboarding')

    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalled() })
    expect(chromeMock.notifications.clear).toHaveBeenCalledWith('dsh-onboarding')
  })
})
