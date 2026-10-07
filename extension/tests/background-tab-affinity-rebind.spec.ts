// @vitest-environment jsdom

/**
 * Background side of the tab-affinity rebind flow, driven through the
 * `dsh-control` port.
 *
 * The control strip is a short-lived popup: it asks the worker to move control
 * to the tab the user is looking at, and the worker owns the deadline and the
 * binding. Nothing here depends on a panel staying open, because the strip
 * closing is normal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

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

function tab(tabId: number): chrome.tabs.Tab {
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

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const query = vi.fn(async () => [tab(1)])
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      // The toolbar icon has no popup: clicking it opens the control page.
      onClicked: chromeEvent<[chrome.tabs.Tab]>(),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: chromeEvent<[chrome.alarms.Alarm]>(),
    },
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
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
      onInstalled: chromeEvent<[]>(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      create: vi.fn(async () => tab(1)),
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onConnect, query }
}

type MessageSpy = ReturnType<typeof vi.fn>

interface ControlMessageLike {
  type?: string
  state?: ControlState
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

/** Boot the worker (no reachable bridge) and open one control strip. */
async function connectControlStrip() {
  const chromeMock = mockChrome()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const control = controlPort()
  chromeMock.onConnect.emit(control.port)
  await vi.waitFor(() => {
    expect(sentMessages(control.postMessage)[0]).toMatchObject({ type: 'state' })
  })
  control.postMessage.mockClear()
  return { chromeMock, query: chromeMock.query, ...control }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('background tab-affinity rebind protocol', () => {
  it('acknowledges only after control has moved to the freshly queried active tab', async () => {
    const { onMessage, postMessage, query } = await connectControlStrip()
    query.mockResolvedValue([tab(2)])

    onMessage.emit({ type: 'affinity.rebind', id: 'rebind-1' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'rebind-1', ok: true })
    })
    const messages = sentMessages(postMessage)
    const resultIndex = messages.findIndex((message) => message.type === 'affinity.rebind.result')
    const stateIndex = messages.map((message) => message.type).lastIndexOf('state', resultIndex)
    expect(stateIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(stateIndex)
    expect(messages[stateIndex]?.state?.affinity).toMatchObject({
      status: 'following',
      controlled: { tabId: 2 },
      active: { tabId: 2 },
    })
  })

  it('reports an active-tab query failure and leaves the existing binding unchanged', async () => {
    const { onMessage, postMessage, query } = await connectControlStrip()
    onMessage.emit({ type: 'affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()
    query.mockRejectedValue(new Error('query failed'))

    onMessage.emit({ type: 'affinity.rebind', id: 'failed-rebind' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'affinity.rebind.result',
        id: 'failed-rebind',
        ok: false,
        error: 'The current tab could not be determined; the existing binding was left unchanged',
      })
    })
    // A failed rebind reports itself and touches nothing else.
    expect(sentMessages(postMessage)).toEqual([{
      type: 'affinity.rebind.result',
      id: 'failed-rebind',
      ok: false,
      error: 'The current tab could not be determined; the existing binding was left unchanged',
    }])

    onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(latestState(postMessage)?.affinity).toMatchObject({
        status: 'following',
        controlled: { tabId: 1 },
      })
    })
  })

  it('owns the deadline in the background and reports a timeout to the strip', async () => {
    const { onMessage, postMessage, query } = await connectControlStrip()
    onMessage.emit({ type: 'affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    vi.useFakeTimers()
    onMessage.emit({ type: 'affinity.rebind', id: 'slow-rebind' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(postMessage).toHaveBeenCalledWith({
      type: 'affinity.rebind.result',
      id: 'slow-rebind',
      ok: false,
      error: 'timeout',
    })
    vi.useRealTimers()

    // The port protocol has no cancellation channel, so a query that outlives
    // the deadline still finishes; the strip is only guaranteed the timeout it
    // already received.
    finishQuery([tab(2)])
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  it('completes a rebind after the strip that asked for it disconnects', async () => {
    const { chromeMock, onDisconnect, onMessage, postMessage, query } = await connectControlStrip()
    onMessage.emit({ type: 'affinity.rebind', id: 'initial-bind' })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'initial-bind', ok: true })
    })
    postMessage.mockClear()

    let finishQuery!: (tabs: chrome.tabs.Tab[]) => void
    query.mockImplementationOnce(async () => await new Promise<chrome.tabs.Tab[]>((resolve) => {
      finishQuery = resolve
    }))
    onMessage.emit({ type: 'affinity.rebind', id: 'disconnected-rebind' })
    await vi.waitFor(() => { expect(finishQuery).toBeTypeOf('function') })
    onDisconnect.emit()

    const reopened = controlPort()
    chromeMock.onConnect.emit(reopened.port)
    expect(latestState(reopened.postMessage)?.affinity.controlled).toMatchObject({ tabId: 1 })

    finishQuery([tab(2)])
    await vi.waitFor(() => {
      expect(latestState(reopened.postMessage)?.affinity).toMatchObject({
        status: 'following',
        controlled: { tabId: 2 },
      })
    })
  })
})
