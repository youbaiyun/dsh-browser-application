/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { pageText, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'
import { collectImages, imageIdentity, type ImageCandidate } from './images.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'

/**
 * One image resolved to everything the background needs to describe it.
 *
 * `identity` is the cache key and the protocol's request identity at once: two
 * rows showing the same logo share it, so the page is charged for one
 * description rather than thirty.
 */
export interface ImageTarget {
  identity: string
  alt: string
  near: string
  heading: string
  /** Protocol vocabulary: content, icon, link, button, background or canvas. */
  kind: string
  /** Absolute URL, or '' for images with no fetchable address. */
  src: string
}

/** One numbered image's identity, so the background can look up its state. */
export interface ImageIdentity {
  index: number
  identity: string
  /**
   * Set when the page already knows this image cannot be read, such as an image
   * whose load failed. A failed image is never requested, so no cache entry will
   * ever exist for it and the reason has to come from here.
   */
  unavailable?: string
}

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
  /** The image this action resolved, for the vision pipeline. */
  image?: ImageTarget
  /**
   * Identities of the images this result numbered.
   *
   * The markers in the text name an index; the description cache is keyed by
   * identity. Without this map the background would have to parse URLs back out
   * of its own rendered text to connect the two.
   */
  imageIdentities?: ImageIdentity[]
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * How long a `browser_wait` condition may stay unsatisfied before it fails.
 *
 * Bounded on purpose, and shorter than the bridge's own 90s per-call budget: a
 * condition runs inside the content script, and `chrome.runtime` messages cannot
 * carry an `AbortSignal`, so a cancelled tool call cannot interrupt this loop — the
 * caller stops waiting, but the poll keeps running until the deadline. Keeping the
 * deadline short bounds that, and costs nothing legitimate: a wait meant to outlast
 * ten seconds is a wait for something the page is not going to do.
 */
const WAIT_CONDITION_TIMEOUT_MS = 10_000

/**
 * Ceiling for a caller-supplied wait budget.
 *
 * Well inside the bridge's 90s per-call timeout, so a wait cannot outlive the call
 * that asked for it, and low enough that the value cannot be used to hold a tool
 * slot open indefinitely.
 */
export const WAIT_MAX_BUDGET_MS = 60_000
/** Poll spacing for a wait condition; short enough to feel immediate, cheap enough to hold. */
const WAIT_POLL_MS = 100

/**
 * Wait until a condition holds, then return.
 *
 * A condition that never holds is a failure, not a silent success: the model has
 * to know the page never produced what it was waiting for, so it can decide
 * whether to keep waiting or give up. The protocol's `timeout` code is what
 * carries that, and it is the reason this throws rather than returning.
 *
 * @param description - what was waited for, for the error message.
 * @param budgetMs - how long to keep polling.
 * @param satisfied - re-evaluated on every poll.
 * @throws ActionError with code `timeout` when the deadline passes.
 */
async function waitUntil(description: string, budgetMs: number, satisfied: () => boolean): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (satisfied()) return
    if (Date.now() >= deadline) {
      throw new ActionError('timeout', `Timed out after ${budgetMs}ms waiting for ${description}.`)
    }
    await sleep(WAIT_POLL_MS)
  }
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_describe_image':
      return describeImageAction(args, ctx)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta), imageIdentities: imageIdentitiesOf(view) }
}

/** Identities of the numbered images in a view, for the background to look up. */
function imageIdentitiesOf(view: ReturnType<typeof buildSnapshot>): ImageIdentity[] {
  return view.images.map((image) => ({
    index: image.index,
    identity: image.identity,
    ...image.unavailable === undefined ? {} : { unavailable: image.unavailable },
  }))
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
    imageIdentities: imageIdentitiesOf(view),
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link [${index}]. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link [${index}]. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked [${index}].`, ctx)
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean): void {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // Fall through to the direct-write path below.
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)

  // A `<select>` and a checkbox are not text fields, but the tool the model is
  // told about fills all three: the inventory renders them, so "type into it" is
  // the phrasing a model reaches for. Matching by value, then by visible label,
  // then by 1-based index is the order a human tries them in.
  if (el instanceof HTMLSelectElement) {
    const chosen = chooseOption(el, text)
    if (chosen === undefined) {
      // List the labels, not just the values: a value like `a` tells the reader
      // nothing about what it selects, and this message exists to be acted on.
      const available = [...el.options].slice(0, 20).map((option, position) => {
        const label = option.text.trim()
        return label !== '' && label !== option.value
          ? `${String(position + 1)}. ${option.value} (${label})`
          : `${String(position + 1)}. ${option.value || label}`
      })
      throw new ActionError('action-failed', `Element [${index}] has no option matching "${text}". Available: ${available.join(', ')}${el.options.length > 20 ? ', …' : ''}.`)
    }
    // Select through the option's own `selected` property, then tell the page:
    // frameworks listen for `change`, and a plain assignment to `select.value`
    // does not dispatch it.
    for (const option of el.options) option.selected = option === chosen
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await waitForPageSettled(TYPE_SETTLE)
    return withPageDelta(`Selected "${chosen.text.trim() || chosen.value}" in [${index}].`, ctx)
  }

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const wanted = parseCheckboxValue(text)
    if (wanted === undefined) {
      throw new ActionError('bad-args', `Element [${index}] is a ${el.type}; pass true or false as text to set it.`)
    }
    if (el.disabled) {
      // A disabled control accepts no click, so reporting the requested state
      // would be a fiction. `<button disabled>` is refused for the same reason.
      throw new ActionError('action-failed', `Element [${index}] is disabled; the page decides when it may be changed.`)
    }
    if (el.type === 'radio' && wanted === false && el.checked) {
      // A radio cannot be unchecked by clicking it — the group always has a
      // selection — so the honest answer is a refusal, not "Unchecked".
      throw new ActionError('action-failed', `Element [${index}] is a radio and cannot be unchecked directly; check another radio in its group instead.`)
    }
    // `click()` rather than assigning `checked`: it fires the events the page
    // listens for and, for a radio, moves the selection within its group.
    if (el.checked !== wanted) el.click()
    await waitForPageSettled(TYPE_SETTLE)
    if (el.checked !== wanted) {
      // The page may reject the change (a read-only control, a handler that
      // restores the previous value). Report what happened, not what was asked.
      throw new ActionError('action-failed', `Element [${index}] did not accept the change; it is still ${el.checked ? 'checked' : 'unchecked'}.`)
    }
    return withPageDelta(`${wanted ? 'Checked' : 'Unchecked'} [${index}].`, ctx)
  }

  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into [${index}].`, ctx)
}

/**
 * The option a `<select>` should switch to, or undefined when nothing matches.
 *
 * Order is value → visible label → 1-based position, and the comparison is
 * case-insensitive on trimmed text so `true`/`True` and a stray newline in a
 * label both work.
 */
function chooseOption(select: HTMLSelectElement, text: string): HTMLOptionElement | undefined {
  const wanted = text.trim().toLowerCase()
  const options = [...select.options]
  return options.find((option) => option.value.trim().toLowerCase() === wanted)
    ?? options.find((option) => option.text.trim().toLowerCase() === wanted)
    ?? (/^\d+$/u.test(wanted) ? options[Number(wanted) - 1] : undefined)
}

/** `true`/`false` (and the usual synonyms) for a checkbox or radio. */
function parseCheckboxValue(text: string): boolean | undefined {
  const value = text.trim().toLowerCase()
  if (['true', '1', 'on', 'yes', 'checked'].includes(value)) return true
  if (['false', '0', 'off', 'no', 'unchecked'].includes(value)) return false
  return undefined
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  // Both the delay and a condition budget are bounded: the bridge gives up on a
  // call at its own timeout, and a caller-supplied number large enough to overflow
  // (`1e999` parses to Infinity) must not turn the poll into an infinite loop.
  const rawMs = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  const ms = Math.min(rawMs, WAIT_MAX_BUDGET_MS)
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  // `pageText` collapses every run of whitespace to one space, so the needle has to
  // be collapsed the same way or a multi-line label can never match the haystack.
  const wanted = typeof args.text === 'string' && args.text !== '' ? args.text.replace(/\s+/gu, ' ').trim() : undefined
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)

  // A condition is a promise to the model that the page will actually produce
  // what it asked for; when it never does, failing with `timeout` is the whole
  // point of asking. Without a condition this stays what it always was: settle,
  // then an optional extra delay.
  if (selector !== undefined) {
    await waitUntil(`selector "${selector}" to match`, ms > 0 ? ms : WAIT_CONDITION_TIMEOUT_MS, () => document.querySelector(selector) !== null)
  } else if (wanted !== undefined) {
    await waitUntil(`text "${wanted}" to appear`, ms > 0 ? ms : WAIT_CONDITION_TIMEOUT_MS, () => pageText(document.body).includes(wanted))
  } else if (ms > 0) {
    await sleep(ms)
  }

  const described = selector !== undefined
    ? `selector "${selector}" matched`
    : wanted !== undefined ? `text "${wanted}" appeared` : 'the page is stable'
  return withPageDelta(`Waited until ${described}${ms > 0 && (selector !== undefined || wanted !== undefined) ? ` (within ${ms}ms)` : ''}.`, ctx)
}

/**
 * Resolve one image by inventory index, for the vision pipeline.
 *
 * The content script is the only party that can see the page, so it answers with
 * the image's identity and context and nothing more: fetching bytes and talking
 * to a model are the background's business, and the page is never asked to
 * describe itself.
 *
 * An index is a claim about the document that produced it, and a re-render breaks
 * that claim: the DOM node the id was attached to is replaced, the registry
 * retires the id with it, and the number the model remembers resolves to nothing.
 * That used to end the call even when the picture had not moved. `identity` is
 * the background's memory of what that number pointed at, so the image can be
 * found by address rather than by a number that shifted.
 *
 * @param args - the tool arguments (`index`, plus the background's `identity`).
 * @param ctx - the id registry, for index resolution.
 * @returns a status line plus the resolved image.
 */
function describeImageAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const index = numberArg(args, 'index')
  const element = ctx.ids.elementByIndex(index)
  /**
   * Harvested at most once, and only when something actually needs the list.
   *
   * The harvest forces layout for up to 1500 elements looking for background
   * images, so a call that resolves its index the ordinary way should not pay for
   * it merely to be able to phrase a failure it will not reach.
   */
  let collected: ImageCandidate[] | undefined
  const images = (): ImageCandidate[] => (collected ??= collectImages(document))

  let image = element === undefined ? undefined : images().find((candidate) => candidate.element === element)
  let recovered = false
  if (element === undefined && isAddressHint(args.identity)) {
    // Only a unique match is a recovery. When one address is reused across many
    // tiles — a shared logo, a placeholder — taking the first would hand the model
    // the wrong `alt`, `near` and `heading` for an image whose answer is not cached
    // yet, and a wrong description of the wrong tile is worse than a clear failure.
    const matches = images().filter((candidate) => matchesRememberedIdentity(candidate, args.identity))
    if (matches.length === 1) {
      image = matches[0]
      recovered = true
    }
  }
  if (image === undefined) {
    throw new ActionError('action-failed', element === undefined
      ? imageIndexFailure(index, images, ctx)
      : `Element [${index}] is not an image that browser_snapshot listed.`)
  }
  // The cache key and the request identity are the same value, which is what makes
  // one page with thirty identical logos cost one description instead of thirty.
  // The rule lives in `imageIdentity` so the snapshot reports the identical string.
  const identity = imageIdentity(image.src, index)
  const current = ctx.ids.indexOf(image.element)
  return {
    text: `Image [${index}] resolved: ${image.kind} ${String(image.width)}x${String(image.height)}`
      + `${image.label === '' ? '' : ` "${image.label}"`}`
      + `${recovered
        ? ` — recovered by address after the page changed; it is now index [${current === undefined ? 'unlisted' : String(current)}]`
        : ''}`,
    image: {
      identity,
      alt: image.label,
      near: image.near,
      heading: image.heading,
      kind: protocolKind(image, image.element),
      src: image.src,
    },
  }
}

/**
 * Whether a remembered identity is an address this action can match on.
 *
 * Only absolute addresses qualify. An image with no address is identified by its
 * inventory number, which is the very thing that went stale, so matching on that
 * number would be inventing an answer instead of recovering one.
 *
 * @param identity - what the background remembers that number pointed at.
 * @returns true when it is an address.
 */
function isAddressHint(identity: unknown): identity is string {
  return typeof identity === 'string' && identity !== '' && !identity.startsWith('el:')
}

/**
 * Whether one harvested image is the one a remembered identity named.
 *
 * @param image - a harvested candidate.
 * @param identity - what the background remembers that number pointed at.
 * @returns true when this is that image.
 */
function matchesRememberedIdentity(image: ImageCandidate, identity: unknown): boolean {
  return isAddressHint(identity) && image.src === identity
}

/**
 * Why an index did not resolve, and which numbers do resolve now.
 *
 * The numbers the reader was actually shown come first: a live re-scan counts far
 * more images than the snapshot's `Images` section did, and naming a number that
 * is absent from the reader's own snapshot is not a next step it can take. The
 * scan is the fallback for a document that has not been snapshotted yet.
 *
 * @param index - the number that failed.
 * @param images - lazy harvest, consulted only when the snapshot cannot answer.
 * @param ctx - the id registry, for the current numbering.
 * @returns the message.
 */
function imageIndexFailure(index: number, images: () => ImageCandidate[], ctx: ActionContext): string {
  const numbered = lastSnapshot === null ? [] : lastSnapshot.images.map((view) => view.index)
  const current = numbered.length > 0
    ? numbered
    : images()
      .map((candidate) => ctx.ids.indexOf(candidate.element))
      .filter((id): id is number => id !== undefined)
  const listed = current.length === 0
    ? 'the page currently numbers no images'
    : `the page currently numbers images ${current.slice(0, 20).join(', ')}`
  return `Element [${index}] does not exist; the page may have changed, and ${listed}. Call browser_snapshot for a full refresh.`
}

/**
 * Map the harvested kind onto the protocol's vocabulary.
 *
 * The harvest says how an image was found (`img`, `svg`, `poster`,
 * `background`); the recognition request says what it is in the page (content,
 * icon, link, button, background, canvas), because that is what changes how the
 * answer should be read.
 *
 * @param image - the harvested candidate.
 * @param element - its element.
 * @returns the protocol kind.
 */
function protocolKind(image: ImageCandidate, element: Element): string {
  if (image.kind === 'background') return 'background'
  if (element.closest('a[href]') !== null) return 'link'
  if (element.closest('button, [role="button"]') !== null) return 'button'
  return 'content'
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
