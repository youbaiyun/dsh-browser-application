/**
 * The recognition seam, and the two transports behind it.
 *
 * Both paths ask the same question and read the same answer, because the prompt,
 * the request body and the parser live in the shared protocol contract. Which
 * path runs is therefore a deployment fact — whether the desktop has a vision
 * model configured — and never a difference in what the model is told.
 *
 * - `BridgeRecognizer` relays through the desktop. It needs no manifest change
 *   (the extension's CSP allows loopback) and works with whatever credentials the
 *   desktop already holds.
 * - `DirectRecognizer` calls the endpoint itself. The manifest allows `https:` and
 *   `http:`, so the endpoint's host needs no manifest change either.
 *
 * Neither sends an image the ranking of "who can read it" did not already
 * decide: bytes when the extension could read them (it carries the login state),
 * a URL only as the relay's fallback (the desktop's network stack is not bound
 * by the extension's host permissions).
 *
 * @module
 */

import type { ClientFrame, ImageRecognitionRequest, ImageSource, ServerFrame } from '@dsh-browser/protocol'
import {
  THINKING_OFF,
  buildVisionRequestBody,
  parseVisionResponse,
  reasoningTokensOf,
  visionSummaryOf,
} from '@dsh-browser/protocol'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import type { VisionTier } from '../settings.ts'
import type { ImageCache } from './image-cache.ts'
import { compareDescription, type CompareResult } from './vision-compare.ts'

/** How long to wait for one recognition before giving up on it. */
export const VISION_TIMEOUT_MS = 60_000

/** Recognitions in flight at once. The bridge caps its own side at four. */
export const VISION_CONCURRENCY = 2

/** What to recognize, and what the page already says about it. */
export interface RecognitionTarget {
  /** Stable identity; also the cache key, so one logo is described once. */
  identity: string
  alt: string
  near: string
  heading: string
  kind: string
}

/** The outcome of one recognition attempt. */
export type RecognitionOutcome =
  | {
    ok: true
    desc: string
    comparison: CompareResult
    via: 'desktop' | 'direct'
    /** Reasoning tokens the provider reported; 0 when it reported none. */
    reasoningTokens: number
    /**
     * True when the provider reported reasoning tokens for a call that asked for
     * thinking to be off. §3.2 of the design notes that a compatible endpoint can
     * ignore both switches silently, and the response is the only evidence.
     */
    thinkingIgnored: boolean
  }
  | { ok: false; code: string; message: string; permanent: boolean }

/** One transport that can turn an image into a line of text. */
export interface ImageRecognizer {
  /**
   * @param request - page context for the image.
   * @param source - where the bytes are, or where they can be fetched.
   * @param signal - cancels the wait (the far side may still finish its work).
   * @returns the description, or a classified failure.
   */
  describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; desc: string; reasoningTokens?: number }
    | { ok: false; code: string; message: string; permanent: boolean }
  >
}

/**
 * Whether a failure from the desktop should stop this image being asked about.
 *
 * `vision-unclear` is permanent on purpose: the model was asked, it answered
 * that it cannot tell, and asking the same question again produces the same
 * answer for the cost of another request. A declined image is reported as
 * unavailable rather than retried into a loop.
 *
 * @param code - the bridge's error code.
 * @returns true when retrying cannot help this session.
 */
export function isPermanentVisionCode(code: string): boolean {
  return code === 'vision-unclear'
    || code === 'vision-unavailable'
    || code === 'image-unreadable'
    || code === 'image-too-large'
}

/** Outcome shape a recognizer settles with. */
type RecognizerResult =
  | { ok: true; desc: string; reasoningTokens?: number }
  | { ok: false; code: string; message: string; permanent: boolean }

/** One settle function per in-flight recognition. */
type Settle = (result: RecognizerResult) => void

/**
 * Recognition through the desktop bridge.
 *
 * The socket belongs to the background assembly, so this class is handed its
 * `send` and is fed the frames the assembly routes back. It owns only the
 * correlation table.
 */
export class BridgeRecognizer implements ImageRecognizer {
  private readonly pending = new Map<string, Settle>()
  private readonly send: (frame: ClientFrame) => boolean
  private readonly timeoutMs: number

  /**
   * @param send - the bridge client's frame sender (false when disconnected).
   * @param timeoutMs - per-request budget.
   */
  constructor(send: (frame: ClientFrame) => boolean, timeoutMs: number = VISION_TIMEOUT_MS) {
    this.send = send
    this.timeoutMs = timeoutMs
  }

  /** Recognitions waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Take an `image.result` frame, if it belongs to a request in flight.
   * @param frame - a server frame.
   * @returns true when the frame was consumed here.
   */
  handleFrame(frame: ServerFrame): boolean {
    if (frame.t !== 'image.result') return false
    const settle = this.pending.get(frame.id)
    if (settle === undefined) return false
    this.pending.delete(frame.id)
    if (frame.ok) {
      settle({ ok: true, desc: frame.desc })
    } else {
      settle({
        ok: false,
        code: frame.error.code,
        message: frame.error.message,
        permanent: isPermanentVisionCode(frame.error.code),
      })
    }
    return true
  }

  /**
   * Fail every waiting request, for instance when the socket drops.
   * @param code - failure code to settle them with.
   * @param permanent - whether the caller should stop asking.
   */
  failAll(code: string, permanent: boolean): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const settle of waiting) settle({ ok: false, code, message: code, permanent })
  }

  /** @inheritdoc */
  async describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<RecognizerResult> {
    // Checked before sending, not only after: the caller may have given up while this
    // waited for a concurrency slot, and dispatching anyway uploads a user's image to
    // the provider for an answer nobody is waiting for. `DirectRecognizer` guards the
    // same way for the same reason; this path needs it more, because a queued call can
    // wait arbitrarily long before reaching here.
    if (signal.aborted) {
      return { ok: false, code: 'image-cancelled', message: 'the call was cancelled', permanent: false }
    }
    const id = crypto.randomUUID()
    const dispatched = this.send({ t: 'image.call', id, request, source })
    if (!dispatched) {
      return { ok: false, code: 'bridge-closed', message: 'no bridge connection', permanent: false }
    }
    return await new Promise<RecognizerResult>((resolve) => {
      const finish = (result: RecognizerResult): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        resolve(result)
      }
      const onAbort = (): void => {
        // The protocol has no image.cancel frame, so the desktop may still finish
        // and bill the call; what stops here is only the waiting.
        finish({ ok: false, code: 'image-cancelled', message: 'cancelled before the desktop answered', permanent: false })
      }
      const timer = setTimeout(() => {
        finish({ ok: false, code: 'image-timeout', message: `no answer within ${String(this.timeoutMs)}ms`, permanent: false })
      }, this.timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, finish)
      if (signal.aborted) onAbort()
    })
  }
}

/**
 * The chat-completions URL for a configured endpoint.
 *
 * Both transports read the same setting, so they have to read it the same way: the
 * desktop's own client appends the path, and a user who pasted the full URL should
 * not end up posting to `…/chat/completions/chat/completions`.
 *
 * @param endpoint - the configured base URL, or the full path.
 * @returns the URL to POST to.
 */
export function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/** Endpoint, credential and model for the extension's own outbound call. */
export interface DirectVisionConfig {
  endpoint: string
  model: string
  apiKey: string
  /** Extra request fields; defaults to {@link THINKING_OFF}. */
  extraBody?: Record<string, unknown>
}

/**
 * Recognition by calling the endpoint directly.
 *
 * Requires image bytes: the shared contract builds a `data:` URL, so a URL-only
 * source has to be fetched first, and the coordinator does that.
 */
export class DirectRecognizer implements ImageRecognizer {
  private readonly config: () => DirectVisionConfig | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  /**
   * @param config - reads the current endpoint settings (absent = not configured).
   * @param fetchImpl - fetch implementation, injectable for tests.
   * @param timeoutMs - per-request budget.
   */
  constructor(
    config: () => DirectVisionConfig | undefined,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = VISION_TIMEOUT_MS,
  ) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  /** @inheritdoc */
  async describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<RecognizerResult> {
    const config = this.config()
    if (config === undefined || config.endpoint === '' || config.model === '') {
      return { ok: false, code: 'vision-unavailable', message: 'no vision endpoint configured', permanent: true }
    }
    if (source.kind !== 'bytes') {
      return { ok: false, code: 'vision-needs-bytes', message: 'the direct path sends bytes, not URLs', permanent: false }
    }
    const body = buildVisionRequestBody(
      { model: config.model, extraBody: config.extraBody ?? THINKING_OFF },
      { base64: source.base64, mediaType: source.mediaType },
      { alt: request.alt, near: request.near, heading: request.heading, kind: request.kind, tier: request.tier },
    )
    // One controller for both cancels: `AbortSignal.any`/`AbortSignal.timeout`
    // are recent additions and the service worker is not the only place this runs
    // (the test environment is a second), so the combination is built by hand.
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    // The signal may already be aborted by the time this runs: `run()` can wait in
    // `acquire()` behind another image, and the caller may have given up long
    // before. Without this check the listener never fires and the request goes out
    // anyway — sending a user's image to the provider for an answer nobody wants.
    if (signal.aborted) onAbort()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let payload: unknown
    try {
      const response = await this.fetchImpl(chatCompletionsUrl(config.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, code: 'vision-failed', message: `HTTP ${String(response.status)}`, permanent: false }
      }
      payload = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal.aborted) return { ok: false, code: 'image-cancelled', message, permanent: false }
      // An extension page may only reach hosts its CSP allows. Saying so turns the
      // most likely cause of "Failed to fetch" into something the user can act on,
      // instead of a message that reads like the network is down.
      return {
        ok: false,
        code: 'vision-failed',
        message,
        permanent: false,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const parsed = parseVisionResponse(payload)
    if (!parsed.ok) {
      return { ok: false, code: parsed.code, message: parsed.message, permanent: isPermanentVisionCode(parsed.code) }
    }
    // Thinking was asked to be off, but a provider may ignore both switches
    // silently; reasoning tokens in the response are the only evidence that it
    // did, so they travel with the answer instead of being assumed away.
    return { ok: true, desc: parsed.desc, reasoningTokens: reasoningTokensOf(parsed.usage) }
  }
}

/**
 * Budget for the wrapped description.
 *
 * The envelope is the security notice twice plus two nonce-bearing tags, which
 * comes to roughly 400 characters on its own, and the description is at most
 * `MAX_DESC_CHARS` on top of that. A budget below the sum does not shrink the
 * description — it deletes it, leaving the model an empty boundary and a
 * truncation note. A 400-character budget did exactly that.
 */
const DESCRIPTION_TEXT_BUDGET = 700

/**
 * The model-facing text for one recognition outcome.
 *
 * The description is wrapped as untrusted, and that is not boilerplate: it is a
 * model's reading of an image nobody in this conversation wrote, and an image can
 * carry text the model transcribes verbatim. That is exactly how a picture becomes
 * an instruction, so the description travels inside the same boundary as page
 * text. The cross-check line is ours, and it is what says how much of the rest to
 * believe — including saying plainly when nothing could be checked at all.
 *
 * @param index - the image's inventory index.
 * @param outcome - the recognition result.
 * @param byteFailure - why the extension could not read the bytes, when it could not.
 * @returns the tool result text.
 */
export function describeOutcomeText(
  index: number,
  outcome: RecognitionOutcome,
  byteFailure?: string,
): string {
  if (!outcome.ok) {
    const retry = outcome.permanent
      ? 'It will not be asked about again in this session.'
      : 'Trying again later may succeed.'
    return `Image [${String(index)}] could not be described: ${outcome.code} — ${outcome.message} ${retry}`
  }
  const lines = [`Image [${String(index)}] (via ${outcome.via}): ${wrapUntrustedContent(outcome.desc, DESCRIPTION_TEXT_BUDGET)}`]
  if (outcome.thinkingIgnored) {
    lines.push(`Note: the provider billed ${String(outcome.reasoningTokens)} reasoning tokens although thinking was requested off.`)
  }
  if (outcome.comparison.verdict === 'conflict') {
    const details = outcome.comparison.conflicts.map((entry) => entry.detail).join('; ')
    lines.push(`Cross-check against the page text: CONFLICT — ${details}. Do not act on this description before the user confirms it.`)
  } else if (outcome.comparison.verdict === 'uncertain') {
    // A note is reported as an observation, not a verdict: word overlap can show
    // that the description did not repeat the page's words, which is not the same
    // as disagreement, and a warning that fires on agreement stops being read.
    const note = outcome.comparison.note === undefined ? '' : ` — ${outcome.comparison.note}`
    lines.push(outcome.comparison.basis === 'skipped'
      ? 'Cross-check against the page text: skipped by the low tier.'
      : outcome.comparison.basis === 'none'
        ? 'Cross-check against the page text: not possible, the page says nothing about this image.'
        : `Cross-check against the page text: nothing conclusive${note}.`)
  } else {
    lines.push('Cross-check against the page text: consistent.')
  }
  if (byteFailure !== undefined) {
    lines.push(`(The extension could not read these bytes — ${byteFailure} — so the desktop fetched them instead.)`)
  }
  return lines.join('\n')
}

/**
 * What the tool dispatcher reports to the vision pipeline.
 *
 * One object rather than two callbacks: both answers come from the same place —
 * the text a page action produced — and threading them separately would make the
 * dispatcher's parameter list grow a second time for the same reason.
 */
export interface VisionSink {
  /** State to render for one image, by identity; undefined leaves the marker. */
  states(identity: string): string | undefined
  /**
   * Page text this answer carried, for the cross-modal check.
   *
   * Callers pass text with the markers already removed: a filled marker holds a
   * description, and a description naming a number would otherwise be compared
   * against itself.
   */
  sawPageText(text: string): void
}

/** Everything the coordinator needs from the background assembly. */
export interface VisionDeps {
  cache: ImageCache
  send: (frame: ClientFrame) => boolean
  /** Whether the desktop said it can recognize images (`policy.imageRecognition`). */
  canRelay: () => boolean
  /** Direct-path settings reader; absent when the user has not configured one. */
  directConfig?: () => DirectVisionConfig | undefined
  /** The page's visible text, for the cross-modal check. */
  pageText: () => string
  /** Bytes of an image, when the caller already has them. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Turns images into descriptions: one cache, two transports, one verification.
 *
 * The coordinator is the only place that decides *which* path runs, so a caller
 * cannot accidentally pick one and skip the cross-modal check that belongs to
 * the answer.
 */
export class VisionCoordinator {
  private readonly cache: ImageCache
  private readonly relay: BridgeRecognizer
  private readonly direct: DirectRecognizer | undefined
  private readonly directConfig: (() => DirectVisionConfig | undefined) | undefined
  private readonly canRelay: () => boolean
  private readonly pageText: () => string
  private readonly inFlight = new Map<string, Promise<RecognitionOutcome>>()
  private readonly waiting: Array<() => void> = []
  private active = 0
  private readonly limit: number

  /**
   * @param deps - cache, transports and page text.
   * @param limit - recognitions in flight at once.
   */
  constructor(deps: VisionDeps, limit: number = VISION_CONCURRENCY) {
    this.cache = deps.cache
    this.relay = new BridgeRecognizer(deps.send, deps.timeoutMs ?? VISION_TIMEOUT_MS)
    this.directConfig = deps.directConfig
    this.direct = deps.directConfig === undefined
      ? undefined
      : new DirectRecognizer(deps.directConfig, deps.fetchImpl ?? fetch, deps.timeoutMs ?? VISION_TIMEOUT_MS)
    this.canRelay = deps.canRelay
    this.pageText = deps.pageText
    this.limit = limit
  }

  /** Frames this coordinator owns; the assembly routes them here first. */
  handleFrame(frame: ServerFrame): boolean {
    return this.relay.handleFrame(frame)
  }

  /**
   * Settle every recognition waiting on the desktop, because the socket is gone.
   *
   * Called when the connection is lost. Without it a relay round trip in progress
   * waits out its full timeout for an answer that cannot arrive: the caller's abort
   * signal usually saves it, but a call whose caller never aborts would leave the
   * model holding a `pending` marker for a minute. Settling now costs nothing and
   * reports the same thing the socket drop means.
   *
   * @param code - the failure code to settle them with; it doubles as the message.
   */
  relayLost(code: string): void {
    this.relay.failAll(code, false)
  }

  /** Descriptions remembered, and what failed. */
  stats(): ReturnType<ImageCache['stats']> {
    return this.cache.stats()
  }

  /** What is remembered for an image, for rendering back into the snapshot. */
  descriptionOf(identity: string): string | undefined {
    return this.cache.get(identity)?.desc
  }

  /**
   * The state to render for one image where it appears in the page text.
   *
   * Every branch says something the model can act on. An image being recognized
   * says `pending` rather than staying silent, because "nothing yet" and "there is
   * no image here" must not look the same; a failed one carries its reason, since
   * `unavailable` alone tells the model nothing it can use.
   *
   * @param identity - image identity from the snapshot's identity map.
   * @returns the state text, or undefined when this identity is unknown here.
   */
  stateFor(identity: string): string | undefined {
    const cached = this.cache.get(identity)
    // The marker carries a summary, not the description: a snapshot repeats every
    // marker, so the full text would spend the page's character budget on images
    // nobody asked about. Asking again returns the whole thing from the cache.
    if (cached !== undefined) return visionSummaryOf(cached.desc)
    if (this.inFlight.has(identity)) return 'pending'
    const failure = this.cache.failureOf(identity)
    if (failure !== undefined) return `unavailable:${failure}`
    return undefined
  }

  /**
   * Whether any path could answer right now.
   *
   * Consulted before queueing so an unconfigured desktop does not fill the cache
   * with failures for every image on the page.
   *
   * @returns true when at least one transport is usable.
   */
  canRecognize(): boolean {
    if (this.canRelay()) return true
    const config = this.directConfig?.()
    return config !== undefined && config.endpoint !== '' && config.model !== ''
  }

  /**
   * Describe one image, reusing any earlier answer.
   *
   * @param target - the image and its page context.
   * @param source - bytes (preferred) or a URL for the relay to fetch.
   * @param signal - cancels the wait.
   * @returns the description with its cross-modal verdict, or a failure.
   */
  async describe(
    target: RecognitionTarget,
    source: ImageSource,
    signal: AbortSignal,
    tier: VisionTier = 'standard',
  ): Promise<RecognitionOutcome> {
    const cached = this.cache.get(target.identity)
    if (cached !== undefined) {
      return {
        ok: true,
        desc: cached.desc,
        comparison: this.compare(cached.desc, target, tier),
        via: cached.via === 'direct' ? 'direct' : 'desktop',
        // A remembered answer carries no fresh provider usage to report.
        reasoningTokens: 0,
        thinkingIgnored: false,
      }
    }
    if (!this.cache.shouldAttempt(target.identity)) {
      return { ok: false, code: 'vision-skipped', message: 'this image cannot be read in this session', permanent: true }
    }
    const existing = this.inFlight.get(target.identity)
    if (existing !== undefined) return await existing
    const work = this.run(target, source, signal, tier)
    this.inFlight.set(target.identity, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(target.identity)
    }
  }

  private async run(
    target: RecognitionTarget,
    source: ImageSource,
    signal: AbortSignal,
    tier: VisionTier,
  ): Promise<RecognitionOutcome> {
    await this.acquire()
    try {
      const request: ImageRecognitionRequest = {
        identity: target.identity,
        alt: target.alt,
        near: target.near,
        heading: target.heading,
        kind: target.kind,
        tier,
      }
      const relay = this.canRelay()
      const recognizer: ImageRecognizer | undefined = relay ? this.relay : this.direct
      if (recognizer === undefined) {
        return { ok: false, code: 'vision-unavailable', message: 'no vision model is configured', permanent: true }
      }
      const result = await recognizer.describe(request, source, signal)
      if (!result.ok) {
        this.cache.noteFailure(target.identity, result.permanent, result.code)
        return result
      }
      const via: 'desktop' | 'direct' = relay ? 'desktop' : 'direct'
      this.cache.set(target.identity, result.desc, via)
      const reasoningTokens = result.reasoningTokens ?? 0
      return {
        ok: true,
        desc: result.desc,
        comparison: this.compare(result.desc, target, tier),
        via,
        reasoningTokens,
        thinkingIgnored: reasoningTokens > 0,
      }
    } finally {
      this.release()
    }
  }

  private compare(desc: string, target: RecognitionTarget, tier: VisionTier): CompareResult {
    // The low tier exists to be cheap: it answers what the image shows and does
    // not pay for the cross-check. Reporting that plainly beats returning a
    // `consistent` verdict for a check that was never run.
    if (tier === 'low') return { verdict: 'uncertain', conflicts: [], basis: 'skipped', overlap: 0 }
    return compareDescription(desc, { alt: target.alt, near: target.near, heading: target.heading }, this.pageText())
  }

  /** Take a concurrency slot, or wait for one to be handed over. */
  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    // `release` handed this caller the slot; the count is unchanged.
  }

  /** Hand the slot to the next waiter, or give it back. */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next()
  }
}
