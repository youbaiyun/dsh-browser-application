// @vitest-environment jsdom

/**
 * Simulation: does the panel survive being used while a reply streams?
 *
 * The unit specs answer "does this render" one assertion at a time. This one drives the
 * panel the way the desktop app does — a reply arriving in deltas, full state pushes every
 * 50 ms, tool steps, an approval, and a person typing throughout — and checks the three
 * things that quietly break under that load:
 *
 *   1. both sides of the conversation stay on screen (your prompt and the reply);
 *   2. controls stay interactive: a real click still produces its message, every round;
 *   3. the composer keeps working: focus survives a repaint, typed characters land, and the
 *      draft is not eaten.
 *
 * Two things make this stricter than it first looks, because both were mistakes in an
 * earlier draft of this same file:
 *
 *   - **Focus is never re-applied.** A real browser moves focus to `document.body` when the
 *     focused element is removed, and the rebuild path removes the textarea. An earlier
 *     draft re-focused after every push, which is exactly the symptom it was meant to
 *     detect: focus loss is what "typing suddenly stopped working" is. Here, whatever the
 *     panel does to focus is left alone and then observed.
 *   - **Typing goes to whatever is focused.** Characters are dispatched at the element that
 *     actually holds focus, not at a stale reference, so text is lost the way it would be
 *     for a person.
 *
 * It runs 100 rounds and prints per-round outcomes, because an intermittent fault that
 * happens once in five rounds is the kind a single pass reports as success.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, ControlState, TimelineEntry } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { flushAnimationFrames } from './setup.ts'
import { App, type ControlPort } from '../control/main.ts'
import { controlCopy } from '../control/strings.ts'

const ROUNDS = 100
const TICKS_PER_ROUND = 12

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
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'created' } : {})
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
    session: { id: 'session-1', turn: 'idle', pendingPrompt: false },
    timeline: [],
    policy: { openPagesForUser: true },
    replaced: false,
    followError: null,
    ...overrides,
  }
}

/**
 * Make focus behave like a real browser across a rebuild.
 *
 * A browser moves focus off an element that is removed from the document; jsdom leaves
 * `document.activeElement` pointing at the detached node, which hides the fault. The test
 * checks `document.contains`, not containment in `body`: the mount element is a detached
 * node in this harness, so a `body` check would call every healthy element "removed" and
 * manufacture the very failure being measured.
 */
function settleFocusLikeABrowser(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !document.contains(active)) {
    active.blur()
  }
}

/** Type into whatever currently holds focus, the way a keypress would. */
function typeWhereFocusIs(text: string): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLInputElement)) return false
  active.value = active.value + text
  active.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

interface RoundResult {
  round: number
  userVisible: boolean
  replyVisible: boolean
  expandWorked: boolean
  approvalWorked: boolean
  focusLost: number
  typedLost: number
  draftKept: boolean
}

describe(`panel simulation (${ROUNDS} rounds)`, () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('stays usable while a reply streams, every round', async () => {
    const results: RoundResult[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const root = document.createElement('div')
      document.body.append(root)
      const port = new StubPort()
      const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
      app.start()
      app.handleMessage({ type: 'state', state: state() })

      const prompt = `第${round + 1}轮提问`

      // --- the human types the prompt into the real composer -----------------------
      const first = root.querySelector<HTMLTextAreaElement>('.composer__input')
      expect(first, 'composer input').not.toBeNull()
      first!.focus()
      first!.value = prompt
      first!.dispatchEvent(new Event('input', { bubbles: true }))

      app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })

      const timeline = (reply: string): TimelineEntry[] => [
        { id: 'user-1', kind: 'request', text: prompt, state: 'done', at: 900 },
        { id: 'a-1', kind: 'assistant', text: reply, state: 'running', at: 1_100 },
        { id: 'tool-1', kind: 'step', text: '点击元素 [3]', tool: 'browser_click', state: 'done', at: 1_200 },
      ]

      let replySoFar = ''
      let focusLost = 0
      let typedLost = 0

      for (let tick = 0; tick < TICKS_PER_ROUND; tick++) {
        replySoFar += `段落${tick} `

        // A durable running row plus a delta, exactly as the worker publishes them.
        app.handleMessage({
          type: 'state',
          state: state({
            session: { id: 'session-1', turn: 'running', pendingPrompt: false },
            timeline: timeline(replySoFar),
          }),
        })
        app.handleMessage({
          type: 'session.stream',
          event: {
            sessionId: 'session-1',
            kind: 'delta',
            payload: { type: 'chunk', chunk: { type: 'text-delta', text: `段落${tick} ` } },
          },
        })
        flushAnimationFrames()

        // Whatever the repaint did to focus, it stands.
        settleFocusLikeABrowser()

        // The person keeps typing. If focus was lost, these characters are lost with it.
        if (!typeWhereFocusIs('字')) {
          focusLost += 1
          typedLost += 1
        }
      }

      // --- interactions while the reply is still on screen -------------------------
      const toolButton = root.querySelector<HTMLButtonElement>('.tool-line')
      const before = toolButton?.getAttribute('aria-expanded')
      toolButton?.click()
      settleFocusLikeABrowser()
      const after = root.querySelector<HTMLButtonElement>('.tool-line')?.getAttribute('aria-expanded')
      const expandWorked = before !== undefined && after !== undefined && before !== after

      // An approval arriving mid-reply, answered with a real click on the real label.
      app.handleMessage({
        type: 'state',
        state: state({
          session: { id: 'session-1', turn: 'running', pendingPrompt: false },
          timeline: [
            { id: 'user-1', kind: 'request', text: prompt, state: 'done', at: 900 },
            { id: 'a-1', kind: 'assistant', text: replySoFar, state: 'running', at: 1_100 },
          ],
          approvals: [{
            id: `ap-${round}`,
            kind: 'action',
            action: 'browser_click',
            summary: '点击元素 [3]',
            origins: ['https://example.com'],
            canTrust: true,
          }],
        }),
      })
      const allow = [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => (button.textContent ?? '').trim() === '允许')
      allow?.click()
      const approvalWorked = port.sent.some(
        (message) => message.type === 'approval.respond' && message.id === `ap-${round}`,
      )

      // --- what is on screen -------------------------------------------------------
      const text = root.textContent ?? ''
      const liveInput = root.querySelector<HTMLTextAreaElement>('.composer__input')

      results.push({
        round,
        userVisible: text.includes(prompt),
        replyVisible: text.includes('段落11'),
        expandWorked,
        approvalWorked,
        focusLost,
        typedLost,
        draftKept: liveInput !== null && liveInput.value.includes(prompt),
      })
    }

    // --- report ---------------------------------------------------------------------
    const rows = results.map((r) => [
      `#${String(r.round + 1).padStart(2)}`,
      r.userVisible ? ' ok ' : 'FAIL',
      r.replyVisible ? ' ok ' : 'FAIL',
      r.expandWorked ? ' ok ' : 'FAIL',
      r.approvalWorked ? ' ok ' : 'FAIL',
      r.focusLost === 0 ? ' ok ' : ` x${r.focusLost}`,
      r.draftKept ? ' ok ' : 'FAIL',
    ].join('  '))
    // eslint-disable-next-line no-console
    console.log(['rnd  user reply expand appr focus draft', ...rows].join('\n'))

    const clean = results.filter((r) =>
      r.userVisible && r.replyVisible && r.expandWorked && r.approvalWorked && r.focusLost === 0 && r.draftKept,
    ).length
    const focusLossRounds = results.filter((r) => r.focusLost > 0).length
    // eslint-disable-next-line no-console
    console.log(
      `\n${clean}/${ROUNDS} 轮完全正常；${focusLossRounds} 轮出现焦点丢失` +
      `（共 ${results.reduce((sum, r) => sum + r.focusLost, 0)} 次，` +
      `连带丢掉 ${results.reduce((sum, r) => sum + r.typedLost, 0)} 次输入）`,
    )

    expect(results.filter((r) => !r.userVisible), '用户文本消失').toHaveLength(0)
    expect(results.filter((r) => !r.replyVisible), '回复文本消失').toHaveLength(0)
    expect(results.filter((r) => !r.expandWorked), '工具行不可交互').toHaveLength(0)
    expect(results.filter((r) => !r.approvalWorked), '审批按钮无效').toHaveLength(0)
    expect(results.filter((r) => !r.draftKept), '草稿被吃掉').toHaveLength(0)
  }, 180_000)

  it('keeps the composer usable while a prompt is sent and while a run is stopped', async () => {
    // The 100-round loop above only overlays `state` pushes, so it could not see the other
    // half of the same bug: `runPrompt`, `runCommand`, `runOpen` and `stopRun` also called the
    // full `render()`, which replaces the textarea. Sending therefore removed the box the
    // reader was typing in, and the reader's *next* sentence was discarded when the worker
    // answered. This walks those paths instead of the push path.
    const root = document.createElement('div')
    document.body.append(root)
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: state() })

    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(input, 'composer input').not.toBeNull()
    input!.focus()
    input!.value = '第一条消息'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    // Send it, the way Enter does.
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()

    const afterSend = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(afterSend, 'composer still present after send').not.toBeNull()
    expect(document.activeElement, 'focus kept through send').toBe(afterSend)

    // Type the next message while the prompt round-trip is still settling.
    expect(typeWhereFocusIs('第二条'), 'keystrokes land after send').toBe(true)
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()

    const afterResolve = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(afterResolve, 'composer still present after the answer').not.toBeNull()
    expect(document.activeElement, 'focus kept through the answer').toBe(afterResolve)
    expect(afterResolve?.value, 'the second message is still there').toContain('第二条')

    // Stopping a run must not take the composer away either.
    app.handleMessage({
      type: 'state',
      state: state({ session: { id: 'session-1', turn: 'running', pendingPrompt: false } }),
    })
    const stop = root.querySelector<HTMLButtonElement>('#composer-action')
    expect(stop, 'stop button while running').not.toBeNull()
    stop!.focus()
    stop!.click()
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input'), 'composer after stop').not.toBeNull()
  }, 20_000)
})
