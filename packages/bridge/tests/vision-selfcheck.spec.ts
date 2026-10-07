import { describe, expect, it, vi } from 'vitest'
import { checkThinkingIsOff } from '../src/vision-selfcheck.ts'
import { PROBE_IMAGE_BASE64, VisionClient, type VisionConfig } from '../src/vision.ts'
import { MAX_DESC_CHARS, THINKING_OFF, reasoningTokensOf } from '@dsh-browser/protocol'

function config(): VisionConfig {
  return {
    baseUrl: 'https://api.test/v1',
    apiKey: 'secret',
    model: 'deepseek-v4.1-flash',
    timeoutMs: 1_000,
    extraBody: THINKING_OFF,
  }
}

function usageResponse(usage: Record<string, unknown> | undefined): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'x' } }], ...(usage === undefined ? {} : { usage }) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function probeWith(respond: () => Response): Promise<ReturnType<VisionClient['probe']>> {
  const client = new VisionClient(config(), (async () => respond()) as unknown as typeof fetch)
  return await client.probe()
}

describe('thinking self-check', () => {
  it('reads reasoning tokens from either shape a provider uses', () => {
    expect(reasoningTokensOf(undefined)).toBe(0)
    expect(reasoningTokensOf({})).toBe(0)
    expect(reasoningTokensOf({ reasoning_tokens: 40 })).toBe(40)
    expect(reasoningTokensOf({ completion_tokens_details: { reasoning_tokens: 12 } })).toBe(12)
    expect(reasoningTokensOf({ reasoning_tokens: 'many' })).toBe(0)
  })

  it('sends the smallest possible image so the check costs almost nothing', async () => {
    const bodies: Record<string, unknown>[] = []
    const client = new VisionClient(config(), (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return usageResponse({ completion_tokens: 3 })
    }) as unknown as typeof fetch)

    await client.probe()

    expect(JSON.stringify(bodies[0])).toContain(PROBE_IMAGE_BASE64)
    expect(bodies[0]?.max_tokens).toBe(MAX_DESC_CHARS)
    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
  })

  it('reports reasoning tokens that came back despite the switch being off', async () => {
    const probe = await probeWith(() => usageResponse({ completion_tokens_details: { reasoning_tokens: 348 } }))

    expect(probe).toEqual({ ok: true, reasoningTokens: 348, message: 'ok' })
  })

  it('reports zero when the provider billed none', async () => {
    const probe = await probeWith(() => usageResponse({ prompt_tokens: 400, completion_tokens: 8 }))

    expect(probe.ok).toBe(true)
    expect(probe.reasoningTokens).toBe(0)
  })

  it('reports a provider that does not answer at all', async () => {
    const probe = await probeWith(() => new Response('nope', { status: 401 }))

    expect(probe.ok).toBe(false)
    expect(probe.message).toContain('401')
  })

  it('warns when the switch was ignored', async () => {
    const warn = vi.fn()
    const client = new VisionClient(config(), (async () => usageResponse({ reasoning_tokens: 512 })) as unknown as typeof fetch)

    checkThinkingIsOff(client, warn)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })

    expect(String(warn.mock.calls[0]?.[0])).toContain('512 reasoning tokens')
    expect(String(warn.mock.calls[0]?.[0])).toContain('visionThinking is "off"')
  })

  it('stays quiet when the switch was honoured', async () => {
    const warn = vi.fn()
    const client = new VisionClient(config(), (async () => usageResponse({ completion_tokens: 8 })) as unknown as typeof fetch)

    checkThinkingIsOff(client, warn)
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    expect(warn).not.toHaveBeenCalled()
  })

  it('says the switch is unverified rather than silent when the probe cannot run', async () => {
    const warn = vi.fn()
    const client = new VisionClient(config(), (async () => { throw new Error('offline') }) as unknown as typeof fetch)

    checkThinkingIsOff(client, warn)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })

    expect(String(warn.mock.calls[0]?.[0])).toContain('unverified')
  })

  it('never lets a broken probe break startup', async () => {
    const warn = vi.fn()
    const exploding = { probe: () => Promise.reject(new Error('boom')) } as unknown as VisionClient

    expect(() => { checkThinkingIsOff(exploding, warn) }).not.toThrow()
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    expect(warn).not.toHaveBeenCalled()
  })
})
