import { describe, expect, it } from 'vitest'
import { THINKING_LOW, THINKING_OFF } from '@dsh-browser/protocol'
import { VisionClient, type VisionConfig } from '../src/vision.ts'

function config(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    baseUrl: 'https://api.test/v1',
    apiKey: 'secret',
    model: 'deepseek-v4.1-flash',
    timeoutMs: 1_000,
    extraBody: THINKING_OFF,
    ...overrides,
  }
}

function completion(content: unknown, usage?: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

interface Capture {
  url: string
  body: Record<string, unknown>
}

function stubFetch(capture: Capture[], respond: () => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return await respond()
  }) as unknown as typeof fetch
}

const CONTEXT = { alt: '', near: '精灵手办 ￥299', heading: '商品详情', kind: 'content' }

describe('vision client', () => {
  it('posts the image as a data URL with the page context', async () => {
    const capture: Capture[] = []
    const client = new VisionClient(config(), stubFetch(capture, () => completion('白色头发的精灵')))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/webp', context: CONTEXT })

    expect(result).toEqual({ ok: true, desc: '白色头发的精灵' })
    expect(capture[0]?.url).toBe('https://api.test/v1/chat/completions')
    expect(capture[0]?.body.model).toBe('deepseek-v4.1-flash')
    const content = JSON.stringify((capture[0]?.body.messages as unknown[])[1])
    expect(content).toContain('data:image/webp;base64,AAAA')
    expect(content).toContain('精灵手办')
    expect(content).toContain('商品详情')
  })

  it('carries the thinking switch in the body so the provider can be told not to reason', async () => {
    const capture: Capture[] = []
    const client = new VisionClient(config(), stubFetch(capture, () => completion('x')))

    await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(capture[0]?.body.thinking).toEqual({ type: 'disabled' })
    expect(capture[0]?.body.reasoning_effort).toBe('none')
    expect(capture[0]?.body.temperature).toBe(0)
  })

  it('a low-thinking deployment sends its own switch', async () => {
    const capture: Capture[] = []
    const client = new VisionClient(config({ extraBody: THINKING_LOW }), stubFetch(capture, () => completion('x')))

    await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(capture[0]?.body.reasoning_effort).toBe('low')
  })

  it('reads usage back so a silently ignored thinking switch is visible', async () => {
    const usage = { prompt_tokens: 400, completion_tokens: 12 }
    const client = new VisionClient(config(), stubFetch([], () => completion('x', usage)))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok && result.usage).toEqual(usage)
  })

  it('treats an explicit decline as a failure rather than a description', async () => {
    const client = new VisionClient(config(), stubFetch([], () => completion('UNCLEAR')))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('vision-unclear')
  })

  it('accepts content delivered as typed parts', async () => {
    const client = new VisionClient(config(), stubFetch([], () => completion([{ type: 'text', text: '一只绿色的鸟' }])))

    expect(await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })).toEqual({ ok: true, desc: '一只绿色的鸟' })
  })

  it('collapses the answer to one bounded line with no quotes to forge structure with', async () => {
    const client = new VisionClient(config(), stubFetch([], () => completion('line one\nline two "quoted"')))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok && result.desc).toBe('line one line two quoted')
    expect(result.ok && result.desc.includes('\n')).toBe(false)
  })

  it('reports an http failure with its status', async () => {
    const client = new VisionClient(config(), stubFetch([], () => new Response('rate limited', { status: 429 })))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('vision-http')
    expect(result.ok === false && result.message).toContain('429')
  })

  it('reports a network failure instead of throwing', async () => {
    const client = new VisionClient(config(), (async () => { throw new Error('offline') }) as unknown as typeof fetch)

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('vision-network')
  })

  it('refuses a response with no completion content', async () => {
    const client = new VisionClient(config(), stubFetch([], () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))

    const result = await client.describe({ base64: 'AAAA', mediaType: 'image/png', context: CONTEXT })

    expect(result.ok === false && result.code).toBe('vision-bad-response')
  })
})
