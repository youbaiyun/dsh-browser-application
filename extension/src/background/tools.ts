/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@dsh-browser/protocol'
import type { ToolError } from '@dsh-browser/protocol'
import type { ImageIdentity, ImageTarget } from '../content/actions.ts'
import { fillMarkers, hasMarkers, stripMarkers } from '../markers.ts'
import type { VisionSink } from './vision.ts'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { approvalPromptForCall, originFromUrl } from './authorization.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_open_tab',
])
const TAB_NATIVE_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
const STATE_CHANGING_PAGE_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
/** Tools that operate on the browser tab collection rather than one page document. */
export const TAB_MANAGEMENT_TOOL_NAMES = new Set([
  'browser_list_tabs',
  'browser_follow_tab',
  'browser_close_tab',
])

/**
 * Every `browser_*` tool this worker can execute.
 *
 * Sorted so the list can be shown verbatim in a rejection message. It is the
 * authority for a user-typed command: a name outside this set is refused before
 * anything is dispatched, because an unknown name has no call shape to validate
 * and must never reach the page.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = [
  'browser_back',
  'browser_click',
  'browser_close_tab',
  'browser_follow_tab',
  'browser_forward',
  'browser_get_text',
  'browser_list_tabs',
  'browser_navigate',
  'browser_open_tab',
  'browser_press',
  'browser_reload',
  'browser_scroll',
  'browser_snapshot',
  'browser_type',
  'browser_wait',
]
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

/** Whether a successful tool may have changed the controlled tab's page URL. */
export function isNavigationCandidateTool(name: string): boolean {
  return NAVIGATION_CANDIDATE_TOOLS.has(name)
}

/** Whether a tool can run without first resolving the current controlled tab. */
export function isTabManagementTool(name: string): boolean {
  return TAB_MANAGEMENT_TOOL_NAMES.has(name)
}

/** Tab-affinity services owned by the background entry point. */
export interface TabManagementContext {
  /** Skip all browser approval prompts after the user enables unrestricted access. */
  unrestrictedAccess: boolean
  /** Controlled tab for the calling session, when one still exists. */
  controlledTabId?: number
  /** Rebind subsequent tools to one existing tab without activating it. */
  followTab?: (tab: chrome.tabs.Tab) => void | Promise<void>
  /** Mark the point after which a state-changing operation cannot be withdrawn. */
  commitAction?: () => void
  /** Restore withdrawability when a content-script action was not delivered. */
  rollbackActionCommit?: () => void
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function contentScriptReceiverMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}

/**
 * What each numbered image was, as of the last snapshot that numbered it.
 *
 * Element indices are a per-frame namespace that the page can invalidate at any
 * moment by re-rendering, and the model addresses images by number. Remembering
 * which address a number pointed at is what turns a stale index from a dead end
 * into something the content script can still resolve. Keyed by tab and frame
 * because the same number in two frames names two different images.
 */
const rememberedImageIdentities = new Map<string, Map<number, string>>()

/** Above this, the oldest remembered numbers are dropped. */
const REMEMBERED_IDENTITY_LIMIT = 500
/**
 * Above this many tab/frame keys, the least recently snapshotted frame is dropped.
 *
 * The inner bound alone would still leak: a closed tab or a destroyed iframe
 * leaves its key behind forever, and nothing calls back to say the frame is gone.
 * Key count grows with every tab and iframe ever snapshotted, so it needs a bound
 * of its own rather than only a bound on what each key holds.
 */
const REMEMBERED_IDENTITY_KEY_LIMIT = 64

function identityMemoryKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`
}

/**
 * Record the identity map one snapshot answer carried.
 *
 * Called per frame with that frame's own map, so a number is never learned from
 * the wrong document.
 *
 * @param tabId - the tab the snapshot was taken in.
 * @param frameId - the frame the map belongs to.
 * @param identities - the identities that frame reported.
 */
export function rememberImageIdentities(
  tabId: number,
  frameId: number,
  identities: readonly ImageIdentity[],
): void {
  if (identities.length === 0) return
  const key = identityMemoryKey(tabId, frameId)
  const byNumber = rememberedImageIdentities.get(key) ?? new Map<number, string>()
  for (const entry of identities) byNumber.set(entry.index, entry.identity)
  // Bounded: one long-lived frame must not accumulate a number per image forever.
  while (byNumber.size > REMEMBERED_IDENTITY_LIMIT) {
    const oldest = byNumber.keys().next()
    if (oldest.done === true) break
    byNumber.delete(oldest.value)
  }
  // Re-insert rather than plain `set`: setting an existing key keeps its original
  // position, so the key bound below would evict by creation order instead of by
  // which frame has gone longest without a snapshot.
  rememberedImageIdentities.delete(key)
  rememberedImageIdentities.set(key, byNumber)
  while (rememberedImageIdentities.size > REMEMBERED_IDENTITY_KEY_LIMIT) {
    const oldest = rememberedImageIdentities.keys().next()
    if (oldest.done === true || oldest.value === key) break
    rememberedImageIdentities.delete(oldest.value)
  }
}

/** Exposed for tests: what a later describe call would offer as a hint. */
export { rememberedImageIdentities }

/**
 * Resolve one image on the controlled tab, for the vision pipeline.
 *
 * Kept in this module because injection, frame selection and answer validation
 * are its business: the vision path should not have to reimplement them, and if
 * it did, the two copies would disagree about what a valid page answer is.
 *
 * @param tabId - the controlled tab.
 * @param index - the image's inventory index from the latest snapshot.
 * @param frameId - the frame that owns the index; element indices are per frame.
 * @param signal - bridge lifetime; cancellation stops before any page action.
 * @returns the resolved image, or a stable error answer.
 */
export async function requestImageTarget(
  tabId: number,
  index: number,
  frameId: number,
  signal?: AbortSignal,
): Promise<{ ok: true; target: ImageTarget } | { ok: false; error: ToolError }> {
  if (signal?.aborted === true) {
    return { ok: false, error: { code: 'bridge-closed', message: 'the bridge connection ended before the image was resolved' } }
  }
  const frames = await listTabFrames(tabId, undefined)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return { ok: false, error: { code: 'action-failed', message: `Frame ${String(frameId)} does not exist or has navigated. Call browser_snapshot again.` } }
  }
  // The hint is what that number meant when the snapshot was taken. It is sent
  // only as a fallback: the content script prefers the live index and reaches for
  // this exclusively when the index no longer resolves.
  const remembered = rememberedImageIdentities.get(identityMemoryKey(tabId, frameId))?.get(index)
  const call: ToolCall = {
    id: 'image-target',
    name: 'browser_describe_image',
    args: remembered === undefined ? { index } : { index, identity: remembered },
  }
  let response: unknown
  try {
    response = await sendAction(tabId, call, frame)
  } catch (error: unknown) {
    // A tab restored before the worker started has no content script yet; one
    // injection is the difference between "no such image" and "not listening".
    if (!contentScriptReceiverMissing(error)) throw error
    await injectContentScript(tabId)
    response = await sendAction(tabId, call, frame)
  }
  if (!isToolAnswer(response)) {
    return { ok: false, error: { code: 'content-unavailable', message: 'The page content script returned an invalid response.' } }
  }
  if (!response.ok) {
    // `ToolAnswer.ok` is a plain boolean rather than a discriminant, so the
    // failure is rebuilt here instead of relying on narrowing.
    return {
      ok: false,
      error: response.error ?? { code: 'content-unavailable', message: 'The page refused to describe that image.' },
    }
  }
  const target = (response.result as { image?: unknown }).image
  if (!isImageTarget(target)) {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: `The page did not resolve element [${String(index)}] to an image that browser_snapshot listed.` },
    }
  }
  return { ok: true, target }
}

/** Whether a content answer's `image` field is the shape the pipeline expects. */
function isImageTarget(value: unknown): value is ImageTarget {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as ImageTarget
  return typeof candidate.identity === 'string' && candidate.identity !== ''
    && typeof candidate.alt === 'string'
    && typeof candidate.near === 'string'
    && typeof candidate.heading === 'string'
    && typeof candidate.kind === 'string'
    && typeof candidate.src === 'string'
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function tabMetadataSnapshot(
  tabId: number,
  windowId: number | undefined,
  title: string | undefined,
  url: string | undefined,
  maxChars: number,
): ToolAnswer {
  const status = 'The current tab is available only through browser-level controls because its page DOM is protected or inaccessible. DOM snapshot, click, type, press, scroll, wait, and text extraction are unavailable here. Navigate, back, forward, and reload remain available.'
  const separator = '\n\n'
  const remaining = maxChars - status.length - separator.length
  if (remaining <= 0) return { ok: true, result: { text: status.slice(0, maxChars) } }
  return {
    ok: true,
    result: {
      text: `${status}${separator}${wrapUntrustedContent([
        `Tab ID: ${tabId}`,
        `Window ID: ${windowId ?? '(unknown)'}`,
        `Title: ${title ?? '(unknown)'}`,
        `URL: ${url ?? '(unknown)'}`,
      ].join('\n'), remaining)}`,
    },
  }
}

async function dispatchTabNativeTool(
  tabId: number,
  tabUrl: string | undefined,
  tabTitle: string | undefined,
  windowId: number | undefined,
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer | undefined> {
  if (call.name === 'browser_snapshot') return tabMetadataSnapshot(tabId, windowId, tabTitle, tabUrl, budget.maxChars)
  if (!TAB_NATIVE_TOOLS.has(call.name)) return undefined
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()

  let operation: Promise<unknown>
  let text: string
  try {
    switch (call.name) {
      case 'browser_navigate': {
        const requested = parseHttpUrl(call.args.url)
        if (requested === undefined) {
          return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
        }
        commitAction?.()
        operation = chrome.tabs.update(tabId, { url: requested.href })
        text = `Navigating to ${requested.href}. Call browser_snapshot again after the page loads.`
        break
      }
      case 'browser_back':
        commitAction?.()
        operation = chrome.tabs.goBack(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_forward':
        commitAction?.()
        operation = chrome.tabs.goForward(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_reload':
        commitAction?.()
        operation = chrome.tabs.reload(tabId)
        text = 'The page is reloading. Call browser_snapshot again after it loads.'
        break
      default:
        return undefined
    }
    resetTabSnapshot(tabId)
    await operation
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`The browser-level operation failed: ${detail}`)
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  return { ok: true, result: { text, navigationPending: true } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
function approvalFailure(approval: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: { code: 'bridge-closed', message: `The browser approval request for "${approval.action}" was cancelled.` },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    // Filled per frame, from that frame's own identity map: element indices are a
    // per-frame namespace, so the same number in two iframes names two different
    // images and a tab-wide fill would describe the wrong one.
    const filled = fillImageStates(text, answer, vision)
    // The same map, kept past the render: a describe call arriving after the page
    // re-rendered needs to know what the number it was given used to point at.
    rememberImageIdentities(tabId, frame.frameId, answerImageIdentities(answer))
    // Only the main frame's text is remembered as "the page": a sidebar or ad
    // iframe would otherwise overwrite the page's own numbers with its own.
    if (frame.frameId === 0) vision?.sawPageText(stripMarkers(text))
    if (frame.frameId === 0) sections.push(filled)
    else sections.push(frameHeader(frame), filled)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
  vision?: VisionSink,
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
    vision,
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
  commitAction?: () => void,
  rollbackActionCommit?: () => void,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget, vision)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const navigationWait = includeActionDelta && isNavigationCandidateTool(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  const stateChanging = STATE_CHANGING_PAGE_TOOLS.has(call.name)
  try {
    if (stateChanging) commitAction?.()
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    if (stateChanging && contentScriptReceiverMissing(error)) rollbackActionCommit?.()
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed, vision)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    vision?.sawPageText(stripMarkers(text))
    return { ok: true, result: { text: wrapUntrustedContent(fillImageStates(text, response, vision), budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  if (pageContent !== undefined) vision?.sawPageText(stripMarkers(pageContent))
  return {
    ok: true,
    result: {
      text: pageContent === undefined
        ? fillImageStates(text, response, vision)
        : wrapActionDelta(fillImageStates(text, response, vision), fillImageStates(pageContent, response, vision), frame, budget.maxChars),
    },
  }
}

/**
 * Replace the image markers in an answer with what is known about each image.
 *
 * This is the one place both halves exist: the text the content script rendered
 * (which numbers the images) and the states the vision pipeline holds (keyed by
 * identity). Filling here, rather than in the content script, is what lets a
 * description reach the model on the snapshot after the one that requested it —
 * and lets an image that is still being recognized say so instead of going quiet.
 *
 * @param text - rendered text, possibly containing markers.
 * @param response - the content script's answer, carrying the identity map.
 * @param vision - state lookup by identity; absent leaves markers untouched.
 * @returns the filled text.
 */
function fillImageStates(
  text: string,
  response: ToolAnswer,
  vision: VisionSink | undefined,
): string {
  if (vision === undefined || !response.ok) return text
  const identities = answerImageIdentities(response)
  if (identities.length === 0 || !hasMarkers(text)) return text
  const identityByIndex = new Map(identities.map((entry) => [entry.index, entry]))
  return fillMarkers(text, (index) => {
    const entry = identityByIndex.get(index)
    if (entry === undefined) return undefined
    // What the page already knows outranks what the cache might: an image whose
    // load failed is never requested, so no cache entry can exist for it.
    if (entry.unavailable !== undefined) return `unavailable:${entry.unavailable}`
    return vision.states(entry.identity)
  })
}

/** Exposed for tests: the fill is the one link between rendered text and results. */
export { fillImageStates }

/** The identity map a content answer carries, when it numbered any images. */
function answerImageIdentities(answer: ToolAnswer): ImageIdentity[] {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return []
  const identities = (answer.result as { imageIdentities?: unknown }).imageIdentities
  if (!Array.isArray(identities)) return []
  return identities.filter((entry): entry is ImageIdentity => typeof entry === 'object' && entry !== null
    && typeof (entry as ImageIdentity).index === 'number'
    && typeof (entry as ImageIdentity).identity === 'string')
}

function requestedTabId(args: Record<string, unknown>): number | undefined {
  const value = args.tabId
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tabUrl(tab: chrome.tabs.Tab): string {
  return tab.url ?? tab.pendingUrl ?? ''
}

function approvalDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    const display = url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}//${url.host}${url.pathname}`
    return display.replace(/\s+/g, ' ').slice(0, 160)
  } catch {
    return '(unknown URL)'
  }
}

function tabManagementApproval(call: ToolCall, tab?: chrome.tabs.Tab): ApprovalPrompt {
  const locale = getUiLocale()
  if (call.name === 'browser_list_tabs') {
    return {
      kind: 'read',
      action: call.name,
      summary: locale === 'zh' ? '读取所有已打开标签页的标题和链接' : 'Read the titles and URLs of all open tabs',
      origins: [],
      canTrust: false,
    }
  }
  const url = tab === undefined ? '' : tabUrl(tab)
  const origin = originFromUrl(url)
  const display = approvalDisplayUrl(url)
  return {
    kind: 'action',
    action: call.name,
    summary: call.name === 'browser_follow_tab'
      ? (locale === 'zh' ? `跟随标签页 ${tab?.id ?? '?'}：${display}` : `Follow tab ${tab?.id ?? '?'}: ${display}`)
      : (locale === 'zh' ? `关闭标签页 ${tab?.id ?? '?'}：${display}` : `Close tab ${tab?.id ?? '?'}: ${display}`),
    origins: origin === undefined ? [] : [origin],
    canTrust: false,
  }
}

async function authorizeTabManagement(
  prompt: ApprovalPrompt,
  unrestrictedAccess: boolean,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolAnswer | undefined> {
  if (unrestrictedAccess) return undefined
  const authorization = authorize === undefined ? 'unavailable' : await authorize(prompt)
  if (isCancelled(call, signal)) return cancelled()
  return authorization === 'approved' ? undefined : approvalFailure(prompt, authorization)
}

async function findTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

async function dispatchTabManagementTool(
  call: ToolCall,
  budget: ContentBudget,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  if (call.name === 'browser_list_tabs') {
    const approval = tabManagementApproval(call)
    const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
    if (rejected !== undefined) return rejected
    const tabs = await chrome.tabs.query({})
    if (isCancelled(call, signal)) return cancelled()
    const records = tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        controlled: tab.id === context.controlledTabId,
        title: tab.title ?? '',
        url: tabUrl(tab),
      }))
    return {
      ok: true,
      result: { text: wrapUntrustedContent(JSON.stringify({ tabs: records }, null, 2), budget.maxChars) },
    }
  }

  const tabId = requestedTabId(call.args)
  if (tabId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'tabId must be a non-negative safe integer returned by browser_list_tabs.' } }
  }
  const before = await findTab(tabId)
  if (before === undefined) return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  const approval = tabManagementApproval(call, before)
  const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
  if (rejected !== undefined) return rejected
  const current = await findTab(tabId)
  if (current === undefined) return unavailable(`Tab ${tabId} closed while approval was pending. Call browser_list_tabs again.`)
  if (tabUrl(current) !== tabUrl(before)) {
    return unavailable(`Tab ${tabId} navigated while approval was pending. Call browser_list_tabs again before retrying.`)
  }
  if (isCancelled(call, signal)) return cancelled()

  if (call.name === 'browser_follow_tab') {
    if (context.followTab === undefined) return unavailable('The browser could not bind the selected tab in this session.')
    context.commitAction?.()
    await context.followTab(current)
    return {
      ok: true,
      result: { text: `Tab ${tabId} is now the controlled tab. Call browser_snapshot before operating its page.` },
    }
  }
  if (call.name === 'browser_close_tab') {
    try {
      context.commitAction?.()
      await chrome.tabs.remove(tabId)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return unavailable(`Tab ${tabId} could not be closed: ${detail}`)
    }
    return {
      ok: true,
      result: {
        text: tabId === context.controlledTabId
          ? `Closed controlled tab ${tabId}. Call browser_list_tabs and browser_follow_tab before the next page operation.`
          : `Closed tab ${tabId}.`,
      },
    }
  }
  return unavailable(`Unsupported tab-management tool: ${call.name}`)
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @param tabManagement - access mode and affinity callbacks for tab collection tools.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url' | 'title'> & { windowId?: number },
  targetStillAllowed?: () => boolean,
  tabManagement: TabManagementContext = { unrestrictedAccess: false },
  /**
   * What is known about each image, by identity.
   *
   * Passed in rather than imported so this module stays a dispatcher: the vision
   * pipeline and its cache belong to the background entry point.
   */
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (call.name === 'browser_open_tab') {
    return unavailable('browser_open_tab must be dispatched through the background open-tab path.')
  }
  if (call.name === 'browser_describe_image') {
    return unavailable('browser_describe_image must be dispatched through the background vision path.')
  }
  // The bridge starts the browser; reaching this dispatcher at all means it is
  // already running. Answering here (rather than rejecting an unknown name) keeps
  // the tool contract honest: the model called it, so it gets a real result.
  if (call.name === 'browser_launch') {
    return { ok: true, result: { text: 'The browser is already running and the extension is connected. Call browser_snapshot to see the page.' } }
  }
  if (isCancelled(call, signal)) return cancelled()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  if (isTabManagementTool(call.name)) {
    return dispatchTabManagementTool(call, effectiveBudget, authorize, signal, tabManagement)
  }
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (!tabManagement.unrestrictedAccess
    && sharePageContent === 'off'
    && (call.name === 'browser_snapshot' || call.name === 'browser_get_text')) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  if (!isInjectablePage(tab.url) && !TAB_NATIVE_TOOLS.has(call.name)) {
    return unavailable('The current page DOM is protected by the browser. Only snapshot metadata, navigate, back, forward, and reload are available on this page.')
  }
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = tabManagement.unrestrictedAccess
    ? undefined
    : approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  if (!isInjectablePage(tab.url)) {
    return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
      ?? unavailable('The current page DOM is protected by the browser.')
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      tabManagement.unrestrictedAccess || sharePageContent === 'auto',
      tabManagement.commitAction,
      tabManagement.rollbackActionCommit,
      vision,
    )
  } catch (error: unknown) {
    if (isCancelled(call, signal)) return cancelled()
    if (!contentScriptReceiverMissing(error)) {
      return unavailable('The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.')
    }
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    try {
      await injectContentScript(tab.id)
    } catch {
      return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
        ?? unavailable('The content script could not be loaded on this page. Its DOM does not support browser operations.')
    }
    try {
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        tabManagement.unrestrictedAccess || sharePageContent === 'auto',
        tabManagement.commitAction,
        tabManagement.rollbackActionCommit,
        vision,
      )
    } catch {
      return unavailable('The content script did not answer after it was loaded. Call browser_snapshot again before retrying.')
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name !== 'browser_click' && call.name !== 'browser_type') return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  return undefined
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}

/** Parse a model-supplied http(s) URL for tab creation / navigation. */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function removeCreatedTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // The tab may already have been closed by the user or another tool.
  }
}

/**
 * Open a URL in a new tab, then optionally snapshot it once the document is ready.
 * Affinity rebinding is owned by the caller via `bindCreatedTab`.
 *
 * Creates a blank tab first, arms the readiness listener, then navigates so a
 * fast `document_idle` cannot announce readiness before the listener exists.
 * Cancellation before affinity bind rolls the orphan tab back; after bind the
 * open is treated as committed and reported as success even if the call expires.
 */
export async function dispatchOpenTab(
  call: ToolCall,
  windowId: number,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget: ContentBudget | undefined,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  bindCreatedTab: (tab: chrome.tabs.Tab) => boolean,
  targetStillAllowed: (tabId: number) => boolean,
  commitAction?: () => void,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  const parsed = parseHttpUrl(call.args.url)
  if (parsed === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
  }
  const active = call.args.active !== false

  const approval = approvalPromptForCall(call, sharePageContent, [])
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
  }

  let created: chrome.tabs.Tab
  try {
    // No URL yet: register the readiness wait before the http(s) navigation.
    created = await chrome.tabs.create({ active, windowId })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to open a new browser tab.',
      },
    }
  }
  if (created.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome created a tab without an id.' } }
  }
  const tabId = created.id
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }

  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, signal)
  try {
    created = await chrome.tabs.update(tabId, { url: parsed.href })
  } catch (error: unknown) {
    navigationWait.cancel()
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to navigate the new browser tab.',
      },
    }
  }

  const ready = await navigationWait.ready
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }
  commitAction?.()
  if (!bindCreatedTab(created.id === undefined ? { ...created, id: tabId } : created)) {
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The new tab could not become the controlled browser target.' },
    }
  }

  // Affinity is committed: further cancellation must not claim the tab was never opened.
  resetTabSnapshot(tabId)
  if (!targetStillAllowed(tabId)) return targetChanged()

  const status = active
    ? `Opened a new tab at ${parsed.href}.`
    : `Opened a new background tab at ${parsed.href}.`
  if (!ready || sharePageContent === 'off' || isCancelled(call, signal)) {
    return {
      ok: true,
      result: {
        text: sharePageContent === 'off'
          ? `${status} Page content sharing is disabled, so no snapshot was captured.`
          : `${status} Call browser_snapshot again after the page loads.`,
      },
    }
  }

  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      status,
      budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS },
      () => targetStillAllowed(tabId),
      vision,
    )
    if (snapshot !== undefined) return snapshot
  } catch {
    // Keep the successful open when the replacement page is not yet readable.
  }
  return {
    ok: true,
    result: { text: `${status} Call browser_snapshot again after the page loads.` },
  }
}
