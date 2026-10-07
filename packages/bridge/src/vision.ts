/**
 * The multimodal call the desktop makes on the extension's behalf.
 *
 * Only the desktop can hold the model credential without putting it in a browser
 * profile, and only the desktop can reach the network through the machine's own
 * proxy, VPN, or client certificate. This module is the transport: the prompt,
 * the request body, and the response parser are shared with the extension's own
 * outbound path, so "which side calls the model" changes nothing about what is
 * asked or what counts as an answer.
 *
 * @module
 */

import {
  buildVisionRequestBody,
  parseVisionResponse,
  reasoningTokensOf,
  type VisionCallConfig,
  type VisionCallContext,
  type VisionCallImage,
  type VisionCallResult,
} from '@dsh-browser/protocol'

export type { VisionCallContext, VisionCallResult }

/** A 1×1 transparent PNG: the smallest thing a vision endpoint will accept. */
export const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** What a probe learned about the deployment's cost controls. */
export interface VisionProbe {
  ok: boolean
  /** Reasoning tokens the response reported; 0 when none or unreported. */
  reasoningTokens: number
  message: string
}

export interface VisionConfig extends VisionCallConfig {
  /** Chat-completions base URL. */
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export interface VisionRequest extends VisionCallImage {
  context: VisionCallContext
}

export type VisionResult = VisionCallResult

export class VisionClient {
  private readonly config: VisionConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: VisionConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  /**
   * Describe one image.
   *
   * @param request - normalized bytes plus the page context around them.
   * @returns one line of description, or a classified failure.
   */
  async describe(request: VisionRequest): Promise<VisionResult> {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildVisionRequestBody(this.config, request, request.context)),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      return { ok: false, code: 'vision-network', message: error instanceof Error ? error.message : String(error) }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, code: 'vision-http', message: `${String(response.status)} ${detail.slice(0, 200)}` }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      return { ok: false, code: 'vision-bad-response', message: error instanceof Error ? error.message : String(error) }
    }
    return parseVisionResponse(payload)
  }

  /**
   * Send one minimal request and read the billing back.
   *
   * A thinking switch can be ignored silently — the request succeeds and the
   * answer looks fine, while every image costs several times what it should. The
   * only way to know is to look at `usage`, so this sends the smallest possible
   * image once and reports what came back.
   *
   * @returns what the provider reported, or why the probe could not run.
   */
  async probe(): Promise<VisionProbe> {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildVisionRequestBody(
          this.config,
          { base64: PROBE_IMAGE_BASE64, mediaType: 'image/png' },
          { alt: '', near: '', heading: '', kind: 'icon' },
        )),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      return { ok: false, reasoningTokens: 0, message: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { ok: false, reasoningTokens: 0, message: `HTTP ${String(response.status)}` }
    try {
      const payload = await response.json() as { usage?: Record<string, unknown> }
      return { ok: true, reasoningTokens: reasoningTokensOf(payload.usage), message: 'ok' }
    } catch (error: unknown) {
      return { ok: false, reasoningTokens: 0, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
