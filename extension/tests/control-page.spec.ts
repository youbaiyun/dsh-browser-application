// @vitest-environment jsdom

/**
 * Tests for the side panel: its pure helpers, its Markdown path, and the
 * rendered conversation.
 *
 * The panel's whole job is to show what was said, so the assertions here are
 * about the transcript: your message appears as your message, the model's reply
 * appears rendered and streamed, a tool run is one quiet line, and nothing from
 * the page or the model can become markup.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { flushAnimationFrames } from './setup.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'
import type { ActivityEntry, ControlRequest, ControlState, TimelineEntry } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { controlCopy } from '../control/strings.ts'
import { renderMarkdown, stabilizeStreamingMarkdown } from '../control/markdown.ts'
import {
  App,
  approvalDecisions,
  assistantTextFromEvent,
  bridgeStateText,
  controlledTabText,
  isUserAuthoredMessage,
  mergeActivity,
  mergeApprovals,
  stateText,
  sessionLabel,
  textFromBlocks,
  timelineFromState,
  toolLabel,
  type ControlPort,
} from '../control/main.ts'
import { classifyInput } from '../control/command.ts'

/** A port stub that records what the page sent and answers like the worker. */
class StubPort {
  readonly sent: ControlRequest[] = []
  readonly calls: ControlRequest[] = []
  connected = true
  /** Set to make the next answer fail, so the error path can be exercised. */
  failure: string | null = null

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
    if (this.failure !== null) return Promise.reject(new Error(this.failure))
    // `session.create` is the only call that answers with an identifier.
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'session-created' } : {})
  }
}

function tab(overrides: Partial<TabAffinityState> = {}): TabAffinityState {
  return { revision: 1, status: 'following', controlled: null, active: null, pinned: false, ...overrides }
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'a1',
    kind: 'action',
    action: 'browser_click',
    summary: '点击元素 [3]',
    origins: ['https://example.com'],
    canTrust: true,
    ...overrides,
  }
}

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return { id: 's1', kind: 'step', text: '点击元素 [3]', tool: 'browser_click', state: 'done', at: 1_000, ...overrides }
}

function state(overrides: Partial<ControlState> = {}): ControlState {
  return {
    enabled: true,
    bridge: 'connected',
    caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    affinity: tab(),
    approvals: [],
    settings: { ...SETTINGS_DEFAULTS },
    sessionTrustedOrigins: [],
    activity: [],
    session: { id: 'session-1', turn: 'idle', pendingPrompt: false },
    timeline: [],
    // A completed handshake that allows opening pages, matching the plugin's
    // default. Tests that care pass their own policy.
    policy: { openPagesForUser: true },
    replaced: false,
    // No failed follow unless a test asks for one.
    followError: null,
    ...overrides,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

/**
 * The panel's source directory.
 *
 * Resolved from this file rather than `process.cwd()`, which is only the package
 * directory when the runner happens to be invoked through `pnpm --filter`. Run
 * from the repository root, the cwd made these reads fail with an ENOENT for a
 * path outside the repository entirely.
 */
const CONTROL_DIR = resolve(import.meta.dirname, '..', 'control')

describe('formatting helpers', () => {
  it('has complete bridge wording for all four states', () => {
    const copy = controlCopy('zh')
    for (const value of ['connecting', 'connected', 'reconnecting', 'stopped'] as const) {
      expect(bridgeStateText(value, copy)).not.toBe('')
    }
    expect(bridgeStateText('connected', copy)).toBe('已连接')
    expect(bridgeStateText('connected', controlCopy('en'))).toBe('Connected')
  })

  it('names the controlled page and falls back when there is none', () => {
    const copy = controlCopy('zh')
    expect(controlledTabText(tab(), copy)).toBe(copy.tab.none)
    expect(controlledTabText(tab({ controlled: { tabId: 1, windowId: 1, title: 'Example', url: 'https://example.com' } }), copy)).toBe('Example')
    expect(controlledTabText(tab({ controlled: { tabId: 1, windowId: 1, title: '  ', url: 'https://example.com/x' } }), copy)).toBe('https://example.com/x')
  })

  it('words every step state in both languages', () => {
    for (const value of ['pending', 'running', 'done', 'failed', 'denied', 'cancelled'] as const) {
      expect(stateText(value, 'zh')).not.toBe('')
      expect(stateText(value, 'en')).not.toBe('')
    }
    expect(stateText('done', 'zh')).toBe('已完成')
  })

  it('labels a tool without the noisy prefix', () => {
    const copy = controlCopy('zh')
    expect(toolLabel('browser_snapshot', copy)).toBe('snapshot')
    expect(toolLabel('browser_close_tab', copy)).toBe('close tab')
    expect(toolLabel(undefined, copy)).toBe(copy.timeline.tool)
  })
})

describe('approvalDecisions', () => {
  it('offers deny and allow-once first for every request', () => {
    expect(approvalDecisions(approval()).slice(0, 2)).toEqual(['deny', 'allow-once'])
  })

  it('adds a standing read grant only for reads', () => {
    expect(approvalDecisions(approval({ kind: 'read' }))).toContain('always-allow-reads')
    expect(approvalDecisions(approval({ kind: 'action' }))).not.toContain('always-allow-reads')
  })

  it('adds session trust only for one trustable origin', () => {
    expect(approvalDecisions(approval())).toContain('trust-session')
    expect(approvalDecisions(approval({ canTrust: false }))).not.toContain('trust-session')
    expect(approvalDecisions(approval({ origins: ['https://a.test', 'https://b.test'] }))).not.toContain('trust-session')
  })
})

describe('mergeActivity', () => {
  const first: ActivityEntry = { id: '1', kind: 'tool', name: 'browser_click', summary: 'one', origin: null, state: 'running', at: 1 }

  it('prepends newest first and replaces a row by id', () => {
    const done = { ...first, state: 'done' as const }
    expect(mergeActivity([first], done)).toEqual([done])
    const second: ActivityEntry = { ...first, id: '2', summary: 'two' }
    expect(mergeActivity([first], second).map((row) => row.id)).toEqual(['2', '1'])
  })

  it('caps the list and honors an explicit limit', () => {
    let rows: ActivityEntry[] = []
    for (let index = 0; index < 10; index += 1) rows = mergeActivity(rows, { ...first, id: String(index) }, 3)
    expect(rows.map((row) => row.id)).toEqual(['9', '8', '7'])
    expect(mergeActivity(rows, first, 0)).toEqual([])
  })
})

describe('mergeApprovals', () => {
  it('keeps one entry per id and replaces the set on a snapshot', () => {
    const live = mergeApprovals(new Map(), [approval()])
    expect(live.size).toBe(1)
    const pushed = mergeApprovals(live, [approval({ id: 'a2' })])
    expect([...pushed.keys()]).toEqual(['a1', 'a2'])
    expect(mergeApprovals(pushed, [], { full: true }).size).toBe(0)
  })

  it('never revives an id the user already answered', () => {
    const answered = new Set(['a1'])
    expect(mergeApprovals(new Map(), [approval()], { answered }).size).toBe(0)
    expect(mergeApprovals(new Map(), [approval(), approval({ id: 'a9' })], { answered }).size).toBe(1)
  })
})

describe('dsh payload readers', () => {
  it('reads text out of a content-block array', () => {
    expect(textFromBlocks([{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: ' world' }])).toBe('hello world')
    expect(textFromBlocks('nope')).toBe('')
  })

  it('extracts assistant text but ignores a tool-only message', () => {
    expect(assistantTextFromEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'done' }] } },
    })).toBe('done')
    expect(assistantTextFromEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool_use', name: 'browser_click' }] } },
    })).toBeUndefined()
    expect(assistantTextFromEvent({ type: 'tool/call' })).toBeUndefined()
  })

  it('separates a real user turn from an injected reminder', () => {
    expect(isUserAuthoredMessage({ type: 'user/message', data: { message: { source: { kind: 'user' } } } })).toBe(true)
    expect(isUserAuthoredMessage({ type: 'user/message', data: { message: { source: { kind: 'plugin' } } } })).toBe(false)
    expect(isUserAuthoredMessage({ type: 'assistant/message' })).toBe(false)
  })

  it('derives transcript rows from the legacy activity list when needed', () => {
    const legacy = state({
      timeline: [],
      activity: [
        { id: 'b', kind: 'tool', name: 'browser_click', summary: 'second', origin: null, state: 'done', at: 2 },
        { id: 'a', kind: 'tool', name: 'browser_snapshot', summary: 'first', origin: null, state: 'done', at: 1 },
      ],
    })
    expect(timelineFromState(legacy).map((row) => row.id)).toEqual(['a', 'b'])
  })
})

describe('markdown rendering', () => {
  it('renders the markup the model actually sends', () => {
    const html = renderMarkdown('**bold** and `code`\n\n- one\n- two\n\n```js\nconst a = 1\n```')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre>')
  })

  it('strips scripts, event handlers, and images', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
  })

  it('opens links safely in a new tab', () => {
    const html = renderMarkdown('[docs](https://example.com/x)')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('href="https://example.com/x"')
  })

  it('closes a fence that is still being streamed', () => {
    expect(stabilizeStreamingMarkdown('text\n```js\nconst a = 1')).toBe('text\n```js\nconst a = 1\n```')
    expect(stabilizeStreamingMarkdown('text\n```js\na\n```')).toBe('text\n```js\na\n```')
  })
})

describe('rendered panel', () => {
  function mount(initial: ControlState = state()) {
    const root = document.createElement('div')
    document.body.append(root)
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: initial })
    return { app, port, root }
  }

  it('agrees with the page it is loaded into about the mount element', () => {
    // The panel once shipped with `#root` in the stylesheet and `#control-root`
    // in the HTML. Nothing failed: the element simply had no height, every
    // percentage below it stopped resolving, and the settings sheet rendered in
    // a short box with dead space beneath it. A string has to match a string.
    const html = readFileSync(join(CONTROL_DIR, 'index.html'), 'utf8')
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8')

    const mountId = /getElementById\('([^']+)'\)/.exec(
      readFileSync(join(CONTROL_DIR, 'main.ts'), 'utf8'),
    )?.[1]
    expect(mountId).toBe('control-root')

    // The HTML must define that id, and the stylesheet must give it a height.
    expect(html).toContain(`id="${mountId}"`)
    expect(new RegExp(`#${mountId}\\s*\\{[^}]*height`).test(css)).toBe(true)
  })

  it('never lets the reading cap exceed the panel it is drawn into', () => {
    // The cap is a *maximum* column width, but it was written straight through: a panel 360px
    // wide with `readWidth` 640 set `--panel-max: 640px`, every text column laid out 640px
    // wide inside a 360px box, and the transcript's own `overflow-x: hidden` clipped the
    // content off the right edge. The panel rendered its header and composer and looked
    // blank in between — jsdom has no layout, so only a value assertion can catch it.
    const { app, root } = mount()
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 360 })

    app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth: 640 } }) })

    expect(document.documentElement.style.getPropertyValue('--panel-max')).toBe('360px')

    // A panel wider than the cap keeps the cap, and the cap still wins nowhere.
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 1400 })
    app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth: 640 } }) })
    expect(document.documentElement.style.getPropertyValue('--panel-max')).toBe('640px')
  })

  it('pins both grid axes, so no content can stretch the panel sideways', () => {
    // The blank panel, in its actual form: `.app` declared `grid-template-rows` with the
    // deliberate `minmax(0, 1fr)` guard and **no `grid-template-columns` at all**. The implicit
    // `auto` column is sized to its items' max-content, so one long unbreakable tool summary
    // stretched that column to ~2346px inside a 360px panel; `body { overflow-x: hidden }` then
    // clipped the content away and the panel drew its header and composer over empty space.
    // jsdom has no layout engine, so the guard has to be asserted on the declaration itself —
    // and the column axis is exactly the one that was forgotten here once already.
    // Comments are stripped first: a CSS comment may legitimately contain a brace (this file's
    // own note about `body { overflow-x: hidden }` does), which would end a naive rule match
    // early and make this test report a declaration that is in fact present.
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const selector of ['.app', '.sheet']) {
      const body = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(body, `${selector} rule`).toContain('display: grid')
      expect(body, `${selector} must pin its column`).toContain('grid-template-columns: minmax(0, 1fr)')
      expect(body, `${selector} must pin its row`).toContain('grid-template-rows')
    }
  })

  it('never applies a cap wider than the panel, at every width a user can drag to', () => {
    // Dragging the side panel is normal and re-applies the cap each time, so sweep the widths
    // that matter: far narrower than the cap, exactly on it, and far wider.
    //
    // Two rules, and the pair is the whole contract: the applied cap is the preference when the
    // panel is at least that wide, and the panel width when it is not. The second line is the
    // one the blank panel came from — the cap must never exceed the panel.
    const { app, root } = mount()
    let panelWidth = 0
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })

    for (const readWidth of [320, 640, 1400]) {
      for (const width of [180, 320, 360, 639, 640, 641, 900, 1400, 2560]) {
        panelWidth = width
        app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth } }) })
        const applied = Number.parseFloat(document.documentElement.style.getPropertyValue('--panel-max'))
        expect(Number.isNaN(applied), `readWidth=${readWidth} panel=${width} produced a number`).toBe(false)
        // The one invariant the blank panel violated, and the only one this test claims: the
        // cap is never wider than the panel it is drawn into. Whatever else the preference
        // means on a wide panel is not asserted here, because that is a design choice rather
        // than a defect.
        expect(applied, `readWidth=${readWidth} panel=${width} must not exceed the panel`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('survives a resize that arrives before any state does', () => {
    // The observer fires on mount, before the first `state` push. It has to fall back to the
    // default cap rather than writing `NaNpx` or leaving the previous value stranded.
    const { app, root } = mount()
    let panelWidth = 300
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })
    panelWidth = 300
    app.handleMessage({ type: 'state', state: state() })
    const applied = document.documentElement.style.getPropertyValue('--panel-max')
    expect(applied).toBe('300px')
    expect(Number.isNaN(Number.parseFloat(applied))).toBe(false)
  })

  it('anchors the settings overlay to the viewport, not to an ancestor', () => {
    // `absolute` would tie the overlay's size to the height chain above it, and a
    // broken link there is invisible until someone opens settings on a real
    // panel. `fixed` cannot be caught by it.
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8')
    for (const selector of ['.scrim', '.sheet']) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(rule, `${selector} rule`).toContain('position: fixed')
      expect(rule).toContain('inset: 0')
    }
  })

  it('renders a conversation and nothing else', () => {
    const { root } = mount()
    // The header carries only live state: the panel's own title is drawn by the
    // browser's side-panel chrome.
    expect(root.querySelector('.header__title')).toBeNull()
    expect(root.querySelector('.header .dot')).not.toBeNull()
    expect(root.querySelector('.transcript')).not.toBeNull()
    expect(root.querySelector('.composer__input')).not.toBeNull()
    // No summary card, no tutorial text, and no images at all. The task list is
    // the one thing above the transcript, and it appears only once a turn has
    // announced one, so an idle panel carries none.
    expect(root.querySelector('.summary')).toBeNull()
    expect(root.querySelector('.plan')).toBeNull()
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.textContent).not.toContain('browser_click')
    expect(root.textContent).not.toContain('其余文字交给 AI')
  })

  it('shows your message as a bubble and the reply as text', () => {
    const { root } = mount(state({
      timeline: [
        { id: 'r1', kind: 'request', text: '总结这个页面', state: 'done', at: 1 },
        { id: 'a1', kind: 'assistant', text: '**要点**：这是一个示例页面。', state: 'done', at: 2 },
      ],
    }))
    expect(root.querySelector('.msg--user .msg__bubble')?.textContent).toBe('总结这个页面')
    // The reply is rendered as markdown, not shown as punctuation.
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('要点')
    expect(root.querySelectorAll('.msg')).toHaveLength(2)
  })

  it('shows a tool run as one quiet line with a marker', () => {
    const { root } = mount(state({ timeline: [entry({ text: '点击元素 [3]' })] }))
    const line = root.querySelector('.tool-line')
    expect(line?.textContent).toContain('点击元素 [3]')
    // The state marker is an inline SVG carrying the state class; there is no
    // image anywhere in the panel.
    expect(root.querySelector('.tool-line__icon')?.tagName.toLowerCase()).toBe('svg')
    expect(root.querySelector('.tool-line .tool-line__icon')?.getAttribute('class')).toContain('tool-line__icon')
    expect(root.querySelector('.tool-detail')).toBeNull()
  })

  it('expands a tool line to its detail and collapses it again', () => {
    const { root } = mount(state({ timeline: [entry({ id: 'step-1' })] }))
    root.querySelector<HTMLButtonElement>('.tool-line')!.click()
    expect(root.querySelector('.tool-detail')?.textContent).toContain('browser_click')
    root.querySelector<HTMLButtonElement>('.tool-line')!.click()
    expect(root.querySelector('.tool-detail')).toBeNull()
  })

  it('streams the reply, then defers to the durable message', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text: '正在' } } },
    })
    // Streaming repaints are coalesced to one per frame, so the DOM catches up on the
    // frame rather than on the delta.
    flushAnimationFrames()
    expect(root.querySelector('.msg--streaming .msg__text')?.textContent).toContain('正在')
    expect(root.querySelector('.caret')).not.toBeNull()

    // The durable row replaces the streaming one: exactly one assistant message.
    app.handleMessage({
      type: 'session.event',
      sessionId: 'session-1',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '**最终答复**' }] } },
      },
    })
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a1', kind: 'assistant', text: '**最终答复**', state: 'done', at: 3 }] }),
    })
    const replies = [...root.querySelectorAll('.msg--assistant')]
    expect(replies).toHaveLength(1)
    expect(replies[0]?.querySelector('strong')?.textContent).toBe('最终答复')
  })

  it('does not render Markdown while the reply is still streaming', () => {
    // Rendering Markdown per delta re-parsed and re-sanitized the whole reply every time,
    // which is quadratic in the reply length: on a fast stream the panel fell behind and
    // never caught up, so it looked frozen rather than slow. The fenced block below is
    // exactly what a Markdown pass would turn into `pre`/`code`, so its absence in the
    // streaming bubble is the observable form of that guarantee.
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '```js\nconst x = 1\n```\n' } },
      },
    })
    // A second delta so the streaming path has run more than once.
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '**粗体**' } },
      },
    })
    flushAnimationFrames()

    const streaming = root.querySelector('.msg--streaming .msg__text')
    expect(streaming).not.toBeNull()
    // The text is present and readable, exactly as the model sent it…
    expect(streaming?.textContent).toContain('const x = 1')
    expect(streaming?.textContent).toContain('**粗体**')
    // …and unrendered: no Markdown output at all while streaming.
    expect(streaming?.querySelector('pre')).toBeNull()
    expect(streaming?.querySelector('code')).toBeNull()
    expect(streaming?.querySelector('strong')).toBeNull()
  })

  it('keeps the streaming branch free of any Markdown call', () => {
    // The DOM assertion above proves today's behavior. This one guards the shape of the
    // code, because the regression is a one-line change: putting `renderMarkdown` back into
    // the streaming branch is exactly how the freeze was introduced, and it would still
    // pass a test that only looked at what is visible.
    const source = readFileSync(join(CONTROL_DIR, 'main.ts'), 'utf8')
    const body = /private assistantBubbleChildren\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? ''
    expect(body, 'assistantBubbleChildren source').not.toBe('')

    // The streaming branch must come first and must not call renderMarkdown.
    const streamingBranch = /if \(streaming\) \{([\s\S]*?)\}/.exec(body)?.[1] ?? ''
    expect(streamingBranch, 'streaming branch').toContain('text')
    expect(streamingBranch, 'streaming branch').not.toContain('renderMarkdown')

    // Markdown is still rendered — for the finished reply.
    expect(body).toContain('renderMarkdown')
  })

  it('parses Markdown once, when the reply is finished', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    for (const text of ['一段', '回答']) {
      app.handleMessage({
        type: 'session.stream',
        event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text } } },
      })
    }
    flushAnimationFrames()
    // Still unrendered while streaming.
    expect(root.querySelector('.msg--streaming strong')).toBeNull()

    // The finished reply is rendered, which is the one place Markdown is wanted.
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a1', kind: 'assistant', text: '**完成**', state: 'done', at: 3 }] }),
    })
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('完成')
  })

  it('treats a durable running reply as streaming, not as finished', () => {
    // The real app's shape, and the one the earlier tests missed: the worker creates a
    // durable `assistant` row on the FIRST delta and keeps it `running` for the whole turn,
    // and that row arrives in `state.timeline`. Treating only the synthetic row as streaming
    // meant `.msg--streaming` never existed, so every frame rebuilt the whole transcript and
    // rendered Markdown for a reply that was still being written — the quadratic path the
    // streaming mode exists to avoid.
    const { app, root } = mount(state({
      timeline: [{ id: 'a-live', kind: 'assistant', text: '```js\nconst x = 1\n```', state: 'running', at: 1 }],
    }))
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '\nconst y = 2' } },
      },
    })
    flushAnimationFrames()

    // The running row is the streaming target, and it is rendered as plain text…
    const streaming = root.querySelector('[data-streaming] .msg__text')
    expect(streaming).not.toBeNull()
    expect(streaming?.textContent).toContain('const x = 1')
    // …not as Markdown, and not as a duplicate row.
    expect(streaming?.querySelector('pre')).toBeNull()
    expect(root.querySelectorAll('.msg--assistant')).toHaveLength(1)
  })

  it('renders the reply as Markdown once the turn ends', () => {
    // The other half of the same contract: streaming is plain, the finished reply is not.
    const { app, root } = mount(state({
      timeline: [{ id: 'a-live', kind: 'assistant', text: '**粗体**', state: 'running', at: 1 }],
    }))
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    expect(root.querySelector('[data-streaming]')).not.toBeNull()

    // `turn/end` settles the row, so it must stop being the streaming target.
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/end' } })
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a-live', kind: 'assistant', text: '**粗体**', state: 'done', at: 1 }] }),
    })
    expect(root.querySelector('[data-streaming]')).toBeNull()
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('粗体')
  })

  it('recovers when the conversation list request fails outright', async () => {
    // A dead port rejects `call()` immediately. The loading flag used to be set before the
    // call and never cleared on that path, so the guard above latched: every later attempt
    // returned early and the picker stayed on「加载中」for the rest of the panel's life.
    const port = new StubPort()
    port.failure = 'background disconnected'
    const root = document.createElement('div')
    document.body.append(root)
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: state() })

    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    // Choosing "continue a chosen one" is what asks the worker for the list.
    const conversation = [...root.querySelectorAll<HTMLSelectElement>('select')]
      .find((select) => [...select.options].some((option) => option.value === 'pinned'))
    expect(conversation, 'conversation select').not.toBeUndefined()
    conversation!.value = 'pinned'
    conversation!.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()

    // The request failed, so a second attempt must be allowed to happen.
    expect(port.calls.filter((call) => call.type === 'session.list').length).toBe(1)
    conversation!.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(port.calls.filter((call) => call.type === 'session.list').length).toBe(2)
  })

  it('keeps a cache in the Markdown path, so a rebuild does not re-parse', () => {
    // A rebuilt transcript re-rendered Markdown for every reply on screen, so an unrelated
    // update (a tool step, an approval, expanding a row) cost a parse of the whole
    // conversation. The mapping is pure, so `renderMarkdown` reuses its own result.
    //
    // The cache is not observable through the return value — the render is deterministic
    // either way — so this asserts the shape of the code, the same way the streaming-branch
    // guard does. Without the lookup, the cost the audit measured comes straight back.
    const source = readFileSync(join(CONTROL_DIR, 'markdown.ts'), 'utf8')
    const body = /export function renderMarkdown\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
    expect(body, 'renderMarkdown source').not.toBe('')
    expect(body, 'consults the cache').toContain('rendered.get(text)')
    expect(body, 'fills the cache').toContain('rendered.set(text,')
    // Bounded: an unbounded cache over a long session is a leak.
    expect(source, 'cache is bounded').toMatch(/CACHE_LIMIT\s*=\s*\d+/)
    expect(body, 'evicts').toContain('rendered.delete(')
  })

  it('still sanitizes every render, including a cache miss', () => {
    // The cache sits in front of the sanitizer, so this proves it is a cache and not a
    // bypass: a hostile string must not survive, whether or not it was seen before.
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    const first = renderMarkdown(hostile)
    const second = renderMarkdown(hostile)
    expect(first).not.toContain('<script')
    expect(first).not.toContain('onerror')
    expect(first).not.toContain('<img')
    expect(second).toBe(first)
  })

  it('repaints at most once per frame no matter how many deltas arrive', () => {    // The coalescing is the point: a burst of deltas must not produce a burst of work.
    // Element creation shows the repaint happening, so ten deltas landing in one frame
    // should cost a single small repaint rather than ten.
    const created = vi.spyOn(document, 'createElement')
    try {
      const { app, root } = mount()
      app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
      flushAnimationFrames()
      created.mockClear()

      // One frame's worth of deltas — far more than a display refresh would deliver.
      for (const text of ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']) {
        app.handleMessage({
          type: 'session.stream',
          event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text } } },
        })
      }
      // No frame has run yet, so no repaint has happened.
      expect(created).not.toHaveBeenCalled()

      flushAnimationFrames()
      // Ten deltas, one repaint. The exact number of elements is an implementation detail;
      // that it is a single small repaint rather than ten is the guarantee being locked in.
      expect(created.mock.calls.length).toBeGreaterThan(0)
      expect(created.mock.calls.length).toBeLessThan(10)
      expect(root.querySelector('.msg--streaming .msg__text')?.textContent).toContain('十')
    } finally {
      created.mockRestore()
    }
  })

  it('ignores a stream that belongs to another session', () => {
    const { app, root } = mount()
    app.handleMessage({
      type: 'session.stream',
      event: { sessionId: 'other', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text: '泄漏' } } },
    })
    expect(root.textContent).not.toContain('泄漏')
  })

  it('never turns page or model text into markup', () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const { app, root } = mount(state({
      timeline: [entry({ text: payload })],
      affinity: tab({ controlled: { tabId: 1, windowId: 1, title: payload, url: 'https://evil.test' } }),
    }))
    app.handleMessage({ type: 'approval.request', request: approval({ summary: payload, origins: [payload] }) })
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelectorAll('script')).toHaveLength(0)
    expect(root.textContent).toContain(payload)
  })

  it('answers an approval through the port and drops the card', () => {
    const { app, port, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval() })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.approval__actions button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['不允许', '允许', '这个网站以后不用问'])
    buttons[1]!.click()
    expect(port.sent).toContainEqual({ type: 'approval.respond', id: 'a1', decision: 'allow-once' })
    expect(root.querySelector('.approval')).toBeNull()
  })

  it('offers the tab handoff choice with the live revision', () => {
    const { app, port, root } = mount()
    app.handleMessage({ type: 'state', state: state({ affinity: tab({ revision: 7, status: 'handoff' }) }) })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.notice__actions button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['留在原页面', '跟过去', '留在这里，不再问'])
    buttons[1]!.click()
    expect(port.sent).toContainEqual({ type: 'affinity.respond', revision: 7, decision: 'follow' })
  })

  it('keeps settings behind the gear, over the conversation', () => {
    const { root } = mount()
    expect(root.querySelector('.sheet')).toBeNull()
    const gear = root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!
    gear.click()
    expect(root.querySelector('.sheet')).not.toBeNull()
    expect(root.querySelector('.sheet__title')?.textContent).toBe('更改设置')
    // The transcript stays mounted underneath.
    expect(root.querySelector('.transcript')).not.toBeNull()
    // Only what the user asked to keep. The trust lists, the auto-connect
    // switch, the panel-width control, and the entire connection section are
    // gone: each was either a question this path already answers or a promise
    // the panel cannot keep.
    for (const dead of ['永久信任', '临时信任', '自动连接', '固定面板宽度', '桥接地址', '桥接 token', '保存']) {
      expect(root.textContent).not.toContain(dead)
    }
    // Every remaining control is a choice: two switches, four selects (sharing,
    // conversation, tab switch, image recognition), and not a single text field to
    // wonder about. Where the image call goes is deployment configuration; asking a
    // user for an endpoint, a model id and a key would be three chores, not choices.
    expect(root.querySelectorAll('.sheet .switch input')).toHaveLength(2)
    expect(root.querySelectorAll('.sheet .select')).toHaveLength(4)
    expect(root.querySelectorAll('.sheet input[type="text"], .sheet input[type="password"]')).toHaveLength(0)
    root.querySelector<HTMLButtonElement>('.sheet [aria-label="关闭"]')!.click()
    expect(root.querySelector('.sheet')).toBeNull()
  })

  it('offers no control that the browser cannot honour', () => {
    // A side panel's width is dragged and remembered by Chrome; an extension
    // cannot read, set, or lock it, so offering a "fixed width" switch would be
    // a promise the panel cannot keep.
    const { root } = mount()
    expect(root.querySelectorAll('[aria-pressed]')).toHaveLength(0)
    expect(root.textContent).not.toContain('固定')
  })

  it('opens with an empty composer whose hint is short and only a placeholder', () => {
    // The hint is an attribute, never a value: the box must not open with text
    // already in it. It is also just a short label now — no command examples.
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('输入要做什么')
    expect(input.textContent).toBe('')
    expect(root.textContent).not.toContain('browser_click')
  })

  it('keeps the composer empty across a repaint', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'state', state: state({ activity: [] }) })
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    expect(input.value).toBe('')
    expect(root.textContent).not.toContain('browser_click')
  })

  it('shows the formula while an @ directive is being typed, and its error when wrong', () => {
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    const type = (value: string): void => {
      input.value = value
      input.dispatchEvent(new Event('input'))
    }

    // Nothing typed: the row stays empty, as the user asked.
    expect(root.querySelector('.composer__meta')?.textContent).toBe('')
    // A partial directive shows the formula rather than complaining.
    type('@o')
    expect(root.querySelector('.composer__hint')?.textContent).toContain('@open')
    // A bad formula reports why instead of silently becoming prose.
    type('@open nonsense')
    expect(root.querySelector('.composer__error')?.textContent).toContain('网址')
    // A good one stops complaining.
    type('@open https://example.com')
    expect(root.querySelector('.composer__error')).toBeNull()
    expect(root.querySelector('.composer__hint')?.textContent).toContain('@open')
  })

  it('runs an @open directive through the background, not the model', async () => {
    const { port, root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '@open https://store.steampowered.com pace=slow pin=off'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await vi.waitFor(() => { expect(port.calls).toHaveLength(1) })
    expect(port.calls[0]).toMatchObject({
      type: 'open.run',
      url: 'https://store.steampowered.com/',
      pace: 'slow',
      pin: false,
    })
    // The whole point: the model is not asked to do this.
    expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(false)
  })

  it('opens the approval card by saying what is being asked', () => {
    // The card used to start with the tool's own summary ("点击元素 [3]"), which
    // reads like machine output: the user had to work out that this was a
    // question at all. The first line now asks it.
    const { app, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval({ kind: 'read' }) })
    expect(root.querySelector('.approval__ask')?.textContent).toBe('AI 想读取这个页面')

    app.handleMessage({ type: 'approval.request', request: approval({ id: 'a2', kind: 'action' }) })
    const asks = [...root.querySelectorAll('.approval__ask')].map((node) => node.textContent)
    expect(asks).toContain('AI 想操作这个页面')
  })

  it('offers buttons that read as allowing or refusing', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval() })
    const labels = [...root.querySelectorAll<HTMLButtonElement>('.approval__actions button')]
      .map((button) => button.textContent)
    // "允许" has to appear: the user is deciding whether to permit something, and
    // a button set of 拒绝/仅这一次 never says that out loud.
    expect(labels.some((label) => label?.includes('允许'))).toBe(true)
    expect(labels).toContain('不允许')
  })

  it('runs a typed browser command without asking the model', async () => {
    const { port, root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = 'click index=3'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => { expect(port.calls).toHaveLength(1) })
    expect(port.calls[0]).toMatchObject({ type: 'command.run', name: 'browser_click', args: { index: 3 } })
    expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(false)
  })

  it('forwards natural language and creates the session once', async () => {
    const { port, root } = mount(state({ session: { id: null, turn: 'idle', pendingPrompt: false } }))
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '总结这个页面'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => {
      expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(true)
    }, { timeout: 2_000 })
    expect(port.calls[0]?.type).toBe('session.create')
    expect(port.calls[1]).toMatchObject({ type: 'session.prompt', text: '总结这个页面' })
  })

  it('reports a failed command inline and keeps the text for correction', async () => {
    const { app, port, root } = mount()
    port.failure = '拒绝执行'
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = 'browser_close_tab tabId=9'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => { expect(root.querySelector('.composer__meta')?.textContent).toContain('拒绝执行') })
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value).toBe('browser_close_tab tabId=9')
    app.dispose()
  })

  it('swaps the send button for a stop control while a turn runs', () => {
    const { app, root } = mount()
    expect(root.querySelector<HTMLButtonElement>('.composer__box button')?.getAttribute('aria-label')).toBe('发送')
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    expect(root.querySelector<HTMLButtonElement>('.composer__box button')?.getAttribute('aria-label')).toBe('停止')
  })

  it('writes each settings control through a settings update', () => {
    const { root, port } = mount()
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const select = root.querySelector<HTMLSelectElement>('.select')!
    select.value = 'off'
    select.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { sharePageContent: 'off' },
    }))
    // Two switches: auto-open and unrestricted control.
    const toggles = [...root.querySelectorAll<HTMLInputElement>('.switch input')]
    expect(toggles).toHaveLength(2)
    toggles[0]!.checked = false
    toggles[0]!.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { autoOpenPanel: false },
    }))
    toggles[1]!.checked = true
    toggles[1]!.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { unrestrictedBrowserAccess: true },
    }))
    // The tab-switch select writes its mode too. Order in the sheet is sharing,
    // conversation, tab switch — hence index 2.
    const tabSwitch = [...root.querySelectorAll<HTMLSelectElement>('.select')][2]!
    tabSwitch.value = 'follow'
    tabSwitch.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { tabSwitch: 'follow' },
    }))
  })

  it('asks the worker for conversations when "continue a chosen one" is picked', async () => {
    const { root, port } = mount()
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const conversation = [...root.querySelectorAll<HTMLSelectElement>('.select')][1]!
    conversation.value = 'pinned'
    conversation.dispatchEvent(new Event('change'))

    // It does not pick for the user: it asks for the list and shows a placeholder.
    await vi.waitFor(() => {
      expect(port.calls.some((call) => call.type === 'session.list')).toBe(true)
    })
    expect(port.calls.some((call) => call.type === 'session.select')).toBe(false)
  })

  it('routes only after a conversation is actually chosen', () => {
    const sessions = [
      { sessionId: 's-2', title: '部署排查', preview: '帮我看看这个部署错误', updatedAt: Date.now(), running: false },
      { sessionId: 's-1', title: '', preview: '', updatedAt: Date.now() - 60_000, running: true },
    ]
    const { app, root, port } = mount(state({
      settings: { ...SETTINGS_DEFAULTS, sessionScope: 'pinned', pinnedSessionId: null },
    }))
    app.handleMessage({ type: 'session.list', id: 'l1', ok: true, sessions })

    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const picker = root.querySelector<HTMLSelectElement>('[aria-label="选择对话"]')!
    expect([...picker.options].map((option) => option.value)).toContain('s-2')
    // An untitled conversation still gets a readable label.
    expect([...picker.options].map((option) => option.textContent).join(' ')).toContain('未命名')

    picker.value = 's-2'
    picker.dispatchEvent(new Event('change'))
    expect(port.calls).toContainEqual(expect.objectContaining({
      type: 'session.select',
      scope: 'pinned',
      sessionId: 's-2',
    }))
  })

  it('does not attach a session id that the list did not offer', () => {
    // A stale pinned id from storage must not be presented as a valid choice:
    // the picker shows a placeholder until the user picks a real conversation.
    const { root } = mount(state({
      settings: { ...SETTINGS_DEFAULTS, sessionScope: 'pinned', pinnedSessionId: 'gone-session' },
    }))
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const picker = root.querySelector<HTMLSelectElement>('[aria-label="选择对话"]')!
    expect([...picker.options].map((option) => option.value)).toEqual([''])
  })

  it('reports the connection state on the first row, not the permission value', () => {
    // Before a handshake there is no policy, and showing "not allowed" for that
    // made a healthy extension look broken. The badge answers "am I connected?";
    // whether pages may be opened belongs to the help line. The label names the
    // desktop as the side that decides, so the badge cannot read as "the feature
    // is off" — "Not connected" next to "the AI can open pages" could.
    const { app, root } = mount(state({ policy: null }))
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const firstRow = root.querySelector('.sheet .setting')!
    expect(firstRow.querySelector('.setting__label')?.textContent).toBe('桌面端允许 AI 打开网页')
    expect(firstRow.querySelector('.badge')?.textContent).toBe('未连接')
    expect(firstRow.querySelector('.setting__help')?.textContent).toContain('还没连上桌面端')

    // Once connected, the badge says so even when the feature itself is off.
    app.handleMessage({ type: 'state', state: state({ policy: { openPagesForUser: false } }) })
    const connectedRow = root.querySelector('.sheet .setting')!
    expect(connectedRow.querySelector('.badge')?.textContent).toBe('已连接')
    expect(connectedRow.querySelector('.setting__help')?.textContent).toContain('不会打开新网页')
  })

  it('labels the two choices the user asked for by name', () => {
    const { root } = mount()
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const selects = [...root.querySelectorAll<HTMLSelectElement>('.select')]
    const tabSwitch = selects.find((select) => select.getAttribute('aria-label') === 'AI 跟随标签页')!
    expect([...tabSwitch.options].map((option) => option.textContent)).toContain('跟随')
    const conversation = selects.find((select) => select.getAttribute('aria-label') === '对话发到')!
    expect([...conversation.options].map((option) => option.textContent)).toContain('当前对话')
  })

  it('says why the panel is not following a conversation, instead of just looking empty', () => {
    // The commonest cause is a desktop app still running an older bridge that does
    // not know `session.follow`. Bound-but-not-updating and nothing-to-show look
    // identical without this notice.
    const { root } = mount(state({ followError: '桌面端还没加载新版桥接，面板无法跟随对话。重启 dsh 桌面端后重试。' }))
    expect(root.querySelector('.notice')?.textContent).toContain('重启 dsh 桌面端')
  })

  it('shows no such notice when following is fine', () => {
    const { root } = mount()
    expect(root.textContent).not.toContain('无法跟随')
  })

  it('says another browser took the connection and offers to take it back', () => {
    // A replaced client deliberately stops retrying, so a generic "reconnecting"
    // or "reload the page" notice would hide the one fact that explains it.
    const { app, root, port } = mount(state({ replaced: true, bridge: 'stopped' }))
    const notice = root.querySelector('.notice--warning')
    expect(notice?.textContent).toContain('另一个浏览器窗口')

    const button = notice?.querySelector<HTMLButtonElement>('.notice__action')
    expect(button?.textContent).toBe('取回连接')
    button!.click()
    expect(port.sent).toContainEqual({ type: 'bridge.reclaim' })

    // Once the slot comes back, the notice goes away.
    app.handleMessage({ type: 'state', state: state({ replaced: false, bridge: 'connected' }) })
    expect(root.querySelector('.notice__action')).toBeNull()
  })

  it('classifies the composer draft the same way the submit path does', () => {
    expect(classifyInput('snapshot')).toMatchObject({ kind: 'command' })
    expect(classifyInput('看看这个页面')).toMatchObject({ kind: 'prompt' })
  })

  it('puts the opening prompt in the picker, because titles collide', () => {
    // Two conversations about the same subject get near-identical desktop titles, and
    // a picker that shows only those is a coin flip. The opening prompt is what tells
    // them apart, and it is dropped only when it would merely repeat the title.
    const copy = controlCopy('zh')
    const at = new Date(2026, 0, 2, 3, 4).getTime()
    expect(sessionLabel(
      { sessionId: 's', title: '看视频', preview: '打开哔哩哔哩罗肖尼的视频并介绍', updatedAt: at, running: true },
      copy,
    )).toBe('看视频 · 打开哔哩哔哩罗肖尼的视频并介绍 · 进行中 · 1/2 03:04')
    // Repeating the title would waste the one line the dropdown has.
    expect(sessionLabel(
      { sessionId: 's', title: '看视频', preview: '看视频', updatedAt: 0, running: false },
      copy,
    )).toBe('看视频')
    // No prompt disclosed: the title has to carry it alone.
    expect(sessionLabel(
      { sessionId: 's', title: '看视频', preview: '  ', updatedAt: 0, running: false },
      copy,
    )).toBe('看视频')
  })

  it('marks a running conversation in the picker, ahead of its timestamp', () => {
    // The picker lists dozens of conversations whose titles repeat — every sub-agent
    // conversation is titled with its own prompt. `running` is the one signal that
    // identifies the conversation the desktop is working in, so it has to survive a
    // narrow dropdown: it sits after the name and before the timestamp, and the
    // timestamp is what gets truncated.
    const copy = controlCopy('zh')
    const at = new Date(2026, 0, 2, 3, 4).getTime()
    expect(sessionLabel({ sessionId: 's', title: '看视频', preview: '', updatedAt: at, running: true }, copy))
      .toBe('看视频 · 进行中 · 1/2 03:04')
    expect(sessionLabel({ sessionId: 's', title: '看视频', preview: '', updatedAt: at, running: false }, copy))
      .toBe('看视频 · 1/2 03:04')
    expect(sessionLabel({ sessionId: 's', title: '看视频', preview: '', updatedAt: 0, running: true }, copy))
      .toBe('看视频 · 进行中')
    expect(sessionLabel({ sessionId: 's', title: '  ', preview: '', updatedAt: 0, running: false }, copy))
      .toBe('未命名')
  })
})
