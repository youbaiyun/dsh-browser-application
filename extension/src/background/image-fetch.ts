/**
 * Getting an image's bytes, from the extension side.
 *
 * The extension is asked first because it is the only party carrying the user's
 * login state: a product photo behind a session, an avatar in a private feed and
 * a chart on an authenticated dashboard are all readable here and refused to
 * anyone else. `host_permissions` already covers `http(s)://*`, so this is a
 * plain `fetch` rather than a tab-scoped read.
 *
 * Nothing here decodes, resizes or recognises: it returns bytes or says exactly
 * why it could not. A failure is a value, never a silent skip — an image the
 * model was told about and then never hears about again is worse than one it was
 * told could not be read.
 *
 * @module
 */

import type { ImageSource } from '@dsh-browser/protocol'

/** Image bytes ready to travel as a `bytes` image source. */
export interface ImageBytes {
  mediaType: string
  base64: string
}

/** Why the bytes are unavailable. */
export type ImageFetchCode =
  /** The response (or the data URL) is larger than the transport budget. */
  | 'too-large'
  /** A URL scheme this context cannot read (for example a page-created `blob:`). */
  | 'unsupported-url'
  /** The request failed: network, CORS, CSP, or a non-2xx status. */
  | 'fetch-failed'
  /** The request succeeded but returned no bytes. */
  | 'empty'

/** Failure value: a code for the caller to classify, and a message to report. */
export interface ImageFetchFailure {
  code: ImageFetchCode
  message: string
  /**
   * True when retrying the same URL cannot succeed in this session: a scheme
   * this context cannot read, or a body over the budget. Callers use it to stop
   * re-asking for a permanently unavailable image.
   */
  permanent: boolean
}

export type ImageFetchResult = { bytes: ImageBytes } | { failure: ImageFetchFailure }

/**
 * Largest image body to carry inline.
 *
 * Base64 inflates by a third and the whole payload is copied through the
 * WebSocket, so a larger body costs memory on three sides for no extra answer
 * quality: recognition downsizes to roughly 800–1024px anyway. Over this, the
 * caller falls back to sending the URL and letting the desktop fetch it.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Media type by file extension, for servers that omit `Content-Type`. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/**
 * Base64 of a binary buffer.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte into one
 * call and a multi-megabyte image overflows the argument list — the failure
 * looks like a stack overflow, not a size problem, so it is worth avoiding by
 * construction.
 *
 * @param buffer - raw bytes.
 * @returns standard base64 without line breaks.
 */
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * Best media type for a response.
 *
 * @param header - the `Content-Type` header, when present.
 * @param url - the URL the bytes came from, used as the fallback signal.
 * @returns a media type; `application/octet-stream` when nothing identifies it.
 */
export function mediaTypeOf(header: string | null, url: string): string {
  const declared = header?.split(';')[0]?.trim() ?? ''
  if (declared !== '' && declared !== 'application/octet-stream') return declared
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

/** Bytes of a `data:` URL, decoded locally. */
function dataUrlBytes(url: string): ImageFetchResult {
  const comma = url.indexOf(',')
  if (comma < 0) {
    return { failure: { code: 'unsupported-url', message: 'malformed data URL', permanent: true } }
  }
  const header = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  const declared = header.split(';')[0] ?? ''
  const mediaType = declared === '' ? 'text/plain' : declared
  if (!header.includes(';base64')) {
    // Percent-encoded payloads are rare for images and would need decoding rules
    // of their own; refuse rather than guess at the bytes.
    return { failure: { code: 'unsupported-url', message: 'non-base64 data URL', permanent: true } }
  }
  if (payload.length === 0) {
    return { failure: { code: 'empty', message: 'data URL carried no bytes', permanent: false } }
  }
  // 4 base64 characters carry 3 bytes; the decoded size is what the budget bounds.
  if (Math.floor(payload.length * 3 / 4) > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: 'data URL is over the image budget', permanent: true } }
  }
  return { bytes: { mediaType, base64: payload } }
}

/** What to send for one image, and why its bytes are missing when they are. */
export interface ChosenImageSource {
  /** The source to describe with, or `undefined` when there is nothing to send. */
  source: ImageSource | undefined
  /** The fetch's failure code, when bytes were attempted and refused. */
  byteFailure: string | undefined
}

/**
 * Decide what to send for one image.
 *
 * The ordering is the point, and it was once wrong. Fetching the bytes first and
 * consulting the cache second cost a real download on every repeated question
 * about an image that had already been described — invisible while the manifest
 * refused every non-loopback host, because the fetch failed instantly, and a
 * ~0.06–0.19s download once it did not. So the caller states whether the answer is
 * already known, and the bytes are fetched only when they will actually be used.
 *
 * @param url - the image's address, or `''` when the page gave none.
 * @param alreadyAnswered - true when this identity is already described.
 * @param fetchBytes - the fetch to use, injectable for tests.
 * @returns the source to send plus any byte failure worth reporting.
 */
export async function chooseImageSource(
  url: string,
  alreadyAnswered: boolean,
  fetchBytes: (url: string) => Promise<ImageFetchResult> = fetchImageBytes,
): Promise<ChosenImageSource> {
  // A cache hit needs a source object, not its contents: the coordinator answers
  // from the cache before it looks at what it was handed.
  if (alreadyAnswered) {
    return { source: url === '' ? undefined : { kind: 'url', url }, byteFailure: undefined }
  }
  if (url === '') return { source: undefined, byteFailure: undefined }
  const fetched = await fetchBytes(url)
  if ('bytes' in fetched) {
    return {
      source: { kind: 'bytes', mediaType: fetched.bytes.mediaType, base64: fetched.bytes.base64 },
      byteFailure: undefined,
    }
  }
  return { source: { kind: 'url', url }, byteFailure: fetched.failure.code }
}

/**
 * Fetch one image's bytes.
 *
 * @param url - absolute image URL (`http:`, `https:`, or `data:`).
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns bytes, or a classified failure.
 */
export async function fetchImageBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageFetchResult> {
  if (url === '') {
    return { failure: { code: 'unsupported-url', message: 'image has no address', permanent: true } }
  }
  if (url.startsWith('data:')) return dataUrlBytes(url)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // `blob:` URLs are readable only from the context that created them, which
    // is the page, not this worker. Reporting the scheme keeps the failure
    // legible instead of looking like a network error.
    const scheme = url.slice(0, url.indexOf(':') + 1)
    return {
      failure: { code: 'unsupported-url', message: `cannot read ${scheme} URLs from the worker`, permanent: true },
    }
  }

  let response: Response
  try {
    // `include` is the point of fetching here rather than on the desktop: the
    // request carries the user's cookies for hosts they are signed in to.
    response = await fetchImpl(url, { credentials: 'include', redirect: 'follow' })
  } catch (error) {
    return {
      failure: { code: 'fetch-failed', message: error instanceof Error ? error.message : String(error), permanent: false },
    }
  }
  if (!response.ok) {
    return {
      failure: { code: 'fetch-failed', message: `HTTP ${String(response.status)}`, permanent: false },
    }
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: `${String(declaredLength)} bytes declared`, permanent: true } }
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength === 0) {
    return { failure: { code: 'empty', message: 'response body was empty', permanent: false } }
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: `${String(buffer.byteLength)} bytes`, permanent: true } }
  }
  return {
    bytes: {
      mediaType: mediaTypeOf(response.headers.get('content-type'), url),
      base64: base64Of(buffer),
    },
  }
}
