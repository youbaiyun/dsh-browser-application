/**
 * Structural subset of the dsh Host services the bridge adapts to: the
 * TypertGateway wire seam, the Connection fetch handler, and the version-aware
 * wire-stream opener.
 *
 * @module dsh-browser-crossplatform/src/dsh-gateway
 */

import type { HostRpcFailure } from './host-api.ts'

/** Structural subset of dsh 0.2's Host TypertGateway service. */
export interface TypertGatewayLike {
  readonly wireStream: {
    /**
     * dsh 0.2: `(endpoint, payload, uplink, peer, signal)`.
     * Legacy stubs/tests: `(endpoint, payload, signal)`.
     */
    open(
      endpoint: string,
      payload: unknown,
      uplinkOrSignal: AsyncIterable<unknown> | AbortSignal,
      peer?: unknown,
      signal?: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
    failure(error: unknown): HostRpcFailure
  }
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/**
 * Empty Clientâ†’Host uplink for in-process Host wireStream.open calls.
 * dsh 0.2 requires the uplink slot; Gateway-owned endpoints ($events) discard
 * it immediately, and Remote streams still need a valid AsyncIterable.
 */
const EMPTY_WIRE_UPLINK: AsyncIterable<unknown> = {
  async *[Symbol.asyncIterator]() { /* no uplink items */ },
}

/**
 * Open a Host wire stream against either dsh 0.2 or the legacy three-arg form.
 *
 * - arity 3: composition/unit stubs still use `(endpoint, payload, signal)`.
 * - arity 5: real dsh 0.2 TypertGatewayWireStream.
 * - arity 0: Cordis/service wrappers â€” must use the five-arg call. Treating
 *   these as three-arg maps AbortSignal onto uplink and leaves signal
 *   undefined (hello.ok â†’ stream-failed â†’ WS 1011).
 */
export function openWireStream(gateway: TypertGatewayLike, endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const open = gateway.wireStream.open
  if (open.length === 3) {
    return open(endpoint, payload, signal)
  }
  return open(endpoint, payload, EMPTY_WIRE_UPLINK, undefined, signal)
}

/** Structural subset of dsh 0.2's Host Connection service. */
export interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): {
    fetch(request: Request): Promise<Response>
  }
}
