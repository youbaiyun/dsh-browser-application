// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const LISTENER_KEY = '__dshBrowserContentScriptListener__'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[LISTENER_KEY]
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('content script registration', () => {
  it('replaces a stale listener when content.js is injected again', async () => {
    const addListener = vi.fn()
    const removeListener = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener }, sendMessage },
    })

    await import('../src/content/index.ts')
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).not.toHaveBeenCalled()
    const firstListener = addListener.mock.calls[0]?.[0]

    vi.resetModules()
    await import('../src/content/index.ts')

    expect(removeListener).toHaveBeenCalledWith(firstListener)
    expect(addListener).toHaveBeenCalledTimes(2)
    expect(addListener.mock.calls[1]?.[0]).not.toBe(firstListener)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'DSH_CONTENT_READY' })
  })
})
