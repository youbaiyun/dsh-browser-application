/**
 * The side panel: a conversation with dsh, plus one settings sheet.
 *
 * This is deliberately the same shape as the desktop client. The transcript is
 * the whole interface — your message, the model's reply rendered as Markdown,
 * and one quiet line for each tool it ran. The one addition to that shape is the
 * **task list** for a multi-step turn: the model writes the checklist it is about
 * to run and the panel shows it above the run with a per-task state, because a
 * list of tool calls alone cannot say what the job is or how much of it is left.
 * There is still no summary card, no progress bar and no artwork.
 *
 * Two inputs share the composer:
 *   - a browser command (`browser_click {"index":3}`, `click index=3`, a URL) is
 *     executed by the extension itself, because the user typed it;
 *   - anything else is forwarded to the desktop dsh model, whose streamed reply
 *     is rendered here.
 *
 * The page owns no policy: approvals, tab binding, and the unrestricted switch
 * all live in the background worker, and this file only renders what it is
 * handed.
 *
 * @module
 */

import {
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  normalizeSettings,
  type ActivityEntry,
  type ControlMessage,
  type ControlRequest,
  type ControlState,
  type SessionSummary,
  type Settings,
  type TimelineEntry,
} from '../src/settings.ts'
import type { ApprovalDecision, ApprovalRequest } from '../src/security/approval.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'
import { getUiLocale, type UiLocale } from '../src/i18n.ts'
import { classifyInput, isSoftOpenError, type InputIntent } from './command.ts'
import { hasMarkdownContent, renderMarkdown } from './markdown.ts'
import { icon, markerIcon, type IconName } from './icons.ts'
import { controlCopy, describeOpenError, type ControlCopy } from './strings.ts'
import { parsePlan, planProgress, type Plan } from '@dsh-browser/protocol'

/** How long a reconnect waits before the page reports the worker as gone. */
export const RECONNECT_DELAY_MS = 250

/** Rows kept when only the legacy activity list is available. */
export const ACTIVITY_LIMIT = 200

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The connection word for one bridge state. */
export function bridgeStateText(state: ControlState['bridge'], copy: ControlCopy): string {
  return copy.bridge[state] ?? copy.bridge.stopped
}

/** One line naming what the worker controls. */
export function controlledTabText(affinity: TabAffinityState, copy: ControlCopy): string {
  const tab = affinity.controlled
  if (tab === null) return copy.tab.none
  const title = tab.title.trim() === '' ? tab.url : tab.title
  return title === '' ? copy.tab.none : title
}

/** The decisions offered for one approval, in display order. */
export function approvalDecisions(request: ApprovalRequest): ApprovalDecision[] {
  const decisions: ApprovalDecision[] = ['deny', 'allow-once']
  if (request.kind !== 'action') decisions.push('always-allow-reads')
  if (request.kind === 'action' && request.canTrust && request.origins.length === 1) decisions.push('trust-session')
  return decisions
}

/** Merge one activity push into the list, newest first, deduplicated by id. */
export function mergeActivity(existing: ActivityEntry[], entry: ActivityEntry, limit = ACTIVITY_LIMIT): ActivityEntry[] {
  const merged = [entry, ...existing.filter((candidate) => candidate.id !== entry.id)]
  return merged.slice(0, Math.max(0, limit))
}

/** Merge an approval snapshot or live push, keyed by request id. */
export function mergeApprovals(
  current: ReadonlyMap<string, ApprovalRequest>,
  incoming: readonly ApprovalRequest[],
  options: { full?: boolean; answered?: ReadonlySet<string> } = {},
): Map<string, ApprovalRequest> {
  const next = new Map<string, ApprovalRequest>(options.full === true ? [] : current)
  for (const request of incoming) {
    if (options.answered?.has(request.id) === true) continue
    next.set(request.id, request)
  }
  return next
}

/** Pull plain text out of a dsh content-block array. */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * The assistant text carried by one `session/event`.
 *
 * A tool-calling turn also emits `assistant/message` events whose content is
 * only `tool_use` blocks; those must not blank the reply, so an all-empty result
 * returns `undefined` rather than an empty string.
 */
export function assistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'assistant/message') return undefined
  const data = isRecord(event.data) ? event.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : undefined
  const text = textFromBlocks(message?.content ?? data?.content)
  return text.trim() === '' ? undefined : text
}

/** Whether a `user/message` event is a real turn rather than an injected reminder. */
export function isUserAuthoredMessage(event: unknown): boolean {
  if (!isRecord(event) || event.type !== 'user/message') return false
  const data = isRecord(event.data) ? event.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : data
  const source = message !== undefined && isRecord(message.source) ? message.source : undefined
  return source?.kind === 'user'
}

/** A readable label for one tool name. */
export function toolLabel(tool: string | undefined, copy: ControlCopy): string {
  if (tool === undefined || tool === '') return copy.timeline.tool
  const bare = tool.startsWith('browser_') ? tool.slice('browser_'.length) : tool
  return bare.replace(/_/g, ' ')
}

/** Human wording for one step state, used in the tool line's title only. */
export function stateText(state: TimelineEntry['state'], locale: UiLocale): string {
  const zh = locale === 'zh'
  switch (state) {
    case 'done': return zh ? '已完成' : 'Done'
    case 'failed': return zh ? '失败' : 'Failed'
    case 'denied': return zh ? '已拒绝' : 'Denied'
    case 'cancelled': return zh ? '已取消' : 'Cancelled'
    case 'running': return zh ? '进行中' : 'Running'
    default: return zh ? '等待中' : 'Pending'
  }
}

/** A readable label for one conversation, for the picker. */
export function sessionLabel(session: SessionSummary, copy: ControlCopy): string {
  const title = session.title.trim()
  const name = title === '' ? copy.settings.conversationUntitled : title
  // The opening prompt is what actually distinguishes two conversations, because
  // titles collide by design — the desktop names a conversation after its subject, so
  // two conversations about the same video get near-identical names. It is dropped
  // only when it would merely repeat the title.
  const preview = session.preview.trim()
  const parts = [name]
  if (preview !== '' && preview !== name) parts.push(preview)
  // The running marker comes before the timestamp, so a narrowed picker truncates the
  // timestamp rather than the facts that identify the conversation.
  if (session.running) parts.push(copy.settings.conversationRunning)
  if (session.updatedAt > 0) {
    const when = new Date(session.updatedAt)
    const stamp = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    parts.push(stamp)
  }
  return parts.join(' · ')
}

/** Every row of the transcript, oldest first. */
export function timelineFromState(state: ControlState): TimelineEntry[] {
  if (state.timeline.length > 0) return state.timeline
  return state.activity.slice().reverse().map((entry) => ({
    id: entry.id,
    kind: 'step' as const,
    text: entry.summary,
    tool: entry.name,
    state: entry.state,
    at: entry.at,
    callId: entry.id,
  }))
}

/* ------------------------------------------------------------------ *
 * DOM construction
 * ------------------------------------------------------------------ */

interface ElementOptions {
  className?: string
  text?: string
  attributes?: Record<string, string>
  children?: (Node | null | undefined)[]
  on?: Record<string, (event: Event) => void>
}

/**
 * Build one element.
 *
 * `text` always goes through `textContent`. The one place that assigns HTML is
 * the assistant bubble, and that path sanitizes with DOMPurify first.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.className !== undefined) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  for (const [name, value] of Object.entries(options.attributes ?? {})) node.setAttribute(name, value)
  for (const [event, handler] of Object.entries(options.on ?? {})) node.addEventListener(event, handler)
  for (const child of options.children ?? []) {
    if (child !== null && child !== undefined) node.append(child)
  }
  return node
}

function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  return el('button', {
    className: 'btn btn--icon',
    attributes: { type: 'button', title: label, 'aria-label': label },
    on: { click: onClick },
    children: [icon(name, 16)],
  })
}

/* ------------------------------------------------------------------ *
 * Port client
 * ------------------------------------------------------------------ */

interface PendingCall {
  resolve: (value: { sessionId?: string }) => void
  reject: (error: Error) => void
}

/** Port client for the `dsh-control` channel, with one reconnect attempt. */
export class ControlPort {
  private port: chrome.runtime.Port | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private readonly pending = new Map<string, PendingCall>()

  constructor(
    private readonly onMessage: (message: ControlMessage) => void,
    private readonly onStatusChange: (connected: boolean) => void,
  ) {}

  get connected(): boolean {
    return this.port !== null
  }

  /** Open the port, retrying once when the disconnect was not our own doing. */
  connect(allowRetry = true): void {
    if (this.port !== null) return
    if (typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) {
      this.onStatusChange(false)
      return
    }
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: CONTROL_PORT_NAME })
    } catch {
      this.onStatusChange(false)
      return
    }
    this.port = port
    this.onStatusChange(true)
    port.onMessage.addListener((message: unknown) => this.deliver(message))
    // A worker that woke up just before this page opened already sent its push.
    this.post({ type: 'state.request' })
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      this.port = null
      this.failAll(new Error('background disconnected'))
      this.onStatusChange(false)
      if (!allowRetry) return
      this.retry = setTimeout(() => {
        this.retry = null
        if (this.port === null) this.connect(false)
      }, RECONNECT_DELAY_MS)
    })
  }

  /** Send one control request; a dead port reports failure instead of throwing. */
  post(message: ControlRequest): boolean {
    const port = this.port
    if (port === null) return false
    try {
      port.postMessage(message)
      return true
    } catch {
      this.port = null
      this.failAll(new Error('background disconnected'))
      this.onStatusChange(false)
      return false
    }
  }

  /** Send a request that is answered with a `session.result` frame. */
  call(message: ControlRequest): Promise<{ sessionId?: string }> {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      if (!this.post({ ...message, id } as ControlRequest)) {
        reject(new Error('background disconnected'))
        return
      }
      this.pending.set(id, { resolve, reject })
    })
  }

  dispose(): void {
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    const port = this.port
    this.port = null
    try {
      port?.disconnect()
    } catch {
      // Already gone.
    }
  }

  private failAll(error: Error): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id)
      call.reject(error)
    }
  }

  private deliver(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    switch (raw.type) {
      case 'state': {
        const state = parseControlState(raw.state)
        if (state !== null) this.onMessage({ type: 'state', state })
        return
      }
      case 'activity': {
        const entry = parseActivity(raw.entry)
        if (entry !== null) this.onMessage({ type: 'activity', entry })
        return
      }
      case 'approval.request': {
        const request = parseApproval(raw.request)
        if (request !== null) this.onMessage({ type: 'approval.request', request })
        return
      }
      case 'session.stream':
        this.onMessage({ type: 'session.stream', event: raw.event as never })
        return
      case 'session.event':
        this.onMessage({ type: 'session.event', sessionId: String(raw.sessionId ?? ''), event: raw.event })
        return
      case 'session.result': {
        if (typeof raw.id !== 'string') return
        const call = this.pending.get(raw.id)
        if (call === undefined) return
        this.pending.delete(raw.id)
        if (raw.ok === true) call.resolve({ ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}) })
        else call.reject(new Error(typeof raw.error === 'string' ? raw.error : 'request failed'))
        return
      }
      case 'settings.result':
      case 'affinity.rebind.result': {
        if (typeof raw.id !== 'string') return
        if (raw.ok === true) this.onMessage({ type: raw.type, id: raw.id, ok: true })
        else this.onMessage({ type: raw.type, id: raw.id, ok: false, error: String(raw.error ?? 'unknown') })
        return
      }
      default:
        return
    }
  }
}

/* ------------------------------------------------------------------ *
 * Payload validation
 * ------------------------------------------------------------------ */

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseAffinityTab(value: unknown): TabAffinityState['controlled'] {
  if (!isRecord(value) || typeof value.tabId !== 'number' || typeof value.windowId !== 'number') return null
  return {
    tabId: value.tabId,
    windowId: value.windowId,
    title: stringOr(value.title, ''),
    url: stringOr(value.url, ''),
  }
}

const AFFINITY_STATUSES: readonly TabAffinityState['status'][] = ['unbound', 'following', 'handoff', 'background', 'lost']
const BRIDGE_STATES: readonly ControlState['bridge'][] = ['connecting', 'connected', 'reconnecting', 'stopped']
const ENTRY_STATES: readonly TimelineEntry['state'][] = ['pending', 'running', 'done', 'failed', 'denied', 'cancelled']
const ENTRY_KINDS: readonly TimelineEntry['kind'][] = ['request', 'assistant', 'step']

function parseTimelineEntry(value: unknown): TimelineEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  return {
    id: value.id,
    kind: ENTRY_KINDS.find((kind) => kind === value.kind) ?? 'step',
    text: stringOr(value.text, ''),
    ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
    state: ENTRY_STATES.find((state) => state === value.state) ?? 'pending',
    at: numberOr(value.at, Date.now()),
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
  }
}

function parseActivity(value: unknown): ActivityEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  return {
    id: value.id,
    name: stringOr(value.name, ''),
    summary: stringOr(value.summary, ''),
    kind: value.kind === 'command' ? 'command' : 'tool',
    origin: typeof value.origin === 'string' ? value.origin : null,
    state: ENTRY_STATES.find((state) => state === value.state) ?? 'running',
    at: numberOr(value.at, Date.now()),
  }
}

function parseApproval(value: unknown): ApprovalRequest | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  const request: ApprovalRequest = {
    id: value.id,
    kind: value.kind === 'action' ? 'action' : 'read',
    action: stringOr(value.action, ''),
    summary: stringOr(value.summary, ''),
    origins: Array.isArray(value.origins)
      ? value.origins.filter((origin): origin is string => typeof origin === 'string')
      : [],
    canTrust: value.canTrust === true,
  }
  if (typeof value.sessionId === 'string') request.sessionId = value.sessionId
  return request
}

function parseControlState(value: unknown): ControlState | null {
  if (!isRecord(value)) return null
  const session = isRecord(value.session) ? value.session : {}
  const affinity = isRecord(value.affinity) ? value.affinity : {}
  const caps = isRecord(value.caps) ? value.caps : null
  return {
    enabled: value.enabled !== false,
    bridge: BRIDGE_STATES.find((state) => state === value.bridge) ?? 'stopped',
    caps: caps === null
      ? null
      : {
          snapshotMaxChars: numberOr(caps.snapshotMaxChars, 0),
          maxInteractiveItems: numberOr(caps.maxInteractiveItems, 0),
        },
    affinity: {
      revision: numberOr(affinity.revision, 0),
      status: AFFINITY_STATUSES.find((status) => status === affinity.status) ?? 'unbound',
      controlled: parseAffinityTab(affinity.controlled),
      active: parseAffinityTab(affinity.active),
      pinned: affinity.pinned === true,
    },
    approvals: Array.isArray(value.approvals)
      ? value.approvals.map(parseApproval).filter((entry): entry is ApprovalRequest => entry !== null)
      : [],
    settings: normalizeSettings(isRecord(value.settings) ? value.settings as Partial<Settings> : undefined),
    sessionTrustedOrigins: Array.isArray(value.sessionTrustedOrigins)
      ? value.sessionTrustedOrigins.filter((origin): origin is string => typeof origin === 'string')
      : [],
    activity: Array.isArray(value.activity)
      ? value.activity.map(parseActivity).filter((entry): entry is ActivityEntry => entry !== null)
      : [],
    session: {
      id: typeof session.id === 'string' ? session.id : null,
      turn: session.turn === 'running' ? 'running' : 'idle',
      pendingPrompt: session.pendingPrompt === true,
    },
    timeline: Array.isArray(value.timeline)
      ? value.timeline.map(parseTimelineEntry).filter((entry): entry is TimelineEntry => entry !== null)
      : [],
    // Absent or malformed reads as null, which the panel shows as "not allowed":
    // an unreadable policy must not look like permission.
    policy: isRecord(value.policy) && typeof value.policy.openPagesForUser === 'boolean'
      ? { openPagesForUser: value.policy.openPagesForUser }
      : null,
    replaced: value.replaced === true,
    // A string or nothing; anything else is treated as no error, so a malformed
    // push cannot put a non-sentence in front of the user.
    followError: typeof value.followError === 'string' && value.followError !== '' ? value.followError : null,
  }
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

interface RunState {
  /** Text the model has produced for the current turn. */
  assistantText: string
  /**
   * The task list this turn announced, once it has announced one.
   *
   * The model re-emits the checklist with boxes ticked as it advances, so this
   * holds the most complete version seen rather than the newest: a streaming
   * fragment would otherwise replace a finished list with a partial one.
   */
  plan: Plan | null
}

/**
 * Keep the more complete of two versions of the same checklist.
 *
 * The model writes the list, then writes it again with boxes ticked. While the
 * second copy streams in it is initially *shorter* than the first, so "newest
 * wins" would visibly truncate the task list on every update. The longer list is
 * the same plan; only when both are equally long is the newer one the truthful
 * one, because that is when the boxes carry progress.
 */
export function preferPlan(current: Plan | null, candidate: Plan | null): Plan | null {
  if (candidate === null) return current
  if (current === null) return candidate
  if (current.tasks.length !== candidate.tasks.length) {
    return candidate.tasks.length > current.tasks.length ? candidate : current
  }
  const progress = planProgress(candidate)
  const before = planProgress(current)
  return progress.done + progress.failed >= before.done + before.failed ? candidate : current
}

function emptyAffinity(): TabAffinityState {
  return { revision: 0, status: 'unbound', controlled: null, active: null, pinned: false }
}

export class App {
  private state: ControlState | null = null
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly answered = new Set<string>()
  private readonly expanded = new Set<string>()
  private activity: ActivityEntry[] = []
  private run: RunState = { assistantText: '', plan: null }
  private backgroundDown = false
  private notice: string | null = null
  private composerError: string | null = null
  private settingsOpen = false
  /** Desktop conversations, fetched on demand for the session picker. */
  private sessions: SessionSummary[] = []
  private sessionsLoading = false
  private draft = ''
  private busy = false
  /** True while the draft should be left alone, so a re-render never eats it. */
  private pinnedScroll = true

  constructor(
    private readonly root: HTMLElement,
    private readonly locale: UiLocale,
    private readonly port: ControlPort,
    private readonly copy: ControlCopy,
  ) {}

  start(): void {
    document.title = this.copy.documentTitle
    document.documentElement.lang = this.locale
    this.render()
    this.port.connect()
  }

  /**
   * Apply the reading cap.
   *
   * The panel's width is the browser's business — the user drags it and the
   * browser remembers it — so this only bounds how wide a text column may grow.
   * A narrower panel is always used in full.
   */
  private applyReadWidth(): void {
    const width = this.state?.settings.readWidth ?? SETTINGS_DEFAULTS.readWidth
    document.documentElement.style.setProperty('--panel-max', `${width}px`)
  }

  dispose(): void {
    this.port.dispose()
  }

  /* ---- messages ---- */

  handleMessage(message: ControlMessage): void {
    switch (message.type) {
      case 'state': {
        const parsed = parseControlState(message.state)
        if (parsed === null) return
        this.state = parsed
        this.backgroundDown = false
        const snapshot = mergeApprovals(this.approvals, parsed.approvals, { full: true, answered: this.answered })
        this.approvals.clear()
        for (const [id, request] of snapshot) this.approvals.set(id, request)
        for (const id of this.answered) {
          if (!this.approvals.has(id)) this.answered.delete(id)
        }
        this.activity = parsed.activity.slice(0, ACTIVITY_LIMIT)
        if (parsed.session.turn === 'idle' && !parsed.session.pendingPrompt) this.busy = false
        this.applyReadWidth()
        this.render()
        return
      }
      case 'activity':
        this.activity = mergeActivity(this.activity, message.entry)
        this.renderTranscript()
        return
      case 'approval.request': {
        if (this.answered.has(message.request.id)) return
        this.approvals.set(message.request.id, message.request)
        this.renderTranscript()
        return
      }
      case 'session.stream':
        this.applyStream(message.event)
        return
      case 'session.event':
        this.applySessionEvent(message.sessionId, message.event)
        return
      case 'session.list':
        this.sessionsLoading = false
        if (message.ok) this.sessions = message.sessions
        else this.composerError = message.error
        this.render()
        return
      case 'settings.result':
        this.notice = message.ok ? null : message.error
        this.render()
        return
      case 'affinity.rebind.result':
        if (!message.ok) this.notice = `${this.copy.tab.bindFailed}: ${message.error}`
        this.render()
        return
    }
  }

  private applyStream(raw: unknown): void {
    if (!isRecord(raw)) return
    // The worker only forwards its own session, but a reconnect can leave a
    // stale frame in flight; never render another session's text.
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    const active = this.state?.session.id ?? null
    if (active !== null && sessionId !== active) return
    const payload = raw.payload
    if (raw.kind === 'snapshot') {
      const record = isRecord(payload) ? payload : {}
      const baseline = isRecord(record.frame) ? record.frame.baseline : undefined
      const text = baseline === undefined ? undefined : textFromBlocks(baseline)
      if (text !== undefined && text !== '') this.run.assistantText = text
      this.renderStreaming()
      return
    }
    const frame = isRecord(payload) ? payload : {}
    if (frame.type === 'start') {
      this.run.assistantText = ''
      this.renderStreaming()
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = isRecord(frame.chunk) ? frame.chunk : undefined
    if (chunk === undefined) return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.run.assistantText += chunk.text
      this.renderStreaming()
    }
  }

  private applySessionEvent(sessionId: string, event: unknown): void {
    const active = this.state?.session.id ?? null
    if (active !== null && sessionId !== active) return
    if (!isRecord(event)) return
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'turn/start') {
      this.setSession({ turn: 'running', pendingPrompt: false })
      this.run = { assistantText: '', plan: null }
      this.render()
      return
    }
    if (type === 'turn/end') {
      this.setSession({ turn: 'idle', pendingPrompt: false })
      this.busy = false
      this.render()
      return
    }
    const text = assistantTextFromEvent(event)
    if (text !== undefined) {
      this.run.assistantText = text
      // The turn's task list, if the model announced one. Parsed from the same
      // text the bubble renders, so what the user reads and what the checklist
      // shows can never disagree.
      this.run.plan = preferPlan(this.run.plan, parsePlan(text))
      this.renderStreaming()
    }
  }

  private setSession(patch: Partial<ControlState['session']>): void {
    if (this.state === null) return
    this.state = { ...this.state, session: { ...this.state.session, ...patch } }
  }

  private runIsActive(): boolean {
    return this.state?.session.turn === 'running' || this.state?.session.pendingPrompt === true || this.busy
  }

  /* ---- actions ---- */

  private sendSettings(next: Partial<Settings>): void {
    this.notice = null
    this.port.post({ type: 'settings.update', id: crypto.randomUUID(), settings: next })
  }

  private respondToApproval(id: string, decision: ApprovalDecision): void {
    this.answered.add(id)
    this.approvals.delete(id)
    this.port.post({ type: 'approval.respond', id, decision })
    this.renderTranscript()
  }

  private submit(): void {
    const value = this.draft.trim()
    if (value === '') return
    const intent = classifyInput(value)
    this.composerError = null
    if (intent.kind === 'command') this.runCommand(intent)
    else if (intent.kind === 'open') this.runOpen(intent)
    else if (intent.kind === 'error') {
      // A malformed directive is between the user and the parser. Sending the
      // explanation to the model would be worse than useless: it would look like
      // an instruction, and the user would be waiting for a reply about it.
      this.composerError = describeOpenError(this.locale, intent.error)
      this.refreshComposerMeta()
    } else void this.runPrompt(intent.text)
  }

  /**
   * Run an `@open` directive: the extension opens it, not the model.
   *
   * The point of the directive is that "open this so I can watch" must not
   * depend on the model agreeing, so nothing here goes through the session.
   */
  private runOpen(intent: Extract<InputIntent, { kind: 'open' }>): void {
    const echo = intent.echo
    this.busy = true
    this.render()
    void this.port.call({
      type: 'open.run',
      id: '',
      url: intent.url,
      pace: intent.options.pace,
      pin: intent.options.pin,
    })
      .then(() => {
        this.draft = ''
        this.busy = false
        this.render()
      })
      .catch((error: unknown) => {
        this.busy = false
        this.composerError = error instanceof Error ? error.message : String(error)
        this.draft = echo
        this.render()
      })
  }

  /** Execute a browser command the user typed; the typed command is the consent. */
  private runCommand(intent: Extract<InputIntent, { kind: 'command' }>): void {
    const echo = intent.echo
    this.busy = true
    this.render()
    void this.port.call({ type: 'command.run', id: '', name: intent.name, args: intent.args })
      .then(() => {
        this.draft = ''
        this.busy = false
        this.render()
      })
      .catch((error: unknown) => {
        this.busy = false
        this.composerError = error instanceof Error ? error.message : String(error)
        // Keep the text so a rejected command can be corrected, not retyped.
        this.draft = echo
        this.render()
      })
  }

  /** Forward natural language to the desktop dsh model. */
  private async runPrompt(text: string): Promise<void> {
    this.busy = true
    this.composerError = null
    this.render()
    try {
      // Read the session once: every await below can be interleaved with a
      // `state` push, and a prompt must never be sent for a null session.
      let sessionId = this.state?.session.id ?? null
      if (sessionId === null) {
        const created = await this.port.call({ type: 'session.create' })
        if (created.sessionId === undefined) throw new Error('session.create returned no session id')
        sessionId = created.sessionId
      }
      await this.port.call({ type: 'session.prompt', id: '', text })
      this.draft = ''
      this.run = { assistantText: '', plan: null }
      this.setSession({ id: sessionId, pendingPrompt: true })
      this.render()
    } catch (error: unknown) {
      this.busy = false
      this.composerError = error instanceof Error ? error.message : String(error)
      this.render()
    }
  }

  private stopRun(): void {
    void this.port.call({ type: 'session.cancel', id: '' })
      .catch((error: unknown) => {
        this.composerError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        this.busy = false
        this.render()
      })
  }

  /* ---- rendering ---- */

  private render(): void {
    const draft = this.draft
    const shell = el('div', { className: 'app' })
    const transcript = el('div', { className: 'transcript' })
    const inner = el('div', { className: 'transcript__inner' })
    this.fillTranscript(inner)
    transcript.append(inner)
    shell.append(this.header(), transcript, this.composerWrap())
    if (this.settingsOpen) shell.append(this.settingsSheet())
    this.root.replaceChildren(shell)
    this.draft = draft
    const input = this.root.querySelector<HTMLTextAreaElement>('.composer__input')
    if (input !== null) {
      // Re-assert the value: any repaint must not leave stale text in the box,
      // and the placeholder stays where it belongs — in the attribute.
      input.value = this.draft
      this.autoGrow(input)
    }
    if (this.pinnedScroll) transcript.scrollTop = transcript.scrollHeight
  }

  private fillTranscript(inner: Element): void {
    if (this.backgroundDown) {
      inner.append(this.noticeNode(this.copy.common.reconnectFailed, null, 'alert', true))
    }
    // Another browser holds the connection. Say so plainly and offer the only
    // way back: the extension will not reclaim the slot by itself, because two
    // open browsers doing that would evict each other in a loop.
    if (this.state?.replaced === true) {
      inner.append(this.noticeNode(this.copy.bridge.replaced, null, 'alert', true, {
        label: this.copy.bridge.reclaim,
        onClick: () => { this.port.post({ type: 'bridge.reclaim' }) },
      }))
    }
    // A follow that failed is why the transcript above can be empty while the
    // desktop app shows a conversation; without saying so, "not following" and
    // "nothing to show" look the same.
    const followError = this.state?.followError
    if (followError !== null && followError !== undefined) {
      inner.append(this.noticeNode(followError, null, 'info', false))
    }
    if (this.notice !== null) inner.append(this.noticeNode(this.notice, null, 'info', false))
    const affinity = this.state?.affinity
    if (affinity?.status === 'handoff') inner.append(this.handoffNode(affinity))
    else if (affinity?.status === 'lost') {
      inner.append(this.noticeNode(this.copy.tab.lostText, this.copy.tab.lostTitle, 'alert', true))
    }
    for (const request of this.approvals.values()) inner.append(this.approvalNode(request))

    // The task list sits above the run: it is what the user watches to see the
    // request being worked through, so it must not scroll away behind the
    // individual tool steps that implement it.
    const plan = this.run.plan
    if (plan !== null) inner.append(this.planNode(plan))

    const rows = this.transcriptRows()
    if (rows.length === 0) {
      inner.append(this.emptyNode())
      return
    }
    for (const row of rows) {
      if (row.kind === 'request') inner.append(this.userNode(row.text))
      else if (row.kind === 'assistant') inner.append(this.assistantNode(row))
      else inner.append(this.toolNode(row))
    }
  }

  /** Repaint the transcript in place, keeping the composer untouched. */
  private renderTranscript(): void {
    const inner = this.root.querySelector('.transcript__inner')
    const transcript = this.root.querySelector('.transcript')
    if (inner === null || transcript === null) {
      this.render()
      return
    }
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120
    inner.replaceChildren()
    this.fillTranscript(inner)
    if (atBottom) transcript.scrollTop = transcript.scrollHeight
  }

  /** Repaint only the streaming reply, which is the common case while it types. */
  private renderStreaming(): void {
    // The task list changes on the same event as the text, so it is refreshed
    // with the bubble rather than waiting for a full transcript repaint.
    this.paintPlan()
    const bubble = this.root.querySelector('.msg--streaming .msg__text')
    if (bubble === null) {
      this.renderTranscript()
      return
    }
    bubble.replaceChildren(...this.assistantBubbleChildren(this.run.assistantText, true))
    const transcript = this.root.querySelector('.transcript')
    if (transcript !== null) transcript.scrollTop = transcript.scrollHeight
  }

  /** Repaint the task list in place, inserting it when the turn announces one. */
  private paintPlan(): void {
    const inner = this.root.querySelector('.transcript__inner')
    if (inner === null) return
    const existing = inner.querySelector('.plan')
    const plan = this.run.plan
    if (plan === null) {
      existing?.remove()
      return
    }
    const next = this.planNode(plan)
    if (existing === null) {
      // Before every request row, so the list reads as "here is the job" and the
      // steps below it are visibly working through it.
      const first = inner.querySelector('.msg--user')
      if (first === null) inner.append(next)
      else inner.insertBefore(next, first)
      return
    }
    existing.replaceWith(next)
  }

  /**
   * The turn's checklist: one row per task, with the state the model last wrote.
   *
   * This is the panel's answer to "how far along is it?" that a tool log cannot
   * give — the log shows the steps that ran, this shows the job they belong to,
   * including the parts not started yet and the ones that failed.
   */
  private planNode(plan: Plan): HTMLElement {
    const wrap = el('section', { className: 'plan' })
    const progress = planProgress(plan)
    wrap.append(el('div', {
      className: 'plan__head',
      children: [
        el('span', { className: 'plan__title', text: this.copy.plan.title }),
        el('span', {
          className: 'plan__count',
          text: this.copy.plan.progress
            // Only genuinely finished tasks count as done. Lumping failures in
            // with them produced "5/5 done" beside two rows marked failed, which
            // is the panel telling the user something it can see is untrue.
            .replace('{done}', String(progress.done))
            .replace('{failed}', String(progress.failed))
            .replace('{total}', String(progress.total)),
        }),
      ],
    }))
    const list = el('ol', { className: 'plan__list' })
    for (const task of plan.tasks) {
      const state = task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : task.status === 'active' ? 'active' : 'pending'
      const mark = task.status === 'done' ? '✓' : task.status === 'failed' ? '✕' : task.status === 'active' ? '▸' : ''
      list.append(el('li', {
        className: `plan__task plan__task--${state}`,
        children: [
          el('span', { className: 'plan__mark', text: mark }),
          el('span', { className: 'plan__text', text: task.text }),
        ],
      }))
    }
    wrap.append(list)
    return wrap
  }

  private header(): HTMLElement {
    const state = this.state
    const bridge = state?.bridge ?? 'stopped'
    // The panel's own title is already shown by the browser's side-panel chrome,
    // so the header carries only what changes: the page under control, the
    // connection, and the settings entry.
    const pill = el('span', {
      className: 'header__tab',
      attributes: { title: state === null ? this.copy.common.reconnecting : this.copy.tab.controlled },
    })
    pill.append(
      el('span', { className: `dot dot--${bridge}` }),
      el('span', { className: 'header__tab-text', text: controlledTabText(state?.affinity ?? emptyAffinity(), this.copy) }),
    )

    const actions = el('div', { className: 'header__actions' })
    if (state !== null && state.affinity.status === 'lost') {
      actions.append(el('button', {
        className: 'btn btn--outlined',
        text: this.copy.tab.bind,
        attributes: { type: 'button' },
        on: { click: () => { this.port.post({ type: 'affinity.rebind', id: crypto.randomUUID() }) } },
      }))
    }
    const settingsButton = iconButton('settings', this.copy.settings.heading, () => { this.toggleSettings(true) })
    // A stable hook: the only other way to name this button is its label, which
    // changes with the UI language, and a test that finds it by text would break
    // on a machine that reports a different one.
    settingsButton.dataset.role = 'settings'
    actions.append(settingsButton)

    return el('header', {
      className: 'header',
      children: [el('div', { className: 'header__spacer' }), pill, actions],
    })
  }

  private settingsSheet(): HTMLElement {
    const sheet = el('div', { className: 'sheet' })
    sheet.append(el('div', {
      className: 'sheet__head',
      children: [
        iconButton('close', this.copy.common.close, () => { this.toggleSettings(false) }),
        el('span', { className: 'sheet__title', text: this.copy.settings.heading }),
      ],
    }))
    const body = el('div', { className: 'sheet__body' })
    const settings = this.state?.settings ?? normalizeSettings(undefined)
    // Only choices the user can actually make: the bridge address, the token,
    // and the approval-notification fallback are all decided for them by the
    // Chrome-over-loopback path. An installed troubleshooting skill covers the
    // cases where a human has to intervene.
    body.append(
      this.openPagesSetting(),
      this.sharingSetting(settings),
      this.conversationSetting(settings),
      this.tabSwitchSetting(settings),
      this.visionSetting(settings),
      this.switchSetting(this.copy.settings.autoOpen, settings.autoOpenPanel, this.copy.settings.autoOpenHelp, (checked) => {
        this.sendSettings({ autoOpenPanel: checked })
      }),
      this.switchSetting(this.copy.settings.unrestricted, settings.unrestrictedBrowserAccess, this.copy.settings.unrestrictedHelp, (checked) => {
        this.sendSettings({ unrestrictedBrowserAccess: checked })
      }),
      el('div', {
        className: 'setting',
        children: [el('div', { className: 'setting__help', text: this.copy.settings.widthHint })],
      }),
    )
    sheet.append(body)
    return sheet
  }

  /**
   * How far image recognition goes.
   *
   * The only control this feature needs here. Where the call goes — the desktop, or
   * an endpoint the browser reaches itself — is deployment configuration, not a
   * question for a settings sheet: the desktop's base URL and model already have
   * defaults, and being asked for a model id is not a choice, it is a chore.
   */
  private visionSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.visionTier } })
    for (const [value, label] of [
      ['off', this.copy.settings.visionTierOff],
      ['low', this.copy.settings.visionTierLow],
      ['standard', this.copy.settings.visionTierStandard],
      ['enhanced', this.copy.settings.visionTierEnhanced],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.visionTier === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      const tier = select.value
      if (tier !== 'off' && tier !== 'low' && tier !== 'standard' && tier !== 'enhanced') return
      this.sendSettings({ visionTier: tier })
    })
    return this.settingRow(this.copy.settings.visionTier, select, this.copy.settings.visionTierHelp)
  }

  /**
   * Which desktop conversation the panel talks to.
   *
   * The target is chosen, never inferred. The desktop publishes no "session I am
   * viewing" signal, so a mode that guessed from recent activity would deliver a
   * message into the wrong conversation without saying so.
   */
  private conversationSetting(settings: Settings): HTMLElement {
    const pinned = settings.sessionScope === 'pinned'
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.conversation } })
    for (const [value, label] of [
      ['fresh', this.copy.settings.conversationFresh],
      ['pinned', this.copy.settings.conversationPinned],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.sessionScope === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      if (select.value === 'fresh') {
        void this.port.call({ type: 'session.select', id: '', scope: 'fresh', sessionId: null })
        return
      }
      // Switching to "continue" needs a target: ask for the list and let the
      // picker below do the choosing rather than defaulting to something.
      this.requestSessions()
      this.render()
    })

    const row = this.settingRow(this.copy.settings.conversation, select, this.copy.settings.conversationHelp)
    if (!pinned) return row

    // The picker, shown only while "continue a conversation" is selected.
    const picker = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.conversationPick } })
    const chosen = this.sessions.some((session) => session.sessionId === settings.pinnedSessionId)
    if (!chosen) {
      const placeholder = el('option', {
        text: this.sessionsLoading ? this.copy.settings.conversationLoading : this.copy.settings.conversationNone,
        attributes: { value: '' },
      })
      placeholder.selected = true
      picker.append(placeholder)
    }
    for (const session of this.sessions) {
      const option = el('option', { text: sessionLabel(session, this.copy), attributes: { value: session.sessionId } })
      if (session.sessionId === settings.pinnedSessionId) option.selected = true
      picker.append(option)
    }
    picker.addEventListener('change', () => {
      if (picker.value === '') return
      // `follow` is what makes the panel show a conversation the desktop app is
      // driving: binding alone renders an empty transcript, because the worker
      // drops any event whose Session is not the one it is bound to.
      void this.port.call({ type: 'session.select', id: '', scope: 'pinned', sessionId: picker.value, follow: true })
    })
    row.append(el('div', { className: 'setting__actions', children: [picker] }))
    return row
  }

  /** Ask the worker for the desktop's recent conversations. */
  private requestSessions(): void {
    if (this.sessionsLoading) return
    this.sessionsLoading = true
    void this.port.call({ type: 'session.list', id: '' })
      .catch(() => { /* The list result carries the failure; the picker stays empty. */ })
  }

  /**
   * How a manual tab switch resolves.
   *
   * This used to be an in-transcript prompt on every switch, which the user
   * asked to move here: once the answer is known, being asked again is noise.
   */
  private tabSwitchSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.tabSwitch } })
    for (const [value, label] of [
      ['follow', this.copy.settings.tabSwitchFollow],
      ['keep', this.copy.settings.tabSwitchKeep],
      ['ask', this.copy.settings.tabSwitchAsk],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.tabSwitch === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.sendSettings({ tabSwitch: select.value as Settings['tabSwitch'] })
    })
    return this.settingRow(this.copy.settings.tabSwitch, select, this.copy.settings.tabSwitchHelp)
  }

  private toggleSettings(open: boolean): void {
    this.settingsOpen = open
    const shell = this.root.querySelector('.app')
    if (shell === null) {
      this.render()
      return
    }
    const existing = shell.querySelector('.sheet')
    if (open) {
      if (existing === null) {
        shell.append(el('button', {
          className: 'scrim',
          attributes: { type: 'button', tabindex: '-1', 'aria-label': this.copy.common.close },
          on: { click: () => { this.toggleSettings(false) } },
        }), this.settingsSheet())
      }
      return
    }
    shell.querySelector('.scrim')?.remove()
    existing?.remove()
  }

  private emptyNode(): HTMLElement {
    // One line, nothing else: the panel is for talking, not for tutorials.
    return el('div', {
      className: 'empty',
      children: [el('div', { className: 'empty__title', text: this.copy.empty.title })],
    })
  }

  private noticeNode(
    text: string,
    title: string | null,
    iconName: IconName,
    warning: boolean,
    action?: { label: string; onClick: () => void },
  ): HTMLElement {
    const body = el('div', {
      className: 'notice__body',
      children: [
        ...(title === null ? [] : [el('div', { className: 'notice__title', text: title })]),
        el('div', { className: 'notice__text', text }),
      ],
    })
    if (action !== undefined) {
      body.append(el('button', {
        className: 'btn btn--outlined notice__action',
        text: action.label,
        attributes: { type: 'button' },
        on: { click: action.onClick },
      }))
    }
    return el('div', {
      className: warning ? 'notice notice--warning' : 'notice',
      children: [icon(iconName, 16), body],
    })
  }

  private handoffNode(affinity: TabAffinityState): HTMLElement {
    const decide = (decision: 'keep' | 'follow' | 'keep-always'): void => {
      this.port.post({ type: 'affinity.respond', revision: affinity.revision, decision })
    }
    const active = affinity.active
    const text = active === null ? this.copy.tab.handoffText : `${this.copy.tab.handoffText} — ${active.title || active.url}`
    return el('div', {
      className: 'notice notice--warning',
      children: [
        icon('alert', 16),
        el('div', {
          className: 'notice__body',
          children: [
            el('div', { className: 'notice__title', text: this.copy.tab.handoffTitle }),
            el('div', { className: 'notice__text', text }),
            el('div', {
              className: 'notice__actions',
              children: [
                el('button', { className: 'btn btn--outlined', text: this.copy.tab.keep, attributes: { type: 'button' }, on: { click: () => decide('keep') } }),
                el('button', { className: 'btn btn--primary', text: this.copy.tab.follow, attributes: { type: 'button' }, on: { click: () => decide('follow') } }),
                el('button', { className: 'btn', text: this.copy.tab.keepAlways, attributes: { type: 'button' }, on: { click: () => decide('keep-always') } }),
              ],
            }),
          ],
        }),
      ],
    })
  }

  private approvalNode(request: ApprovalRequest): HTMLElement {
    const card = el('div', { className: 'approval' })
    // Say what is being asked before saying what it would do. Without this line
    // the card opened with the tool's own summary ("点击元素 [3]"), which reads
    // like machine output and leaves the user to work out that they are being
    // asked a question at all.
    card.append(el('p', {
      className: 'approval__ask',
      text: request.kind === 'read' ? this.copy.approval.askRead : this.copy.approval.askAction,
    }))
    card.append(el('p', { className: 'approval__summary', text: request.summary }))
    // The origin is stated in words, not as a tag: it is the one fact that
    // decides the answer, so it reads as a sentence next to the summary.
    const origins = request.origins.length === 0
      ? this.copy.approval.unknownOrigin
      : request.origins.join(' · ')
    card.append(el('p', { className: 'approval__origin', text: origins }))

    const actions = el('div', { className: 'approval__actions' })
    for (const decision of approvalDecisions(request)) {
      const label = decision === 'deny'
        ? this.copy.approval.deny
        : decision === 'allow-once'
          ? this.copy.approval.allowOnce
          : decision === 'always-allow-reads'
            ? this.copy.approval.alwaysAllowReads
            : this.copy.approval.trustSession
      actions.append(el('button', {
        className: decision === 'deny' ? 'btn btn--outlined' : 'btn btn--primary',
        text: label,
        attributes: { type: 'button' },
        on: { click: () => { this.respondToApproval(request.id, decision) } },
      }))
    }
    card.append(actions)
    return card
  }

  private userNode(text: string): HTMLElement {
    return el('div', {
      className: 'msg msg--user',
      children: [el('div', { className: 'msg__bubble', text })],
    })
  }

  private assistantBubbleChildren(text: string, streaming: boolean): Node[] {
    const nodes: Node[] = []
    if (hasMarkdownContent(text)) {
      const html = el('div')
      // The only innerHTML in this file, and the input is sanitized markdown.
      html.innerHTML = renderMarkdown(text)
      nodes.push(...html.childNodes)
    }
    if (streaming) nodes.push(el('span', { className: 'caret', attributes: { 'aria-hidden': 'true' } }))
    return nodes
  }

  private assistantNode(row: TimelineEntry): HTMLElement {
    const streaming = row.id === STREAMING_ID
    const bubble = el('div', { className: 'msg__text' })
    bubble.append(...this.assistantBubbleChildren(row.text, streaming))
    return el('div', {
      className: streaming ? 'msg msg--assistant msg--streaming' : 'msg msg--assistant',
      children: [bubble],
    })
  }

  private toolNode(row: TimelineEntry): HTMLElement {
    const detailId = `tool-${row.id}`
    const open = this.expanded.has(row.id)
    const button = el('button', {
      className: 'tool-line',
      attributes: { type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailId },
      on: {
        click: () => {
          if (this.expanded.has(row.id)) this.expanded.delete(row.id)
          else this.expanded.add(row.id)
          this.renderTranscript()
        },
      },
    })
    const iconClass = row.state === 'running'
      ? 'tool-line__icon tool-line__icon--running'
      : row.state === 'failed'
        ? 'tool-line__icon tool-line__icon--failed'
        : row.state === 'denied'
          ? 'tool-line__icon tool-line__icon--denied'
          : 'tool-line__icon'
    const marker = icon(markerIcon(row.state), 14)
    marker.setAttribute('class', iconClass)
    button.append(marker, el('span', {
      className: 'tool-line__text',
      text: row.text === '' ? toolLabel(row.tool, this.copy) : row.text,
    }))

    const wrapper = el('div', { className: 'msg msg--tool', children: [button] })
    if (open) {
      wrapper.append(el('div', {
        className: 'tool-detail',
        attributes: { id: detailId },
        text: [
          `${this.copy.timeline.tool}: ${row.tool ?? '—'}`,
          `${this.copy.timeline.result}: ${stateText(row.state, this.locale)}`,
          ...(row.callId === undefined ? [] : [`ID: ${row.callId}`]),
        ].join('\n'),
      }))
    }
    return wrapper
  }

  /** The transcript rows, with the in-flight reply appended while it streams. */
  private transcriptRows(): TimelineEntry[] {
    const settled = this.state !== null
      ? timelineFromState(this.state)
      : this.activity.slice().reverse().map((entry) => ({
          id: entry.id,
          kind: 'step' as const,
          text: entry.summary,
          tool: entry.name,
          state: entry.state,
          at: entry.at,
          callId: entry.id,
        }))
    // The durable assistant row only arrives at the end of the turn, so the live
    // text is shown as one synthetic row until then. Once the durable row
    // exists, it is the one rendered: the answer never appears twice.
    if (this.run.assistantText.trim() === '') return settled
    if (settled.some((row) => row.kind === 'assistant')) return settled
    return [...settled, {
      id: STREAMING_ID,
      kind: 'assistant' as const,
      text: this.run.assistantText,
      state: this.runIsActive() ? 'running' as const : 'done' as const,
      at: Date.now(),
    }]
  }

  private composerWrap(): HTMLElement {
    const wrap = el('div', { className: 'composer-wrap' })
    const box = el('div', { className: 'composer__box' })
    const input = el('textarea', {
      className: 'composer__input',
      attributes: {
        rows: '1',
        'aria-label': this.copy.composer.placeholder,
        placeholder: this.copy.composer.placeholder,
      },
    })
    // Explicitly empty: the placeholder is an attribute, and the box must never
    // open with text already in it.
    input.value = this.draft
    input.addEventListener('input', () => {
      this.draft = input.value
      this.autoGrow(input)
      this.refreshComposerMeta()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.submit()
      }
    })

    const action = this.runIsActive()
      ? el('button', {
          className: 'btn btn--icon',
          attributes: { type: 'button', title: this.copy.composer.stop, 'aria-label': this.copy.composer.stop },
          on: { click: () => { this.stopRun() } },
          children: [icon('stop', 16)],
        })
      : el('button', {
          className: 'btn btn--primary btn--icon',
          attributes: { type: 'button', title: this.copy.composer.send, 'aria-label': this.copy.composer.send },
          on: { click: () => { this.submit() } },
          children: [icon('send', 16)],
        })
    if (this.busy) action.setAttribute('disabled', 'true')

    box.append(input, action)
    wrap.append(el('div', { className: 'composer', children: [box, this.composerMeta()] }))
    queueMicrotask(() => { this.autoGrow(input) })
    return wrap
  }

  /**
   * Grow the input to fit its draft, up to a fixed cap.
   *
   * The cap matches `max-height` in the stylesheet. A viewport fraction was
   * wrong here: the same draft took a different amount of the panel depending on
   * the window size, and a tall window let the input crowd out the conversation.
   */
  private autoGrow(input: HTMLTextAreaElement): void {
    const MAX_INPUT_HEIGHT = 160
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }

  private composerMeta(): HTMLElement {
    const meta = el('div', { className: 'composer__meta' })
    meta.id = 'composer-meta'
    meta.append(...this.composerMetaChildren())
    return meta
  }

  /**
   * The one line under the composer.
   *
   * Empty unless there is something to say: a ready panel shows no syntax
   * tutorial, and a typed draft only reports a problem (a failed send, or a
   * model request while the bridge is down). The one exception is a draft that
   * starts with `@`, because a directive cannot be guessed — showing the formula
   * while it is being typed is the only place it can be learned.
   */
  private composerMetaChildren(): Node[] {
    if (this.composerError !== null) {
      return [el('span', { className: 'composer__error', text: this.composerError })]
    }
    const draft = this.draft.trim()
    if (draft.startsWith('@')) {
      const intent = classifyInput(draft)
      // A half-written directive is shown as a quiet hint — it is a reminder of
      // the shape, not a complaint — while a real mistake is shown as an error.
      // The distinction comes from the parser (`isSoftOpenError`), not from the
      // wording: deciding it by testing whether the message began with a
      // particular Chinese phrase meant the hint vanished in English, and the
      // browser would have been right to complain in Chinese.
      if (intent.kind === 'error') {
        const className = isSoftOpenError(intent.error) ? 'composer__hint' : 'composer__error'
        return [el('span', { className, text: describeOpenError(this.locale, intent.error) })]
      }
      return [el('span', { className: 'composer__hint', text: this.copy.composer.openHint })]
    }
    const intent = classifyInput(draft)
    if (draft !== '' && this.state?.bridge !== 'connected' && intent.kind !== 'command' && intent.kind !== 'open') {
      return [el('span', { className: 'composer__error', text: this.copy.composer.disconnected })]
    }
    return []
  }

  private refreshComposerMeta(): void {
    const meta = this.root.querySelector('#composer-meta')
    if (meta === null) return
    meta.replaceChildren(...this.composerMetaChildren())
  }

  /**
   * The panel's view of the desktop app's "open pages for the user" switch.
   *
   * The badge reports the *connection*, not the value. Before a handshake there
   * is no policy at all, and labelling that "not allowed" made a healthy
   * extension look broken — so the badge says 已连接/未连接, and whether pages
   * may be opened is told by the help line, which is where that belongs.
   *
   * Read-only on purpose. The desktop app owns the setting, so the panel states
   * it and says where to change it, rather than offering a control the app would
   * immediately overwrite.
   */
  private openPagesSetting(): HTMLElement {
    const policy = this.state?.policy ?? null
    const connected = policy !== null
    const allowed = policy?.openPagesForUser === true
    const help = policy === null
      ? this.copy.settings.openPagesUnknown
      : allowed ? this.copy.settings.openPagesOnHelp : this.copy.settings.openPagesOffHelp
    return el('div', {
      className: 'setting',
      children: [
        el('div', {
          className: 'setting__row',
          children: [
            el('div', { className: 'setting__label', text: this.copy.settings.openPages }),
            el('span', {
              className: connected ? 'badge badge--on' : 'badge',
              text: connected ? this.copy.settings.openPagesOn : this.copy.settings.openPagesOff,
            }),
          ],
        }),
        el('div', { className: 'setting__help', text: help }),
      ],
    })
  }

  private sharingSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.sharing } })
    for (const [value, label] of [
      ['ask', this.copy.settings.sharingAsk],
      ['auto', this.copy.settings.sharingAuto],
      ['off', this.copy.settings.sharingOff],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.sharePageContent === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.sendSettings({ sharePageContent: select.value as Settings['sharePageContent'] })
    })
    return this.settingRow(this.copy.settings.sharing, select, this.copy.settings.sharingHelp)
  }


  private settingRow(label: string, control: Node, help: string): HTMLElement {
    return el('div', {
      className: 'setting',
      children: [
        el('div', { className: 'setting__row', children: [el('div', { className: 'setting__label', text: label }), control] }),
        el('div', { className: 'setting__help', text: help }),
      ],
    })
  }

  private switchSetting(label: string, checked: boolean, help: string, onChange: (checked: boolean) => void): HTMLElement {
    const input = el('input', { attributes: { type: 'checkbox', 'aria-label': label } })
    input.checked = checked
    input.addEventListener('change', () => { onChange(input.checked) })
    const control = el('span', {
      className: 'switch',
      children: [input, el('span', { className: 'switch__track' }), el('span', { className: 'switch__thumb' })],
    })
    return this.settingRow(label, control, help)
  }

  /** Mark the page as detached from the worker without inventing any state. */
  markOffline(): void {
    if (this.backgroundDown) return
    this.backgroundDown = true
    this.render()
  }
}

/** The synthetic row id for the reply that is still streaming. */
const STREAMING_ID = '__streaming__'

/** Attach the page to a document. Used by the entry point and by tests. */
export function mountControlPage(
  root: HTMLElement,
  locale: UiLocale = getUiLocale(),
  portOverride?: ControlPort,
): { app: App; port: ControlPort } {
  const copy = controlCopy(locale)
  let app: App
  const port = portOverride ?? new ControlPort(
    (message) => { app.handleMessage(message) },
    (connected) => {
      if (!connected) app.markOffline()
    },
  )
  app = new App(root, locale, port, copy)
  app.start()
  return { app, port }
}

function main(): void {
  const root = document.getElementById('control-root')
  if (root !== null) {
    const mounted = mountControlPage(root)
    // A handle on the live panel. There is no devtools path into a side panel's
    // module scope, so without this the running UI cannot be inspected or driven
    // from the page console — which is how the layout measurement script feeds it
    // real content instead of injecting HTML that bypasses the render path.
    ;(globalThis as { __dshPanel?: unknown }).__dshPanel = mounted
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true })
  else main()
}