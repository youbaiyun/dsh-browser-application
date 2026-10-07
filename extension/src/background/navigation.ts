/**
 * One-shot rendezvous between an action that unloads a frame and the content
 * script installed in its replacement document.
 *
 * @module
 */

/** Default ceiling for replacing a model-driven snapshot round trip. */
const NAVIGATION_READY_TIMEOUT_MS = 8_000

/** A cancellable wait for the next content-script document in one frame. */
export interface NavigationWait {
  ready: Promise<boolean>
  cancel: () => void
}

/**
 * Listen before dispatching a navigation so a fast replacement document
 * cannot announce readiness between the action response and listener setup.
 */
export function waitForNextDocumentReady(
  tabId: number,
  frameId: number,
  previousDocumentId: string | undefined,
  signal?: AbortSignal,
  timeoutMs: number = NAVIGATION_READY_TIMEOUT_MS,
): NavigationWait {
  let finish: (ready: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
      if (typeof message !== 'object' || message === null) return
      if ((message as { type?: unknown }).type !== 'DSH_CONTENT_READY') return
      if (sender.tab?.id !== tabId || (sender.frameId ?? 0) !== frameId) return
      if (previousDocumentId !== undefined && sender.documentId === previousDocumentId) return
      // A newly created Firefox tab can run the content script in its initial
      // about:blank document. With no baseline document id, accept only the
      // HTTP(S) destination document that browser_open_tab can navigate to.
      if (previousDocumentId === undefined
        && (typeof sender.url !== 'string' || !/^https?:\/\//i.test(sender.url))) return
      finish(true)
    }
    const onAbort = (): void => { finish(false) }
    finish = (isReady: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      signal?.removeEventListener('abort', onAbort)
      resolve(isReady)
    }

    if (signal?.aborted === true) {
      finish(false)
      return
    }
    chrome.runtime.onMessage.addListener(listener)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { finish(false) }, timeoutMs)
  })

  return { ready, cancel: () => { finish(false) } }
}
