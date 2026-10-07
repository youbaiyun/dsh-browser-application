// @vitest-environment jsdom

/**
 * A user journey, start to finish, in one test.
 *
 * The other specs each answer one question. This one walks the sequence a person actually
 * performs and checks the panel is usable at every step — because the failures found so far
 * were all *between* steps: the panel rendered fine in isolation and went blank once it had
 * been resized, or lost focus only when a prompt was sent rather than pushed.
 *
 * The journey, in order:
 *   1. the panel opens narrow, with no state yet
 *   2. state arrives; the desktop is mid-answer in a conversation the panel did not start
 *   3. the reader types their own message while that streams
 *   4. they open settings and change one
 *   5. they drag the panel wider and narrower again
 *   6. they expand a tool line and scroll back through the transcript
 *   7. an approval arrives and is answered
 *   8. the desktop finishes the turn
 *   9. the reader switches conversation and returns
 *
 * At each step it asserts the two things a person would notice: the content is on screen and
 * the controls still respond.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, ControlState } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { flushAnimationFrames } from './setup.ts'
import { App, type ControlPort } from '../control/main.ts'
import { controlCopy } from '../control/strings.ts'

class StubPort {
  readonly sent: ControlRequest[] = []
  readonly calls: ControlRequest[] = []
  connected = true
  asControlPort(): ControlPort {
    return this as unknown as ControlPort
  }
  connect(): void {}
  dispose(): void {}
  post(message: ControlRequest): boolean {
    this.sent.push(message)
    return true
  }
  call(message: ControlRequest): Promise<{ sessionId?: string }> {
    this.calls.push(message)
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'panel-session' } : {})
  }
}

function state(overrides: Partial<ControlState> = {}): ControlState {
  return {
    enabled: true,
    bridge: 'connected',
    caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    affinity: { revision: 1, status: 'following', controlled: null, active: null, pinned: false },
    approvals: [],
    settings: { ...SETTINGS_DEFAULTS },
    sessionTrustedOrigins: [],
    activity: [],
    session: { id: null, turn: 'idle', pendingPrompt: false },
    timeline: [],
    policy: { openPagesForUser: true },
    replaced: false,
    followError: null,
    ...overrides,
  }
}

/** What a person would notice: is there content, and does the composer still work? */
function visible(root: HTMLElement) {
  const transcript = root.querySelector('.transcript')
  const inner = root.querySelector('.transcript__inner')
  return {
    text: (inner?.textContent ?? '').trim(),
    innerWidth: inner === null ? 0 : Math.round(inner.getBoundingClientRect?.().width ?? 0),
    rows: inner === null ? 0 : inner.children.length,
    composer: root.querySelector('.composer__input') !== null,
    header: root.querySelector('.header') !== null,
    panelMax: document.documentElement.style.getPropertyValue('--panel-max'),
    transcriptWidth: transcript === null ? 0 : Math.round(transcript.getBoundingClientRect?.().width ?? 0),
  }
}

describe('user journey', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('stays usable through a whole session, including a conversation the panel did not start', async () => {
    // --- 1. the panel opens narrow, before the worker says anything --------------------
    const root = document.createElement('div')
    document.body.append(root)
    let panelWidth = 360
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()

    let v = visible(root)
    expect(v.header, '1. header draws before any state').toBe(true)
    expect(v.composer, '1. composer draws before any state').toBe(true)
    expect(v.panelMax, '1. cap is applied on the first paint').toBe('360px')

    // --- 2. the desktop is mid-answer in a conversation the panel did not start --------
    const desktopPrompt = '在浏览器对话里发出的指令'
    let reply = ''
    const pushWorking = (turn: 'running' | 'idle', state_?: 'running' | 'done') => {
      app.handleMessage({
        type: 'state',
        state: state({
          session: { id: 'desktop-session', turn, pendingPrompt: false },
          timeline: [
            { id: 'u1', kind: 'request', text: desktopPrompt, state: 'done', at: 1 },
            { id: 'a1', kind: 'assistant', text: reply, state: state_ ?? 'running', at: 2 },
            { id: 't1', kind: 'step', text: 'browser_navigate https://github.com', tool: 'browser_navigate', state: 'done', at: 3 },
          ],
        }),
      })
    }
    for (let tick = 0; tick < 5; tick++) {
      reply += `第${tick}段回答 `
      pushWorking('running')
      flushAnimationFrames()
    }
    v = visible(root)
    expect(v.text, '2. the desktop conversation is on screen').toContain(desktopPrompt)
    expect(v.text, '2. its answer is on screen').toContain('第4段回答')
    expect(v.text, '2. its tool run is on screen').toContain('browser_navigate')
    expect(v.rows, '2. rows exist').toBeGreaterThan(0)
    expect(Number.parseFloat(v.panelMax), '2. cap still within the panel').toBeLessThanOrEqual(panelWidth)

    // --- 3. the reader types their own message while that streams ---------------------
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.focus()
    input.value = '我自己的问题'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.activeElement, '3. the composer holds focus').toBe(input)

    // --- 4. they open settings and change one ----------------------------------------
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')?.click()
    expect(root.querySelector('.sheet'), '4. the sheet opens').not.toBeNull()
    const selects = [...root.querySelectorAll<HTMLSelectElement>('.sheet select')]
    expect(selects.length, '4. the sheet has controls').toBeGreaterThan(0)
    const sharing = selects[0]!
    sharing.value = sharing.options[sharing.options.length - 1]!.value
    sharing.dispatchEvent(new Event('change', { bubbles: true }))
    expect(port.sent.some((m) => m.type === 'settings.update'), '4. changing a control sends an update').toBe(true)
    // A state push must not rebuild the sheet out from under the reader. The push carries the
    // settings the worker knows about — which are still the ones from before the local change —
    // so one push legitimately reconciles. The second, identical push is the one that must be
    // a no-op, which is what keeps a dropdown open while a reply streams.
    const sameSettings = state({
      session: { id: 'desktop-session', turn: 'running', pendingPrompt: false },
      settings: { ...SETTINGS_DEFAULTS },
    })
    app.handleMessage({ type: 'state', state: sameSettings })
    const settledRow = root.querySelector('.sheet__body .setting')
    expect(settledRow, '4. the sheet has rows after reconciling').not.toBeNull()
    app.handleMessage({ type: 'state', state: sameSettings })
    expect(root.querySelector('.sheet__body .setting'), '4. an unchanged push keeps the sheet').toBe(settledRow)

    // --- 5. they drag the panel wider and narrower -----------------------------------
    for (const width of [640, 900, 320, 180, 360]) {
      panelWidth = width
      // The push has to carry the working conversation, or resizing would also clear it and the
      // later steps would be testing an empty panel instead of a resized one.
      pushWorking('running')
      const applied = Number.parseFloat(document.documentElement.style.getPropertyValue('--panel-max'))
      expect(Number.isNaN(applied), `5. width ${width} produced a number`).toBe(false)
      expect(applied, `5. cap must not exceed the ${width}px panel`).toBeLessThanOrEqual(width)
      expect(visible(root).header, `5. header survives width ${width}`).toBe(true)
      expect(visible(root).composer, `5. composer survives width ${width}`).toBe(true)
    }
    panelWidth = 360

    // --- 6. they expand a tool line and scroll back ----------------------------------
    const toolButton = root.querySelector<HTMLButtonElement>('.tool-line')
    expect(toolButton, '6. there is a tool line to expand').not.toBeNull()
    const before = toolButton!.getAttribute('aria-expanded')
    toolButton!.click()
    expect(root.querySelector('.tool-line')?.getAttribute('aria-expanded'), '6. expanding works').not.toBe(before)
    const transcriptEl = root.querySelector<HTMLElement>('.transcript')!
    transcriptEl.scrollTop = 400

    // --- 7. an approval arrives and is answered --------------------------------------
    app.handleMessage({
      type: 'state',
      state: state({
        session: { id: 'desktop-session', turn: 'running', pendingPrompt: false },
        approvals: [{
          id: 'ap1', kind: 'read', action: 'browser_get_text', summary: '读取页面文本',
          origins: ['https://example.com'], canTrust: true,
        }],
      }),
    })
    const allow = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '').trim() === '允许')
    expect(allow, '7. the approval offers 允许').not.toBeUndefined()
    allow!.click()
    expect(port.sent.some((m) => m.type === 'approval.respond'), '7. answering posts a decision').toBe(true)

    // --- 8. the desktop finishes the turn --------------------------------------------
    pushWorking('idle', 'done')
    flushAnimationFrames()
    v = visible(root)
    expect(v.text, '8. the finished reply is still on screen').toContain('第4段回答')
    expect(v.composer, '8. composer survived the whole journey').toBe(true)
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value, '8. the typed draft survived').toBe('我自己的问题')

    // --- 9. they switch conversation and come back -----------------------------------
    app.handleMessage({
      type: 'state',
      state: state({ session: { id: 'other-session', turn: 'idle', pendingPrompt: false }, timeline: [] }),
    })
    flushAnimationFrames()
    v = visible(root)
    expect(v.text, '9. the previous conversation is not painted into the new one').not.toContain('第4段回答')
    expect(v.text, '9. the new conversation is not the old prompt').not.toContain(desktopPrompt)
    expect(v.composer, '9. composer survives the switch').toBe(true)

    app.handleMessage({
      type: 'state',
      state: state({
        session: { id: 'desktop-session', turn: 'idle', pendingPrompt: false },
        timeline: [
          { id: 'u1', kind: 'request', text: desktopPrompt, state: 'done', at: 1 },
          { id: 'a1', kind: 'assistant', text: reply, state: 'done', at: 2 },
        ],
      }),
    })
    flushAnimationFrames()
    expect(visible(root).text, '9. coming back restores the conversation').toContain(desktopPrompt)
    expect(visible(root).composer, '9. composer survives the return').toBe(true)
  }, 30_000)
  it('flips the send button to stop and back on a state push alone', () => {
    // The turn flag arrives in `state` as well as in `session.event`. `refreshComposerAction`
    // was only called from the turn-event path, so a state-only transition left the button in
    // the previous turn's shape — a stop button after the turn had already ended.
    const root = document.createElement('div')
    document.body.append(root)
    const app = new App(root, 'zh', new StubPort().asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: state() })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'idle shows send')
      .toBe(controlCopy('zh').composer.send)

    app.handleMessage({ type: 'state', state: state({ session: { id: 's1', turn: 'running', pendingPrompt: false } }) })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'running shows stop')
      .toBe(controlCopy('zh').composer.stop)

    app.handleMessage({ type: 'state', state: state({ session: { id: 's1', turn: 'idle', pendingPrompt: false } }) })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'idle shows send again')
      .toBe(controlCopy('zh').composer.send)
  })
})
