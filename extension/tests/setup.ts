/**
 * jsdom test setup: jsdom has no layout engine, so getBoundingClientRect
 * returns all zeros (which the visibility filter reads as hidden), and it
 * does not implement CSS.escape. Stub both with browser-equivalent behavior.
 */

const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 40,
  width: 200,
  height: 40,
  toJSON: () => ({}),
}

Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function getBoundingClientRect(this: Element): DOMRect {
    return FAKE_RECT
  },
})

Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {
    escape(value: string): string {
      return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    },
  },
})

/**
 * A controllable `requestAnimationFrame`.
 *
 * The panel coalesces streaming repaints to one per frame, which is what keeps a long reply
 * from freezing it. jsdom does not implement `requestAnimationFrame` at all, so without a
 * stub every streaming spec would throw. Rather than making specs async just to wait a
 * frame, the callbacks are held here and released on demand.
 *
 * Nothing runs on its own: a spec that prints must call `flushAnimationFrames()`, which
 * also makes the coalescing observable — a frame's worth of deltas produces one repaint.
 */
export const flushAnimationFrames = (maxRounds = 8): void => {
  for (let round = 0; round < maxRounds; round++) {
    const pending = pendingFrames.splice(0, pendingFrames.length)
    if (pending.length === 0) return
    for (const callback of pending) callback(0)
  }
}

const pendingFrames: Array<(time: number) => void> = []

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback: (time: number) => void): number => {
    pendingFrames.push(callback)
    return pendingFrames.length
  },
})

Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  writable: true,
  value: (): void => {
    pendingFrames.length = 0
  },
})

/**
 * No test may reach the network.
 *
 * The background probes loopback ports looking for the bridge, so a spec that
 * loads it without stubbing `fetch` talks to whatever the developer happens to
 * be running. That makes results depend on the machine rather than the code, and
 * such a difference usually surfaces on someone else's checkout.
 *
 * Specs that need a bridge stub `fetch` themselves. Everything else gets a
 * refusal, which is what "no bridge on this port" looks like.
 *
 * A guard, not a fix for a known failure: the suite passes with and without it
 * today. It is here so that stays true.
 */
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: () => Promise.reject(new Error('ECONNREFUSED: tests never reach the network')),
})
