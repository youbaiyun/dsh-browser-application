/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * authenticates with the bearer token, keeps the connection alive with
 * exponential-backoff reconnects, and answers protocol pings.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×.
 *
 * @module
 */

import type { BridgeCaps, BridgePolicy, ClientFrame, ServerFrame } from '@dsh-browser/protocol'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  isServerFrame,
  parseBridgeFrame,
} from '@dsh-browser/protocol'

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps, policy: BridgePolicy): void
}

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

/**
 * Re-resolve the bridge URL after the current one has gone quiet.
 *
 * The desktop app chooses its port at startup, so a restart can land somewhere
 * else. The retry loop alone cannot recover from that: it probes one URL
 * forever, and the keepalive skips a `reconnecting` client on purpose. Returning
 * the same string means "nothing changed", and the loop keeps backing off.
 */
type BridgeDiscovery = () => Promise<string | undefined>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const HELLO_ACK_TIMEOUT_MS = 5_000

/**
 * Consecutive failed probes before asking for a fresh URL.
 *
 * Three failures is roughly 1.5s of backoff, which is long enough that a normal
 * restart (where the port comes back) never reaches it, and short enough that a
 * moved port is found without a manual panel reload.
 */
const REDISCOVER_AFTER_FAILURES = 3

/**
 * Owns one WebSocket connection generation and the reconnect loop.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** Per-start generation token: a new start() invalidates any in-flight loop. */
  private generation = 0
  private url = ''
  private token = ''
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Set when the bridge evicted this client to hand the single slot to another
   * browser (close code 4000). The retry loop must then stay quiet: two open
   * profiles that both reconnect would evict each other forever. Only an
   * explicit start() may claim the slot again.
   */
  private replaced = false
  /** Consecutive failed probes, reset by any successful one. */
  private probeFailures = 0

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether a disconnected client still has an active user-owned lease. */
    private readonly shouldReconnect: () => boolean = () => true,
    /**
     * Re-resolve the bridge URL once the current one looks permanently gone.
     * Absent means "the address never changes", which is correct for a
     * manually-entered address.
     */
    private readonly rediscover: BridgeDiscovery | undefined = undefined,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - bearer token from settings.
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.replaced = false
    this.generation += 1
    void this.loop(this.generation)
  }

  /** Stop the loop and close the current socket. */
  stop(): void {
    this.running = false
    this.clearAckTimer()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /**
   * Drop an in-progress reconnect when its UI lease disappears, while keeping
   * an authenticated socket alive for background approvals already enabled by
   * the user. A later socket loss will still consult shouldReconnect().
   */
  suspendReconnect(): void {
    if (this.state === 'connected') return
    this.stop()
  }

  /** Whether a frame can be sent right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Whether this client gave up its slot to another browser.
   *
   * The extension's keepalive reads this instead of guessing from `state`: a
   * replacement also ends in `stopped`, but restarting it there would evict the
   * browser that just took the connection.
   */
  get wasReplaced(): boolean {
    return this.replaced
  }

  /**
   * Send one client frame.
   * @param frame - frame to send.
   * @returns false when no live socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  /**
   * Ask the background to re-resolve the bridge address.
   * @returns true when the address actually changed and the target moved.
   */
  private async resolveMovedUrl(): Promise<boolean> {
    if (this.rediscover === undefined) return false
    const found = await this.rediscover().catch(() => undefined)
    if (found === undefined || found === '' || found === this.url) return false
    this.url = found
    return true
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      if (!this.retryAllowed()) return
      // A replaced client never dials again on its own; retryAllowed() already
      // dropped `running`, so this only documents the handoff for readers.
      if (this.replaced) return
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!this.retryAllowed()) return
      if (!reachable) {
        this.emitState('reconnecting')
        this.probeFailures += 1
        if (this.probeFailures >= REDISCOVER_AFTER_FAILURES) {
          // The address may have moved with the desktop app. Ask once per
          // threshold so a still-down bridge is not probed on every retry.
          this.probeFailures = 0
          const moved = await this.resolveMovedUrl()
          if (!this.running || generation !== this.generation) return
          if (!this.retryAllowed()) return
          // A moved address is a new target, so the backoff starts over rather
          // than inheriting the delay built up against the dead one.
          if (moved) { this.attempt = 0; continue }
        }
        await this.waitBeforeRetry()
        continue
      }
      this.probeFailures = 0

      const socket = new WebSocket(this.url)
      this.ws = socket
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        if (event.code !== 4000 || this.ws !== socket || !this.running) return
        this.running = false
        this.replaced = true
        this.clearAckTimer()
        this.ws = null
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      // Authenticate: hello must be accepted before any other traffic.
      socket.send(JSON.stringify({
        t: 'hello',
        token: this.token,
        caps: { textOnly: true, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 },
      } satisfies ClientFrame))

      let authed = false
      const accepted = await new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = parseBridgeFrame(String(event.data))
          if (frame === undefined) return
          if (!authed) {
            if (frame.t === 'hello.ok') {
              authed = true
              this.clearAckTimer()
              resolve(true)
              this.sinks.onHelloOk(frame.caps, frame.policy)
            } else if (frame.t === 'error' || frame.t === 'rpc.result' || frame.t === 'event') {
              this.sinks.onFrame(frame)
            }
            return
          }
          if (frame.t === 'ping') {
            socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
            return
          }
          if (isServerFrame(frame)) this.sinks.onFrame(frame)
        }
        socket.addEventListener('message', onMessage)
        socket.addEventListener('close', () => {
          this.clearAckTimer()
          resolve(false)
        }, { once: true })
        this.ackTimer = setTimeout(() => resolve(false), HELLO_ACK_TIMEOUT_MS)
      })
      if (!accepted || !this.running || generation !== this.generation) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.emitState('connected')

      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true })
        socket.addEventListener('error', () => resolve(), { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    if (!this.retryAllowed()) return
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private retryAllowed(): boolean {
    if (this.shouldReconnect()) return true
    this.running = false
    this.emitState('stopped')
    return false
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}
