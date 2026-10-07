// @vitest-environment jsdom

/**
 * Session, assistant-stream, and typed-command tests for the worker.
 *
 * The full-page control UI added two powers that must not regress silently:
 * an instruction typed there is forwarded to the desktop dsh model over the
 * bridge and its streamed reply, turn boundaries, and tool progress are relayed
 * back — one session, active session only, nothing replayed — while a
 * `browser_*` command typed there runs locally through the very same dispatch
 * path a model call uses, and never opens an approval prompt.
 *
 * These tests boot the real worker against a faked `chrome.*` and a fake
 * WebSocket, exactly like `background-bridge-lifecycle.spec.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { CONTROL_PORT_NAME, type ControlState, type TimelineEntry } from '../src/settings.ts'

const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'
const SESSION_ID = 'session-7'

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

type MessageSpy = ReturnType<typeof vi.fn>

/** One message the worker pushed to a control page, with the fields under test. */
interface ControlMessageLike {
  type?: string
  state?: ControlState
  entry?: { id?: string; kind?: string; name?: string; state?: string }
  event?: { sessionId?: string; kind?: string; payload?: unknown }
  request?: { id?: string; action?: string }
  sessionId?: string
  id?: string
  ok?: boolean
  error?: string
  result?: unknown
}

/** One frame the worker wrote to the bridge socket. */
interface SentFrame {
  t?: string
  id?: string
  method?: string
  payload?: Record<string, unknown>
  ok?: boolean
  result?: unknown
  name?: string
}

function sentMessages(postMessage: MessageSpy): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: MessageSpy): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

function streamMessages(postMessage: MessageSpy): NonNullable<ControlMessageLike['event']>[] {
  return sentMessages(postMessage)
    .filter((message) => message.type === 'session.stream')
    .map((message) => message.event!)
}

function sessionEvents(postMessage: MessageSpy): ControlMessageLike[] {
  return sentMessages(postMessage).filter((message) => message.type === 'session.event')
}

function activityRows(postMessage: MessageSpy): NonNullable<ControlMessageLike['entry']>[] {
  return sentMessages(postMessage).filter((message) => message.type === 'activity').map((message) => message.entry!)
}

function approvalRequest(postMessage: MessageSpy): { id: string; action: string } | undefined {
  const request = sentMessages(postMessage)
    .filter((message) => message.type === 'approval.request')
    .at(-1)?.request
  if (request === undefined || typeof request.id !== 'string') return undefined
  return { id: request.id, action: String(request.action ?? '') }
}

function timelineOf(postMessage: MessageSpy): TimelineEntry[] {
  return latestState(postMessage)?.timeline ?? []
}

function sent(socket: FakeWebSocket): SentFrame[] {
  return socket.sent as SentFrame[]
}

function rpcFrame(socket: FakeWebSocket, method: string): SentFrame | undefined {
  return sent(socket).find((frame) => frame.t === 'rpc' && frame.method === method)
}

/**
 * Every frame sent for one method.
 *
 * Needed where a feature legitimately sends the same call several times — 「工作区内」
 * opens one follower per conversation — and a helper returning "the first match" would
 * report the same frame twice.
 *
 * @param socket - the fake connection.
 * @param method - the gateway method to collect.
 * @returns the frames, in send order.
 */
function rpcFrames(socket: FakeWebSocket, method: string): SentFrame[] {
  return sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === method)
}

/**
 * `vi.waitFor` with a budget for a busy machine.
 *
 * Its default is one second, and a full-suite run has 42 spec files in flight at once:
 * a case that takes ~370ms alone was seen failing at 1008ms — the default to the
 * millisecond. The waits below ask whether the worker has got somewhere yet, so a
 * longer budget costs nothing when it is already there.
 */
const waitFor = <T>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 3_000 })

/** Wait until the worker has asked the gateway for `method`. */
async function waitForRpc(socket: FakeWebSocket, method: string): Promise<SentFrame> {
  return waitFor(() => {
    const frame = rpcFrame(socket, method)
    expect(frame, `gateway call ${method}`).toBeDefined()
    return frame!
  })
}

/** Answer one gateway call the way the bridge does: a ServerResponse envelope. */
function answerRpc(socket: FakeWebSocket, request: SentFrame, business: Record<string, unknown>): void {
  socket.receive({
    t: 'rpc.result',
    id: request.id,
    ok: true,
    result: { type: 'server-response', rpcId: request.id, result: business },
  })
}

/** A control page that requested a session; every later push is observable. */
function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  // The worker subscribes here for the content script's "document ready"
  // handshake, so the test needs a handle to fire it.
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  // Exposed so a test can assert what the worker persisted. The panel remembers
  // which conversation "start a new one" is using, and that write is the feature.
  const storage = {
    local: {
      get: vi.fn(options.localGet ?? (async () => ({}))),
      set: vi.fn(options.localSet ?? (async () => {})),
      remove: vi.fn(async () => {}),
    },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
  }
  const frames = options.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://example.com/1' }]
  const tabs = {
    get: vi.fn(async (tabId: number) => htmlTab(tabId)),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(async () => {}),
    create: vi.fn(async () => htmlTab(1)),
    update: vi.fn(async () => htmlTab(1)),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => ({ ok: true, result: { text: 'ok' } }))),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  const windows = {
    WINDOW_ID_NONE: -1,
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({ id: 1 })),
    onFocusChanged: chromeEvent<[number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      // The toolbar icon has no popup: clicking it opens the control page.
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
      onMessage,
      onInstalled: chromeEvent<[]>(),
    },
    storage,
    tabs,
    webNavigation: {
      getAllFrames: vi.fn(async () => frames),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    windows,
  } as unknown as typeof chrome)
  return { onAlarm, onConnect, onMessage, storage, tabs, windows }
}

/** Boot the worker, connect its bridge, and open one control page. */
async function boot(
  settings: Record<string, unknown> = {},
  policy: { openPagesForUser: boolean } = { openPagesForUser: true },
  extraStorage: Record<string, unknown> = {},
) {
  const chromeMock = mockChrome({
    localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, ...settings }, ...extraStorage }),
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  loadedWorker = await import('../src/background/index.ts')
  // At least one, not exactly one: when a discovery attempt is slow, the retry the
  // worker scheduled fires after the first socket was created, so a test that counts
  // dials fails for a legitimate retry. The socket used below stays the first one — it
  // is the one this test opens and the one its handshake travels on.
  await waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await waitFor(() => {
    expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })
  // The policy rides the handshake, so it must be chosen here: a second
  // `hello.ok` is ignored once the connection is authenticated, which is correct
  // — the desktop app does not change its mind mid-connection.
  socket.receive({ t: 'hello.ok', caps: HELLO_CAPS, policy })
  const control = controlPort()
  chromeMock.onConnect.emit(control.port)
  await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
  control.postMessage.mockClear()
  return { chromeMock, control, socket }
}

/** One bridge push event, as the dsh Host adapter projects it. */
function pushEvent(socket: FakeWebSocket, method: string, payload: unknown): void {
  socket.receive({ t: 'event', frame: { rpcId: crypto.randomUUID(), method, payload } })
}

/**
 * The worker module this suite last loaded.
 *
 * A bridge that never answers leaves a discovery retry queued in the module, and
 * that timer outlives the test that caused it: without cancelling it, the timer
 * fires inside the *next* test and dials a socket nobody asked for, so
 * `FakeWebSocket.instances` has two entries and a later test fails for a reason
 * that has nothing to do with what it checks. This is the same teardown
 * `background-bridge-lifecycle.spec.ts` uses, and it is needed here for the same
 * reason — one test binding a session starts the probe chain.
 */
let loadedWorker: { cancelPendingWork?: () => void } | undefined

afterEach(() => {
  loadedWorker?.cancelPendingWork?.()
  loadedWorker = undefined
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('session lifecycle', () => {
  it('creates one session lazily on the first prompt and forwards the exact prompt shape', async () => {
    const { control, socket } = await boot()

    expect(rpcFrame(socket, 'session.create')).toBeUndefined()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'open the docs' })

    const created = await waitForRpc(socket, 'session.create')
    expect(created.payload).toEqual({})
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })

    const prompted = await waitForRpc(socket, 'session.prompt')
    const payload = prompted.payload!
    expect(payload.sessionId).toBe(SESSION_ID)
    expect(payload.mode).toBe('queue')
    // The exact marker, spelled out: this is the anti-impersonation contract, so
    // the test pins the literal rather than comparing the constant to itself.
    expect(JSON.stringify(payload.content)).toBe(JSON.stringify([{ type: 'text', text: '[用户·浏览器面板] open the docs' }]))
    // The zone is optional by contract, but never anything else.
    expect(payload.clientTimeZone === undefined || typeof payload.clientTimeZone === 'string').toBe(true)
    answerRpc(socket, prompted, { ok: true, value: {} })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: true,
        sessionId: SESSION_ID,
      })
    })
    // The worker reports the session and the queued prompt in its state.
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session).toEqual({
        id: SESSION_ID,
        turn: 'idle',
        pendingPrompt: true,
      })
      expect(timelineOf(control.postMessage).filter((entry) => entry.kind === 'request'))
        .toEqual([expect.objectContaining({ kind: 'request', text: 'open the docs', state: 'done' })])
    })

    // A second prompt reuses the session: exactly one session per worker.
    control.onMessage.emit({ type: 'session.prompt', id: 'p2', text: 'and the next page' })
    await waitFor(() => {
      expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')).toHaveLength(2)
    })
    const prompts = sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')
    // Every panel prompt carries the marker, not just the first.
    expect(prompts[1]!.payload!.content).toEqual([{ type: 'text', text: '[用户·浏览器面板] and the next page' }])
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
  })

  it('rejects a prompt with a clear message while the bridge is not connected', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: {} }) })
    // The extension always dials; nothing answering is what leaves it stopped.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('stopped') })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: expect.stringContaining('not connected'),
      })
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('rejects a pending gateway call when the socket drops, and drops the optimistic request row', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    await waitForRpc(socket, 'session.create')

    // The bridge hands its single slot to another browser: the call can never
    // be answered, so the page must be told now instead of in 30 seconds.
    socket.close(4000, 'replaced')
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: 'The dsh bridge was stopped before the gateway answered.',
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(timelineOf(control.postMessage)).toEqual([])
      expect(latestState(control.postMessage)?.session.pendingPrompt).toBe(false)
    })
  })

  it('surfaces a gateway business failure as its own message', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    // A reply the transport accepted but the gateway refused.
    answerRpc(socket, created, { ok: false, error: { code: 'bad-request', message: 'the session limit is reached' } })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: 'the session limit is reached',
      })
    })
    expect(rpcFrame(socket, 'session.prompt')).toBeUndefined()
  })

  it('cancels the remembered session', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    const prompted = await waitForRpc(socket, 'session.prompt')
    answerRpc(socket, prompted, { ok: true, value: {} })

    control.onMessage.emit({ type: 'session.cancel', id: 'c1' })
    const cancel = await waitForRpc(socket, 'session.cancel')
    expect(cancel.payload).toEqual({ sessionId: SESSION_ID })
    answerRpc(socket, cancel, { ok: true, value: {} })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'c1',
        ok: true,
        sessionId: SESSION_ID,
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('idle')
    })
  })

  it('reports a cancel with no session instead of calling the gateway', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.cancel', id: 'c1' })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'c1',
        ok: false,
        error: expect.stringContaining('no dsh session'),
      })
    })
    expect(rpcFrame(socket, 'session.cancel')).toBeUndefined()
  })
})

describe('assistant stream and turn progress', () => {
  it('relays stream and event frames for the active session only', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })
    control.postMessage.mockClear()

    const delta = { revision: 1, attemptId: 'attempt-1', type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }
    pushEvent(socket, 'session/assistant-stream', { sessionId: SESSION_ID, frame: delta })
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: 'someone-else',
      frame: { ...delta, chunk: { type: 'text-delta', index: 0, text: 'NOPE' } },
    })
    const baseline = { revision: 2, activeAttempt: { attemptId: 'attempt-2', stream: [], nextIndex: 0 } }
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: SESSION_ID,
      snapshotId: 'snap-1',
      frame: { type: 'snapshot', baseline },
    })
    pushEvent(socket, 'session/event', {
      sessionId: SESSION_ID,
      event: { type: 'turn/start', seq: 1, time: 1, data: {} },
    })
    pushEvent(socket, 'session/event', {
      sessionId: 'someone-else',
      event: { type: 'turn/end', seq: 2, time: 2, data: {} },
    })

    const streams = streamMessages(control.postMessage)
    expect(streams).toHaveLength(2)
    // A delta IS its frame; a snapshot keeps its id beside the frame.
    expect(streams[0]).toEqual({ sessionId: SESSION_ID, kind: 'delta', payload: delta })
    expect(streams[1]).toEqual({
      sessionId: SESSION_ID,
      kind: 'snapshot',
      payload: { snapshotId: 'snap-1', frame: { type: 'snapshot', baseline } },
    })

    const events = sessionEvents(control.postMessage)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: SESSION_ID, event: { type: 'turn/start', seq: 1 } })

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('running')
    })
  })

  it('drives session.turn from turn/start and turn/end and clears pendingPrompt', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'summarize it' })
    const prompted = await waitForRpc(socket, 'session.prompt')
    answerRpc(socket, prompted, { ok: true, value: {} })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.pendingPrompt).toBe(true)
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/start', seq: 3, time: 3, data: {} } })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.session.turn).toBe('running')
      expect(state.session.pendingPrompt).toBe(false)
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/end', seq: 9, time: 9, data: {} } })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('idle')
    })
  })

  it('keeps one assistant timeline row per turn and replaces its text as deltas arrive', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    const first = { revision: 1, attemptId: 'a1', type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hello' } }
    pushEvent(socket, 'session/assistant-stream', { sessionId: SESSION_ID, frame: first })
    const row = await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text).toBe('Hello')
      return rows[0]!
    })

    // A second delta must replace that row's text, never add a row of its own.
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: SESSION_ID,
      frame: { ...first, index: 1, revision: 2, chunk: { type: 'text-delta', index: 0, text: ', world' } },
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: row.id, kind: 'assistant', text: 'Hello, world' })
    })

    // The durable message is authoritative for the step and does not double it.
    pushEvent(socket, 'session/event', {
      sessionId: SESSION_ID,
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: { message: { content: [{ type: 'text', text: 'Hello, world' }] } },
      },
    })
    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/end', seq: 5, time: 5, data: {} } })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: row.id, text: 'Hello, world', state: 'done' })
    })
  })

  it('caps the timeline and drops the oldest rows', async () => {
    const { control, socket } = await boot({ unrestrictedBrowserAccess: true })
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    // 205 model-driven reads is more than the 200-row cap; the oldest five fall
    // off. They are pushed at once: the row order is the frame order, because a
    // step is appended before the dispatch awaits anything.
    for (let index = 0; index < 205; index += 1) {
      socket.receive({ t: 'tool.call', id: `call-${index}`, name: 'browser_list_tabs', args: {}, expiresAt: Date.now() + 60_000 })
    }
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-204', ok: true }))
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const entries = timelineOf(control.postMessage)
      expect(entries).toHaveLength(200)
      expect(entries[0]!.callId).toBe('call-5')
      expect(entries.at(-1)!.callId).toBe('call-204')
    })
  })
})

describe('@open directive', () => {
  /**
   * Make the next navigation of `tabId` announce a ready document.
   *
   * The worker registers its "document ready" listener immediately before it
   * calls `tabs.update`, so the announcement has to happen *because of* that
   * call. Firing it from the test body instead is a race the worker wins or
   * loses depending on timing — which is how the first version of this test was
   * flaky rather than wrong.
   */
  const arrangeNavigation = (
    chromeMock: ReturnType<typeof mockChrome>,
    tabId: number,
    url: string,
  ): void => {
    chromeMock.tabs.update.mockImplementation(async () => {
      chromeMock.onMessage.emit(
        { type: 'DSH_CONTENT_READY' },
        { tab: { id: tabId }, frameId: 0, documentId: 'doc-next', url } as chrome.runtime.MessageSender,
        () => {},
      )
      return { ...htmlTab(tabId), url }
    })
  }

  it('refuses @open when the desktop app has turned the permission off', async () => {
    // The desktop app owns this switch, so the extension must not keep its own
    // mind about it: a permission the app withdrew has to stop the command.
    const { chromeMock, control } = await boot({}, { openPagesForUser: false })
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://example.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: false,
        error: expect.stringMatching(/openPagesForUser|turned off|关闭/),
      })
    })
    // Nothing was opened, and the tab binding was left alone.
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('refuses @open before any handshake has granted the permission', async () => {
    // The fail-closed direction. A dropped or unreadable policy must read as
    // "not allowed": if absence meant permission, a broken handshake would hand
    // out a grant the user never gave.
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    // At least one, not exactly one: when a discovery attempt is slow, the retry the
  // worker scheduled fires after the first socket was created, so a test that counts
  // dials fails for a legitimate retry. The socket used below stays the first one — it
  // is the one this test opens and the one its handshake travels on.
  await waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'hello' }))
    })
    // Connected, but `hello.ok` has not arrived: no policy is in force yet.
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://example.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: false,
        error: expect.stringMatching(/openPagesForUser|turned off|关闭/),
      })
    })
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('does not raise the panel on its own when pages may not be opened', async () => {
    // Automatic opening is part of "the model is about to show you something",
    // so it must not outlive the app turning that off.
    const { chromeMock, socket } = await boot({ autoOpenPanel: true }, { openPagesForUser: false })

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    await waitFor(() => {
      expect(socket.sent.some((frame) => (frame as { t?: string }).t === 'tool.result')).toBe(true)
    })
    // `windows.getLastFocused` belongs to the auto-open path alone — a tool call
    // resolving its target tab uses `tabs.query`, so this is the signal that
    // distinguishes "the panel was raised" from ordinary dispatch.
    expect(chromeMock.windows.getLastFocused).not.toHaveBeenCalled()
  })

  it('opens the tab in front of the user without involving the model', async () => {
    const { chromeMock, control, socket } = await boot()
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))
    arrangeNavigation(chromeMock, 42, 'https://store.steampowered.com/')

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://store.steampowered.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      // Foreground on purpose: the whole point is that the user sees it.
      expect(chromeMock.tabs.create).toHaveBeenCalledWith({ active: true, windowId: 1 })
    })
    await waitFor(() => {
      expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://store.steampowered.com/' })
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: true,
        result: expect.objectContaining({ url: 'https://store.steampowered.com/', tabId: 42, pinned: true }),
      })
    })

    // The tools now act on the tab the user asked to see.
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(42)
    })
    // And nothing was sent to the model: this directive is not a request.
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')).toHaveLength(0)
  })

  it('refuses a non-http address before opening anything', async () => {
    const { chromeMock, control } = await boot()
    control.onMessage.emit({ type: 'open.run', id: 'o2', url: 'file:///C:/windows/system32', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o2',
        ok: false,
        error: expect.stringMatching(/http/),
      })
    })
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('leaves the binding alone when pin is off', async () => {
    const { chromeMock, control } = await boot()
    chromeMock.tabs.create.mockResolvedValue(htmlTab(43))
    arrangeNavigation(chromeMock, 43, 'https://example.com/')

    control.onMessage.emit({ type: 'open.run', id: 'o3', url: 'https://example.com/', pace: 'fast', pin: false })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o3',
        ok: true,
        result: expect.objectContaining({ pinned: false }),
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.affinity.controlled).toBeNull()
    })
  })
})

describe('conversation routing', () => {
  it('gives the panel its own session by default', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    // `fresh` creates one rather than writing into whatever the desktop has open.
    const created = await waitForRpc(socket, 'session.create')
    expect(created.payload).toEqual({})
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe(SESSION_ID)
    })
  })

  it('continues the chosen conversation without creating a session', async () => {
    // This is the whole point of the feature: ask about a page inside context
    // that already exists, instead of starting from nothing.
    const { control, socket } = await boot({ sessionScope: 'pinned', pinnedSessionId: 'session-chosen' })
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'look at this' })

    const prompted = await waitForRpc(socket, 'session.prompt')
    expect(prompted.payload!.sessionId).toBe('session-chosen')
    // No session was created: the target was declared, not invented.
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(0)
  })

  it('lists the desktop conversations that are worth choosing, running first', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.list', id: 'l1' })
    const call = await waitForRpc(socket, 'session.list')
    answerRpc(socket, call, {
      ok: true,
      value: {
        // The shape the desktop really sends: the title lives in
        // `projections.values.title`, not at the top level, and a sub-agent is tagged
        // with `origin` plus a parent.
        items: [
          {
            sessionId: 'old',
            updatedAt: 1_000,
            running: false,
            projections: { values: { title: 'older', turnOutline: [{ prompt: 'do the old thing', seq: 4 }] } },
          },
          {
            sessionId: 'new',
            updatedAt: 9_000,
            running: true,
            projections: { values: { title: 'newer', turnOutline: [{ prompt: '', seq: 1 }, { prompt: 'do the new thing', seq: 2 }] } },
          },
          // A delegated sub-agent is a Session of its own, but not a conversation the
          // user can pick up from the panel: it would appear once per delegation,
          // titled with its own instructions.
          {
            sessionId: 'sub',
            updatedAt: 8_000,
            running: false,
            origin: 'subagent',
            parentSessionId: 'new',
            projections: { values: { title: 'You are a senior code reviewer' } },
          },
          // Junk must be dropped, not rendered or routed to.
          { sessionId: '', title: 'nameless', updatedAt: 5_000 },
          { title: 'no id at all', updatedAt: 5_000 },
          'not an object',
        ],
      },
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.list',
        id: 'l1',
        ok: true,
        // Running first, then newest first; `preview` is the first *non-empty* prompt,
        // and the title comes from the projection.
        sessions: [
          { sessionId: 'new', title: 'newer', preview: 'do the new thing', updatedAt: 9_000, running: true },
          { sessionId: 'old', title: 'older', preview: 'do the old thing', updatedAt: 1_000, running: false },
        ],
      })
    })
  })

  it('reports a list failure instead of showing an empty picker', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.list', id: 'l1' })
    const call = await waitForRpc(socket, 'session.list')
    answerRpc(socket, call, { ok: false, error: { code: 'internal', message: 'listing is unavailable' } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'session.list',
        id: 'l1',
        ok: false,
        error: expect.stringContaining('unavailable'),
      }))
    })
  })

  it('mirrors every conversation in the browser workspace under 「工作区内」', async () => {
    // The mode exists so an instruction issued on the desktop shows up here without
    // being picked in advance. Two things have to happen for that: the group is read
    // from the path the bridge names (not guessed from a title, which the user can
    // rename), and a follower is opened per conversation — the bridge streams nothing
    // until someone asks, and the panel never prompts most of them.
    const { control, socket } = await boot({}, { openPagesForUser: true, sessionWorkspacePath: 'C:\\Users\\u\\.dsh\\browser-sessions' } as never)
    control.onMessage.emit({ type: 'session.select', id: 's1', scope: 'workspace', sessionId: null })
    const listed = await waitForRpc(socket, 'workspace.list')
    answerRpc(socket, listed, {
      ok: true,
      value: {
        items: [
          // Another group must not be mirrored, even though it has conversations.
          { workspaceId: 'w-other', path: 'C:\\elsewhere', title: 'other', sessionIds: ['session-other'] },
          { workspaceId: 'w-browser', path: 'C:\\Users\\u\\.dsh\\browser-sessions', title: '浏览器对话', sessionIds: ['session-a', 'session-b'] },
        ],
      },
    })
    // One follower per conversation, and only for the named group. Read from the
    // frames the worker actually sent rather than from one `waitForRpc`: the two
    // requests race, and a helper that returns "the first matching frame" would
    // report the same one twice.
    await waitFor(() => {
      expect(rpcFrames(socket, 'session.follow')).toHaveLength(2)
    })
    expect(rpcFrames(socket, 'session.follow').map((frame) => frame.payload?.sessionId).sort())
      .toEqual(['session-a', 'session-b'])
    // The mode is remembered, so a reconnect resumes it rather than silently showing
    // the setting while mirroring nothing.
    await waitFor(() => {
      expect(latestState(control.postMessage)?.settings.sessionScope).toBe('workspace')
    })
  })

  it('switches the target and clears the transcript that belonged to the old one', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    // Wait for the binding itself, not just for a row: detaching only clears
    // anything once a session is actually bound, so asserting too early would
    // pass whether or not the clearing happens.
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe(SESSION_ID)
    })
    // A tool call, so the transcript has a row that is unambiguously not the
    // panel's own request: clearing it is what the assertion below measures.
    socket.receive({ t: 'tool.call', id: 'call-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await waitFor(() => {
      expect(timelineOf(control.postMessage).some((row) => row.kind === 'step')).toBe(true)
    })
    // Settle it before switching. A call still in flight is deliberately kept
    // across a switch, so leaving it running would make this test assert the
    // opposite of the rule it is about.
    socket.receive({ t: 'tool.cancel', id: 'call-1' })
    await waitFor(() => {
      expect(timelineOf(control.postMessage).some((row) => row.kind === 'step' && row.state === 'cancelled')).toBe(true)
    })

    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'pinned', sessionId: 'session-other' })
    // Ask for the state explicitly rather than reading the mock's history: the
    // write is queued, so an earlier push can land before the settings change.
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const latest = latestState(control.postMessage)
      expect(latest?.session.id).toBe('session-other')
      expect(latest?.settings.sessionScope).toBe('pinned')
    })
    const state = latestState(control.postMessage)!
    expect(state.timeline.filter((row) => row.kind === 'step')).toEqual([])
    expect(state.settings).toMatchObject({ sessionScope: 'pinned', pinnedSessionId: 'session-other' })
  })

  it('ignores a session create that lands after the user switched away', async () => {
    // The race: a prompt asks for a session, and while `session.create` is in
    // flight the user picks a different conversation. The create's reply then
    // arrives. Adopting it would silently drag the panel back to the session the
    // user just left, and the next prompt would land in the wrong conversation.
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')

    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'pinned', sessionId: 'session-chosen' })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 'sel1', ok: true })
    })

    // Now the stale create answers.
    answerRpc(socket, created, { ok: true, value: { sessionId: 'session-late' } })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe('session-chosen')
    })
    // And the next prompt still goes where the user pointed it. Waiting is the
    // point: reading the socket immediately would inspect the previous prompt,
    // which was the one whose create lost the race.
    control.onMessage.emit({ type: 'session.prompt', id: 'p2', text: 'and this' })
    await waitFor(() => {
      const prompts = sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')
      expect(prompts.at(-1)!.payload!.sessionId).toBe('session-chosen')
    })
  })

  it('refuses to continue a conversation that was never named', async () => {
    const { control } = await boot()
    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'pinned', sessionId: null })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'session.result',
        id: 'sel1',
        ok: false,
      }))
    })
  })

  it('goes back to creating its own session when the user switches to fresh', async () => {
    const { control, socket } = await boot({ sessionScope: 'pinned', pinnedSessionId: 'session-chosen' })
    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'fresh', sessionId: null })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 'sel1', ok: true })
    })
    expect(latestState(control.postMessage)?.session.id).toBeNull()

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    // It must create rather than keep writing to the conversation it just left.
    await waitFor(() => {
      expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
    })
  })

  it('continues the remembered conversation after the worker has been recycled', async () => {
    // The worker died with the side panel closed, so its in-memory binding is
    // gone. Without the remembered id the next message would open a different
    // conversation, and the user's browser history would fragment into one
    // session per idle timeout — each of which they had to find themselves.
    const { control, socket } = await boot({}, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-earlier',
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello again' })

    // The stored id is checked against the desktop before being trusted.
    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, {
      ok: true,
      value: { items: [{ sessionId: 'session-earlier', title: '', updatedAt: 5_000, running: false }] },
    })

    const prompt = await waitForRpc(socket, 'session.prompt')
    expect(prompt.payload?.sessionId).toBe('session-earlier')
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(0)
    // Settle the prompt. A submission left in flight outlives this test and the
    // next one inherits its half-finished state, which surfaced as an
    // unrelated-looking failure two tests later.
    answerRpc(socket, prompt, { ok: true, value: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
      )
    })
  })

  it('starts a new conversation when the remembered one is gone from the desktop', async () => {
    // A stored id can outlive its session: the user may have deleted that
    // conversation. Adopting a dead id would send the prompt into nowhere and
    // report a gateway error the user cannot act on.
    const { chromeMock, control, socket } = await boot({}, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-deleted',
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })

    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, {
      ok: true,
      value: { items: [{ sessionId: 'session-other', title: '', updatedAt: 5_000, running: false }] },
    })

    await waitFor(() => {
      expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
    })
    const create = sent(socket).find((frame) => frame.t === 'rpc' && frame.method === 'session.create')!
    answerRpc(socket, create, { ok: true, value: { sessionId: 'session-new' } })
    // The dead id must be forgotten, or every future prompt repeats this probe.
    await waitFor(() => {
      expect(chromeMock.storage.local.remove).toHaveBeenCalledWith('dshFreshSessionId')
    })
    // Settle the prompt so nothing is left in flight for the next test.
    const prompt = await waitForRpc(socket, 'session.prompt')
    expect(prompt.payload?.sessionId).toBe('session-new')
    answerRpc(socket, prompt, { ok: true, value: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
      )
    })
  })

  // Storage is shared with older versions of this extension and with anything
  // else that writes to it, so the remembered value cannot be assumed to be the
  // string this code wrote. Each of these must fall through to a new
  // conversation rather than throwing inside the prompt path, where the user
  // would see a failure instead of a reply.
  for (const [label, stored] of [
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { sessionId: 'session-earlier' }],
    ['null', null],
    ['an array', ['session-earlier']],
  ] as const) {
    it(`starts a new conversation when the remembered value is ${label}`, async () => {
      const { control, socket } = await boot({}, { openPagesForUser: true }, {
        dshFreshSessionId: stored,
      })

      control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })

      await waitFor(() => {
        expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
      })
      // A junk value must not even be looked up against the desktop.
      expect(rpcFrame(socket, 'session.list')).toBeUndefined()

      const create = sent(socket).find((frame) => frame.t === 'rpc' && frame.method === 'session.create')!
      answerRpc(socket, create, { ok: true, value: { sessionId: 'session-fresh' } })
      const prompt = await waitForRpc(socket, 'session.prompt')
      expect(prompt.payload?.sessionId).toBe('session-fresh')
      answerRpc(socket, prompt, { ok: true, value: {} })
      await waitFor(() => {
        expect(control.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
        )
      })
    })
  }
})

describe('typed browser commands', () => {
  const runCommand = (control: ReturnType<typeof controlPort>, id: string, name: string, args: Record<string, unknown>) => {
    control.onMessage.emit({ type: 'command.run', id, name, args })
  }

  it('executes a typed command without an approval prompt and records it as a command', async () => {
    // Restricted, page sharing on "ask": a model snapshot would prompt here.
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: false, sharePageContent: 'ask' })
    runCommand(control, 'snap-1', 'browser_snapshot', {})
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-1',
        ok: true,
        result: expect.objectContaining({ text: expect.any(String) }),
      })
    })

    runCommand(control, 'click-1', 'browser_click', { index: 3 })
    await waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'DSH_ACTION', action: 'browser_click', args: { index: 3 } }),
        expect.anything(),
      )
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'click-1',
        ok: true,
        result: expect.anything(),
      })
    })

    // No approval was ever offered, and the bridge was not involved at all.
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({ type: 'approval.request' }))
    expect(rpcFrame(FakeWebSocket.instances[0]!, 'session.prompt')).toBeUndefined()

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.activity[0]).toMatchObject({ kind: 'command', name: 'browser_click', state: 'done' })
      const steps = state.timeline.filter((entry) => entry.kind === 'step')
      expect(steps).toHaveLength(2)
      expect(steps[1]).toMatchObject({ kind: 'step', tool: 'browser_click', state: 'done' })
      expect(steps[1]!.callId).toBe(state.activity[0]!.id)
    })
    // The typed command rows are marked as the user's own, not the model's.
    expect(activityRows(control.postMessage).some((row) => row.kind === 'command' && row.state === 'pending')).toBe(true)
  })

  it('refuses a command the worker has no tool for, without touching the page', async () => {
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: true })
    runCommand(control, 'bad-1', 'browser_frobnicate', { index: 1 })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'bad-1',
        ok: false,
        error: expect.stringContaining('Unknown browser command "browser_frobnicate"'),
      })
    })
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled()

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.timeline.filter((entry) => entry.kind === 'step'))
        .toEqual([expect.objectContaining({ tool: 'browser_frobnicate', state: 'failed' })])
      expect(state.activity[0]).toMatchObject({ kind: 'command', name: 'browser_frobnicate', state: 'failed' })
    })
  })

  it('refuses browser_close_tab without an explicit confirm argument, then honours it', async () => {
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: true })
    runCommand(control, 'close-1', 'browser_close_tab', { tabId: 2 })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'close-1',
        ok: false,
        error: expect.stringContaining('"confirm": true'),
      })
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()

    runCommand(control, 'close-2', 'browser_close_tab', { tabId: 2, confirm: true })
    await waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(2) })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'close-2',
        ok: true,
        result: expect.anything(),
      })
    })
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({ type: 'approval.request' }))
  })

  it('records a model-driven call as a tool step that ends in done', async () => {
    // Page sharing on "ask": this read needs the user's decision, which is what
    // separates a model step from a typed command.
    const { control, socket } = await boot({ unrestrictedBrowserAccess: false, sharePageContent: 'ask' })
    socket.receive({ t: 'tool.call', id: 'call-9', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })

    const request = await waitFor(() => {
      const pending = approvalRequest(control.postMessage)
      expect(pending?.id).toBeTypeOf('string')
      return pending!
    })
    expect(request.action).toBe('browser_snapshot')

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const step = timelineOf(control.postMessage).find((entry) => entry.callId === 'call-9')
      expect(step).toMatchObject({ kind: 'step', tool: 'browser_snapshot', state: 'running' })
      expect(activityRows(control.postMessage)).toContainEqual(expect.objectContaining({ id: 'call-9', kind: 'tool', state: 'running' }))
    })

    control.onMessage.emit({ type: 'approval.respond', id: request.id, decision: 'allow-once' })
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-9', ok: true }))
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const step = timelineOf(control.postMessage).find((entry) => entry.callId === 'call-9')
      expect(step?.state).toBe('done')
      expect(activityRows(control.postMessage)).toContainEqual(expect.objectContaining({ id: 'call-9', kind: 'tool', state: 'done' }))
    })
  })

  it('runs a typed command with no bridge at all', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: {} }) })
    // The extension always dials; nothing answering is what leaves it stopped.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('stopped') })

    control.onMessage.emit({ type: 'command.run', id: 'snap-offline', name: 'browser_snapshot', args: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-offline',
        ok: true,
        result: expect.anything(),
      })
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('adds only a command step for a typed command, never a model step', async () => {
    const { control } = await boot({ unrestrictedBrowserAccess: true })
    control.onMessage.emit({ type: 'command.run', id: 'snap-1', name: 'browser_snapshot', args: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-1',
        ok: true,
        result: expect.anything(),
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      // The timeline step and the activity row agree, and both say "you asked".
      const step = state.timeline.find((entry) => entry.kind === 'step')
      expect(step).toMatchObject({ tool: 'browser_snapshot', state: 'done' })
      expect(state.activity.find((entry) => entry.id === step?.callId)).toMatchObject({ kind: 'command', state: 'done' })
    })
  })
})
