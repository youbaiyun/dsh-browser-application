/**
 * Serving the extension's image-recognition requests on the desktop side.
 *
 * The extension is asked for bytes first because only it carries the user's login
 * state; when it could not fetch at all — its content-security policy, a host
 * permission, or an enterprise rule — it sends the URL and the desktop tries with
 * its own network stack instead. The two paths are complementary rather than
 * redundant, which is why the frame carries a source rather than always one kind.
 *
 * The desktop has no image codec, so bytes it fetches itself are passed through
 * unchanged once they are known to be an image and to be a sane size. Anything
 * the extension already normalized arrives pre-scaled.
 *
 * @module
 */

import type { ImageRecognitionRequest, ImageSource } from '@dsh-browser/protocol'
import type { VisionClient } from './vision.ts'

export type ImageRelayResult =
  | { ok: true; desc: string }
  | { ok: false; code: string; message: string }

/** Cap on bytes the desktop will pull from the network for one image. */
const MAX_RELAY_BYTES = 12_000_000
const RELAY_TIMEOUT_MS = 15_000

export class ImageRelay {
  private readonly vision: VisionClient | undefined
  private readonly fetchImpl: typeof fetch

  constructor(vision: VisionClient | undefined, fetchImpl: typeof fetch = fetch) {
    this.vision = vision
    this.fetchImpl = fetchImpl
  }

  /** Whether a vision model is configured, which is what `hello.ok` advertises. */
  get available(): boolean {
    return this.vision !== undefined
  }

  /**
   * Recognize one image for the extension.
   *
   * @param request - the page context the extension gathered.
   * @param source - normalized bytes, or a URL for the desktop to fetch.
   * @returns a one-line description, or a classified failure.
   */
  async recognize(request: ImageRecognitionRequest, source: ImageSource): Promise<ImageRelayResult> {
    const vision = this.vision
    if (vision === undefined) {
      return { ok: false, code: 'no-vision', message: 'no vision model is configured on the desktop' }
    }

    let bytes: { base64: string; mediaType: string }
    if (source.kind === 'bytes') {
      if (source.base64.length > MAX_RELAY_BYTES) {
        return { ok: false, code: 'too-large', message: `${String(source.base64.length)} base64 characters` }
      }
      bytes = { base64: source.base64, mediaType: source.mediaType }
    } else {
      const fetched = await this.fetchByUrl(source.url)
      if (!fetched.ok) return fetched
      bytes = fetched
    }

    const result = await vision.describe({
      base64: bytes.base64,
      mediaType: bytes.mediaType,
      context: {
        alt: request.alt,
        near: request.near,
        heading: request.heading,
        kind: request.kind,
        // The tier travels with the request so the relayed call asks exactly what
        // the extension's own call would have asked. Omitted rather than set to
        // undefined, which `exactOptionalPropertyTypes` rejects.
        ...request.tier === undefined ? {} : { tier: request.tier },
      },
    })
    return result.ok
      ? { ok: true, desc: result.desc }
      : { ok: false, code: result.code, message: result.message }
  }

  /** The desktop's own attempt, for when the extension's fetch did not work. */
  private async fetchByUrl(
    url: string,
  ): Promise<{ ok: true; base64: string; mediaType: string } | { ok: false; code: string; message: string }> {
    if (!/^https?:/i.test(url)) return { ok: false, code: 'bad-url', message: `unsupported scheme: ${url.slice(0, 40)}` }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      return { ok: false, code: 'relay-network', message: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { ok: false, code: 'relay-http', message: String(response.status) }

    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!mediaType.startsWith('image/')) {
      return { ok: false, code: 'not-an-image', message: mediaType === '' ? 'no content-type' : mediaType }
    }

    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch (error: unknown) {
      return { ok: false, code: 'relay-network', message: error instanceof Error ? error.message : String(error) }
    }
    if (buffer.byteLength > MAX_RELAY_BYTES) {
      return { ok: false, code: 'too-large', message: String(buffer.byteLength) }
    }
    return { ok: true, base64: Buffer.from(buffer).toString('base64'), mediaType }
  }
}
