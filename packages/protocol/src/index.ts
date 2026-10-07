/**
 * Wire contract between the bridge plugin and the browser extension.
 *
 * Zero-dependency module: the Node bridge and the browser bundle both import
 * this file, so frame shapes cannot drift between the two halves. One JSON
 * object per WebSocket message, discriminated by `t`. Correlation ids are
 * opaque strings minted by the requestor and echoed back.
 */

export const BRIDGE_PATH = '/ext/bridge'
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'
export const BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD = 'bridge.injectBrowserSnapshot'
export const BRIDGE_SESSION_PURGE_METHOD = 'bridge.session.purge'

// The prompt, body shape, and parser both recognizer paths share. Re-exported so
// the bridge and the extension import one module rather than two copies.
export * from './vision-contract.ts'

// The task-checklist contract the model is asked to emit, parsed by the panel.
// Shared so the wording the model is told and the shape the panel reads cannot
// drift apart.
export * from './plan.ts'

export const HELLO_TIMEOUT_MS = 5_000
export const PING_INTERVAL_MS = 30_000
export const DEFAULT_TOKEN_BYTES = 32
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** Error codes a tool call may settle with. Open set: consumers tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'

export interface ToolError {
  code: ToolErrorCode
  message: string
}

export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Capabilities negotiated in `hello`/`hello.ok`. */
export interface BridgeCaps {
  textOnly: true
  snapshotMaxChars: number
  maxInteractiveItems: number
}

/**
 * What the desktop app allows, as opposed to what the extension can do.
 * Capabilities come from the extension; policy comes from the plugin, where the
 * user's configuration lives. Keeping them apart stops a disabled switch from
 * being defeated by a stale local copy.
 */
export interface BridgePolicy {
  openPagesForUser: boolean
  /**
   * Directory the bridge groups browser conversations under.
   *
   * Sent so the extension can name the right workspace instead of guessing: the
   * 「工作区内」 mode mirrors every conversation in that group, and a wrong path would
   * mirror an unrelated one — or none at all. Absent in a deployment that opted out of
   * the grouping, which is exactly when the mode has nothing to mirror.
   */
  sessionWorkspacePath?: string
  /**
   * The desktop will recognize images on the extension's behalf.
   *
   * Absent means "no vision model configured here", not "unsupported": the
   * extension then keeps its own network path instead of relaying.
   */
  imageRecognition?: boolean
  /**
   * Why the desktop cannot recognize images, when it cannot.
   *
   * The desktop is the only side that knows: it holds the config and the
   * credentials. Without this the extension can only report that recognition is
   * unavailable, which leaves the user with a dead end and no next step.
   */
  imageRecognitionHint?: string
}

/** Page context sent with a recognition request, so the answer is about this image. */
export interface ImageRecognitionRequest {
  /** Manifest identity, echoed back so the extension can match request to result. */
  identity: string
  /** Author-provided text, when the page had any. */
  alt: string
  /** Text printed beside the image. */
  near: string
  /** Nearest heading: the section the image belongs to. */
  heading: string
  /** Manifest kind: content, icon, link, button, background, or canvas. */
  kind: string
  /**
   * How much the caller wants from the answer.
   *
   * Travels with the request because the desktop builds the same body the
   * extension does; a tier applied on one side only would change what the model is
   * asked depending on which transport happened to be free.
   *
   * Optional so a sender that predates tiers still produces a valid request: it
   * gets the base prompt rather than a refusal.
   */
  tier?: string
}

/**
 * Where the bytes come from.
 *
 * The extension is asked for bytes first because only it carries the user's login
 * state. `url` is the fallback for when the extension's own fetch is blocked by
 * its content-security policy, its host permissions, or an enterprise rule — the
 * desktop's network stack is not subject to those.
 */
export type ImageSource =
  | { kind: 'bytes'; mediaType: string; base64: string }
  | { kind: 'url'; url: string }

export type ClientFrame =
  | { t: 'hello'; token: string; caps: BridgeCaps }
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  | { t: 'image.call'; id: string; request: ImageRecognitionRequest; source: ImageSource }
  | { t: 'pong' }

export type ServerFrame =
  | { t: 'hello.ok'; caps: BridgeCaps; policy: BridgePolicy }
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  | { t: 'tool.cancel'; id: string }
  | { t: 'image.result'; id: string; ok: true; desc: string }
  | { t: 'image.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'ping' }
  | { t: 'error'; code: string; message: string }

export type BridgeFrame = ClientFrame | ServerFrame

export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'image.result'
    || frame.t === 'ping'
    || frame.t === 'error'
}

export function isClientFrame(frame: BridgeFrame): frame is ClientFrame {
  return frame.t === 'hello'
    || frame.t === 'rpc'
    || frame.t === 'respond'
    || frame.t === 'tool.result'
    || frame.t === 'image.call'
    || frame.t === 'pong'
}

/** Parse one WebSocket message into a frame, or `undefined` when it is not valid. */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string' && isCaps(frame.caps)
        ? { t: 'hello', token: frame.token, caps: frame.caps }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error as ToolError }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'image.call':
      return typeof frame.id === 'string' && isImageRequest(frame.request) && isImageSource(frame.source)
        ? { t: 'image.call', id: frame.id, request: frame.request, source: frame.source }
        : undefined
    case 'image.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true) {
        return typeof frame.desc === 'string' ? { t: 'image.result', id: frame.id, ok: true, desc: frame.desc } : undefined
      }
      return isError(frame.error) ? { t: 'image.result', id: frame.id, ok: false, error: frame.error } : undefined
    case 'hello.ok':
      return isCaps(frame.caps) && isPolicy(frame.policy)
        ? { t: 'hello.ok', caps: frame.caps, policy: frame.policy }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return isRecord(frame.frame)
        ? { t: 'event', frame: frame.frame as { rpcId: string; method: string; payload: unknown } }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string'
        && typeof frame.name === 'string'
        && isRecord(frame.args)
        && typeof frame.expiresAt === 'number'
        && Number.isFinite(frame.expiresAt)
        && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

export function isPolicy(value: unknown): value is BridgePolicy {
  // A missing field is rejected rather than defaulted: `false` and "dropped in
  // transit" must not look the same. `imageRecognition` is the exception — it is
  // absent when the desktop has no vision model, which is a supported state.
  return isRecord(value)
    && typeof value.openPagesForUser === 'boolean'
    && (value.imageRecognition === undefined || typeof value.imageRecognition === 'boolean')
    && (value.imageRecognitionHint === undefined || typeof value.imageRecognitionHint === 'string')
    && (value.sessionWorkspacePath === undefined || typeof value.sessionWorkspacePath === 'string')
}

function isImageRequest(value: unknown): value is ImageRecognitionRequest {
  return isRecord(value)
    && typeof value.identity === 'string'
    && typeof value.alt === 'string'
    && typeof value.near === 'string'
    && typeof value.heading === 'string'
    && typeof value.kind === 'string'
}

function isImageSource(value: unknown): value is ImageSource {
  if (!isRecord(value)) return false
  if (value.kind === 'url') return typeof value.url === 'string' && value.url !== ''
  return value.kind === 'bytes' && typeof value.mediaType === 'string' && typeof value.base64 === 'string' && value.base64 !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isError(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

function isCaps(value: unknown): value is BridgeCaps {
  return isRecord(value)
    && value.textOnly === true
    && typeof value.snapshotMaxChars === 'number'
    && Number.isInteger(value.snapshotMaxChars)
    && value.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof value.maxInteractiveItems === 'number'
    && value.maxInteractiveItems > 0
}

function isRespondResult(value: unknown): value is RespondResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return value.error === undefined
  if (value.ok !== false) return false
  const error = value.error
  return isError(error) && isRecord((error as Record<string, unknown>).details)
}
