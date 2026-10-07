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
      { sessionId: 's-2', title: '部署排查', updatedAt: Date.now(), running: false },
      { sessionId: 's-1', title: '', updatedAt: Date.now() - 60_000, running: true },
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
})
