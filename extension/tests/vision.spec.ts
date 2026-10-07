// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ClientFrame, ImageRecognitionRequest, ImageSource, ServerFrame } from '@dsh-browser/protocol'
import { MAX_DESC_CHARS, THINKING_OFF, VISION_MARKER_CHARS } from '@dsh-browser/protocol'
import { ImageCache } from '../src/background/image-cache.ts'
import {
  BridgeRecognizer,
  DirectRecognizer,
  VisionCoordinator,
  chatCompletionsUrl,
  describeOutcomeText,
  isPermanentVisionCode,
  type RecognitionTarget,
} from '../src/background/vision.ts'

const REQUEST: ImageRecognitionRequest = {
  identity: 'https://x.test/chart.png',
  alt: '季度营收',
  near: '营收趋势',
  heading: '财务',
  kind: 'content',
}

const BYTES: ImageSource = { kind: 'bytes', mediaType: 'image/png', base64: 'AQID' }

const TARGET: RecognitionTarget = {
  identity: 'https://x.test/chart.png',
  alt: '季度营收',
  near: '营收趋势',
  heading: '财务',
  kind: 'content',
}

/** Capture sent frames and hand back the ids, so a test can answer them. */
function recorder(): { frames: ClientFrame[]; send: (frame: ClientFrame) => boolean } {
  const frames: ClientFrame[] = []
  return { frames, send: (frame) => { frames.push(frame); return true } }
}

/** The id of the nth image.call in the recorded frames. */
function callId(frames: ClientFrame[], index = 0): string {
  const calls = frames.filter((frame): frame is Extract<ClientFrame, { t: 'image.call' }> => frame.t === 'image.call')
  const call = calls[index]
  if (call === undefined) throw new Error(`no image.call at index ${String(index)}`)
  return call.id
}

/** Build a coordinator whose relay sends into `options.frames`. */
function coordinator(options: {
  frames: ClientFrame[]
  relay?: boolean
  cache?: ImageCache
  limit?: number
  pageText?: string
  timeoutMs?: number
}): VisionCoordinator {
  return new VisionCoordinator({
    cache: options.cache ?? new ImageCache(),
    send: (frame) => { options.frames.push(frame); return true },
    canRelay: () => options.relay ?? true,
    pageText: () => options.pageText ?? '',
    timeoutMs: options.timeoutMs ?? 5_000,
  }, options.limit ?? 2)
}

/** Wait until the coordinator has put at least one frame on the wire. */
async function dispatched(frames: ClientFrame[]): Promise<void> {
  await vi.waitFor(() => { expect(frames.length).toBeGreaterThanOrEqual(1) })
}

describe('isPermanentVisionCode', () => {
  it('separates "asking again is pointless" from "try later"', () => {
    expect(isPermanentVisionCode('vision-unclear')).toBe(true)
    expect(isPermanentVisionCode('vision-unavailable')).toBe(true)
    expect(isPermanentVisionCode('image-too-large')).toBe(true)
    expect(isPermanentVisionCode('vision-failed')).toBe(false)
    expect(isPermanentVisionCode('image-timeout')).toBe(false)
  })
})

describe('BridgeRecognizer', () => {
  it('sends the request and settles on the matching result frame', async () => {
    const { frames, send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    const pending = recognizer.describe(REQUEST, BYTES, new AbortController().signal)

    const call = frames[0]
    expect(call).toMatchObject({ t: 'image.call', request: REQUEST, source: BYTES })
    expect(recognizer.pendingCount).toBe(1)

    expect(recognizer.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图' })).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true, desc: '季度营收折线图' })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('ignores frames that are not its own', () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    expect(recognizer.handleFrame({ t: 'image.result', id: 'nobody', ok: true, desc: 'x' })).toBe(false)
    expect(recognizer.handleFrame({ t: 'ping' })).toBe(false)
  })

  it('reports a disconnected bridge without waiting', async () => {
    const recognizer = new BridgeRecognizer(() => false)
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'bridge-closed', message: 'no bridge connection', permanent: false })
  })

  it('classifies a declined image as permanent', async () => {
    const { frames, send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    const pending = recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    recognizer.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: false,
      error: { code: 'vision-unclear', message: 'the model declined' },
    })
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'vision-unclear', permanent: true })
  })

  it('gives up on a silent desktop', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 20)
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toMatchObject({ ok: false, code: 'image-timeout', permanent: false })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('stops waiting when the caller cancels', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 5_000)
    const controller = new AbortController()
    const pending = recognizer.describe(REQUEST, BYTES, controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'image-cancelled' })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('settles every waiter when the socket drops', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 5_000)
    const first = recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    const second = recognizer.describe({ ...REQUEST, identity: 'b' }, BYTES, new AbortController().signal)
    recognizer.failAll('bridge-closed', false)
    await expect(first).resolves.toMatchObject({ ok: false, code: 'bridge-closed' })
    await expect(second).resolves.toMatchObject({ ok: false, code: 'bridge-closed' })
    expect(recognizer.pendingCount).toBe(0)
  })
})

describe('DirectRecognizer', () => {
  function completion(content: string, usage?: Record<string, unknown>): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        ...usage === undefined ? {} : { usage },
      }),
    } as unknown as Response
  }

  it('refuses without a configured endpoint', async () => {
    const recognizer = new DirectRecognizer(() => undefined)
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-unavailable', permanent: true })
  })

  it('refuses a URL source: this path sends bytes', async () => {
    const recognizer = new DirectRecognizer(() => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }))
    await expect(recognizer.describe(REQUEST, { kind: 'url', url: 'https://x.test/a.png' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-needs-bytes' })
  })

  it('asks the shared question, with thinking off and no temperature', async () => {
    const fetchImpl = vi.fn(async () => completion('一张季度营收折线图'))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1', model: 'flash-vision', apiKey: 'secret' }),
      fetchImpl as unknown as typeof fetch,
    )
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toEqual({ ok: true, desc: '一张季度营收折线图', reasoningTokens: 0 })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // The switches must actually be in the body: a provider that ignores them is
    // only detectable if they were sent.
    expect(body).toMatchObject({ model: 'flash-vision', temperature: 0, max_tokens: MAX_DESC_CHARS, ...THINKING_OFF })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })

  it('reports reasoning tokens when the provider billed thinking anyway', async () => {
    const fetchImpl = vi.fn(async () => completion('一张图', { completion_tokens_details: { reasoning_tokens: 348 } }))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, reasoningTokens: 348 })
  })

  it('treats an UNCLEAR answer as a permanent decline', async () => {
    const fetchImpl = vi.fn(async () => completion('UNCLEAR'))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-unclear', permanent: true })
  })

  it('classifies a failed request as retryable', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 } as unknown as Response))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'vision-failed', message: 'HTTP 429', permanent: false })
  })
})

describe('VisionCoordinator', () => {
  it('answers from the cache without a second request, and keeps its transport', async () => {
    const cache = new ImageCache()
    cache.set(TARGET.identity, '季度营收折线图', 'direct')
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, cache })
    const outcome = await vision.describe(TARGET, BYTES, new AbortController().signal)
    expect(frames).toEqual([])
    expect(outcome).toMatchObject({ ok: true, desc: '季度营收折线图', via: 'direct' })
  })

  it('describes through the relay and attaches the cross-modal verdict', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    expect(vision.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: true,
      desc: '季度营收折线图，达到 50%',
    })).toBe(true)
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: true, via: 'desktop', thinkingIgnored: false })
    if (!outcome.ok) throw new Error('expected a description')
    // The page says 30%, the answer says 50%: the local check must catch it.
    expect(outcome.comparison.verdict).toBe('conflict')
    expect(outcome.comparison.conflicts[0]?.rule).toBe('percentage')
  })

  it('sends one request for a page that repeats the same image', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    const second = vision.describe(TARGET, BYTES, signal)
    await dispatched(frames)
    expect(frames).toHaveLength(1)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图' })
    await expect(first).resolves.toMatchObject({ ok: true, desc: '季度营收折线图' })
    await expect(second).resolves.toMatchObject({ ok: true, desc: '季度营收折线图' })
    expect(frames).toHaveLength(1)
  })

  it('runs no more recognitions at once than the limit allows', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, limit: 1 })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    const second = vision.describe({ ...TARGET, identity: 'b' }, BYTES, signal)
    await dispatched(frames)
    // The second waits for the slot rather than racing the desktop's own cap.
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(frames).toHaveLength(1)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: 'A' })
    await first
    await vi.waitFor(() => { expect(frames).toHaveLength(2) })
    vision.handleFrame({ t: 'image.result', id: callId(frames, 1), ok: true, desc: 'B' })
    await second
  })

  it('stops asking for an image the model declined', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    await dispatched(frames)
    vision.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: false,
      error: { code: 'vision-unclear', message: 'declined' },
    })
    await expect(first).resolves.toMatchObject({ ok: false, code: 'vision-unclear' })

    const second = await vision.describe(TARGET, BYTES, signal)
    expect(second).toMatchObject({ ok: false, code: 'vision-skipped', permanent: true })
    expect(frames).toHaveLength(1)
  })

  it('skips the cross-check on the low tier, and says so', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal, 'low')
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图，达到 50%' })
    const outcome = await pending
    if (!outcome.ok) throw new Error('expected a description')
    // The same answer is a conflict at the standard tier; the low tier buys
    // cheapness by not checking, and must say that rather than report agreement.
    expect(outcome.comparison).toEqual({ verdict: 'uncertain', conflicts: [], basis: 'skipped', overlap: 0 })
    expect(describeOutcomeText(12, outcome)).toContain('skipped by the low tier')
  })

  it('runs the cross-check at the standard tier', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal, 'standard')
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图，达到 50%' })
    const outcome = await pending
    if (!outcome.ok) throw new Error('expected a description')
    expect(outcome.comparison.verdict).toBe('conflict')
  })

  it('uses the direct path when the desktop cannot recognize images', async () => {
    // The relay is preferred whenever it can answer, so this path exists for the
    // deployments where it cannot — and it is unreachable unless the coordinator
    // is actually given the endpoint, which is what this asserts.
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张折线图' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const vision = new VisionCoordinator({
      cache: new ImageCache(),
      send: () => { throw new Error('the relay must not be used when it is unavailable') },
      canRelay: () => false,
      directConfig: () => ({ endpoint: 'https://api.test/v1/chat/completions', model: 'm', apiKey: 'k' }),
      pageText: () => '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(vision.canRecognize()).toBe(true)
    const outcome = await vision.describe(TARGET, BYTES, new AbortController().signal, 'standard')
    expect(outcome).toMatchObject({ ok: true, desc: '一张折线图', via: 'direct' })
    expect(urls[0]).toContain('api.test')
  })

  it('posts to chat/completions, the way the desktop client does', async () => {
    // Both transports read the same setting; reading it differently means a URL
    // that works on one path 404s on the other.
    expect(chatCompletionsUrl('https://api.test/v1')).toBe('https://api.test/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.test/v1/')).toBe('https://api.test/v1/chat/completions')
    // A user who pasted the full URL is not punished for it.
    expect(chatCompletionsUrl('https://api.test/v1/chat/completions')).toBe('https://api.test/v1/chat/completions')

    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张图' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(urls[0]).toBe('https://api.test/v1/chat/completions')
  })

  it('classifies a refused direct call as retryable, without blaming the policy', async () => {
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.example.com/v1/chat/completions', model: 'm', apiKey: 'k' }),
      (async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch,
    )
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toMatchObject({ ok: false, code: 'vision-failed', permanent: false })
    if (outcome.ok) throw new Error('expected a failure')
    // The endpoint host needs no manifest entry now that `connect-src` allows
    // `https:` and `http:`, so a failure here is the endpoint's rather than the
    // extension's. A CSP hint would advise about a rule that is gone.
    expect(outcome.message).toBe('Failed to fetch')
  })

  it('reports whether any path can answer', () => {
    expect(coordinator({ frames: [], relay: false }).canRecognize()).toBe(false)
    expect(coordinator({ frames: [], relay: true }).canRecognize()).toBe(true)
  })

  it('renders a remembered description for the snapshot', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '一台笔记本电脑' })
    await pending
    expect(vision.descriptionOf(TARGET.identity)).toBe('一台笔记本电脑')
    expect(vision.stats()).toMatchObject({ described: 1 })
  })
})

describe('marker summaries', () => {
  it('summarises a long description in a marker but answers with it whole', async () => {
    // A snapshot repeats every marker, so the page text carries a summary while
    // the description itself comes back whole from the call that asked for it.
    const long = '细节'.repeat(200)
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: long })
    const outcome = await pending
    expect(outcome.ok && outcome.desc).toBe(long)
    const marker = vision.stateFor(TARGET.identity) ?? ''
    expect(marker.length).toBeLessThanOrEqual(VISION_MARKER_CHARS + 1)
    expect(marker.endsWith('…')).toBe(true)
  })
})

describe('describeOutcomeText', () => {
  const consistent = { verdict: 'consistent' as const, conflicts: [], basis: 'text' as const, overlap: 0.8 }

  it('wraps the description in the untrusted boundary', () => {
    // The description is a model's reading of an image nobody here wrote, so it
    // travels inside the same boundary as page text.
    const text = describeOutcomeText(12, { ok: true, desc: '一张折线图', comparison: consistent, via: 'desktop', reasoningTokens: 0, thinkingIgnored: false })
    expect(text).toContain('<UNTRUSTED_PAGE_CONTENT')
    expect(text).toContain('一张折线图')
    expect(text).toContain('via desktop')
  })

  it('forbids acting on a conflicted description', () => {
    const text = describeOutcomeText(12, {
      ok: true,
      desc: '季度营收 50%',
      comparison: { verdict: 'conflict', conflicts: [{ rule: 'percentage', detail: 'description says 50% but the page states 30%' }], basis: 'text', overlap: 0.6 },
      via: 'desktop',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(text).toContain('CONFLICT')
    expect(text).toContain('description says 50% but the page states 30%')
    expect(text).toContain('Do not act')
  })

  it('says when nothing could be checked at all', () => {
    // Reporting "consistent" here would claim a verification that never ran.
    const unchecked = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: { verdict: 'uncertain', conflicts: [], basis: 'none', overlap: 0 },
      via: 'direct',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(unchecked).toContain('not possible, the page says nothing')
    const partial = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: { verdict: 'uncertain', conflicts: [], basis: 'text', overlap: 0.25 },
      via: 'direct',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(partial).toContain('nothing conclusive')

    // A note is reported as an observation, and never as a verdict to obey.
    const noted = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: {
        verdict: 'uncertain',
        conflicts: [],
        basis: 'text',
        overlap: 0.1,
        note: 'the description does not mention what the page says about this image (营收)',
      },
      via: 'desktop',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(noted).toContain('nothing conclusive — the description does not mention')
    expect(noted).not.toContain('CONFLICT')
    expect(noted).not.toContain('Do not act')
  })

  it('distinguishes a failure worth retrying from one that is not', () => {
    const permanent = describeOutcomeText(5, { ok: false, code: 'vision-unclear', message: 'declined', permanent: true })
    expect(permanent).toContain('will not be asked about again')
    const transient = describeOutcomeText(5, { ok: false, code: 'image-timeout', message: 'no answer', permanent: false })
    expect(transient).toContain('Trying again later may succeed')
  })

  it('surfaces a provider that billed thinking anyway, and a byte fallback', () => {
    const text = describeOutcomeText(7, {
      ok: true,
      desc: '一张图',
      comparison: consistent,
      via: 'direct',
      reasoningTokens: 348,
      thinkingIgnored: true,
    }, 'too-large')
    expect(text).toContain('348 reasoning tokens')
    expect(text).toContain('too-large')
  })
})

describe('ServerFrame routing', () => {
  it('leaves unrelated frames for the assembly', () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const toolCall: ServerFrame = { t: 'tool.call', id: 'x', name: 'browser_snapshot', args: {}, expiresAt: 0 }
    expect(vision.handleFrame(toolCall)).toBe(false)
  })
})
