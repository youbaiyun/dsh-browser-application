/**
 * Gateway RPC client: maps `rpc`/`rpc.result` frames to promises keyed by
 * correlation id, with a 30s timeout. One instance per bridge generation.
 *
 * The bridge answers a `rpc` frame with its stable ServerResponse envelope
 * (`{ type, rpcId, result: { ok, value | error } }`), so this facade hands the
 * caller the business `value` and turns a business failure into an Error
 * carrying the gateway's own message. Anything else the socket delivers is
 * passed straight to the sink installed before this facade wrapped it.
 *
 * @module
 */

import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeClient } from './bridge.ts'

const RPC_TIMEOUT_MS = 30_000

interface PendingRpc {
  resolve(result: unknown): void
  reject(error: Error): void
  /** Kept only to name the call in a timeout or a malformed-reply error. */
  method: string
  timer: ReturnType<typeof setTimeout>
}

/** One gateway business reply: `{ ok: true, value }` or `{ ok: false, error }`. */
interface ServerResponse {
  ok: boolean
  value?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** Unary gateway calls over one live bridge socket. */
export interface RpcFacade {
  /** Dispatch one unary gateway RPC and resolve with its business value. */
  request(method: string, payload: unknown): Promise<unknown>
  /** Reject every call still awaiting an answer, such as after the socket drops. */
  fail(reason: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the gateway's business envelope out of a successful `rpc.result`.
 *
 * Bridge-internal methods answer with a bare object (`{ accepted: true }`)
 * instead, so an unrecognized reply is returned verbatim rather than unwrapped
 * into `undefined`.
 */
function serverResponse(result: unknown): ServerResponse | undefined {
  if (!isRecord(result)) return undefined
  const business = result.result
  if (!isRecord(business) || typeof business.ok !== 'boolean') return undefined
  return {
    ok: business.ok,
    ...('value' in business ? { value: business.value } : {}),
    ...(isRecord(business.error) ? { error: business.error } : {}),
  }
}

/** Name a business failure the way the gateway wrote it, never as a wrapper object. */
function businessFailure(business: ServerResponse, method: string): Error {
  const message = typeof business.error?.message === 'string' ? business.error.message.trim() : ''
  if (message !== '') return new Error(message)
  const code = typeof business.error?.code === 'string' ? business.error.code : 'rpc-failed'
  return new Error(`The dsh gateway rejected ${method} (${code}).`)
}

/**
 * Create an RPC facade over a live bridge.
 *
 * Wraps the bridge's frame sink so other handlers keep working; settles
 * `rpc.result` frames by correlation id.
 * @param bridge - the bridge client this facade belongs to.
 * @returns the facade: `request` for unary calls, `fail` for a dead socket.
 */
export function createRpc(bridge: BridgeClient): RpcFacade {
  const pending = new Map<string, PendingRpc>()

  const previous = bridge.sinks.onFrame
  bridge.sinks.onFrame = (frame: ServerFrame): void => {
    previous?.(frame)
    if (frame.t !== 'rpc.result') return
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (!frame.ok) {
      // A transport-level rejection: the code is the only stable identity here.
      entry.reject(new Error(`${frame.error.code}: ${frame.error.message}`))
      return
    }
    const business = serverResponse(frame.result)
    if (business === undefined) {
      entry.resolve(frame.result)
      return
    }
    if (!business.ok) {
      entry.reject(businessFailure(business, entry.method))
      return
    }
    entry.resolve(business.value)
  }

  return {
    request(method: string, payload: unknown): Promise<unknown> {
      if (!bridge.connected) {
        // Callers normally check first and raise a localized message; this guard
        // keeps a socket that died between the check and the send from hanging.
        return Promise.reject(new Error('The dsh bridge is not connected.'))
      }
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The dsh gateway did not answer ${method} within ${RPC_TIMEOUT_MS / 1_000}s.`))
        }, RPC_TIMEOUT_MS)
        pending.set(id, { resolve, reject, method, timer })
        if (bridge.send({ t: 'rpc', id, method, payload })) return
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`The dsh bridge socket closed before ${method} was sent.`))
      })
    },
    fail(reason: string): void {
      for (const [id, entry] of pending) {
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
    },
  }
}
