/**
 * One authenticated extension connection's event streams, its active Session
 * follower, and the forwarded Host waterfalls it answers.
 *
 * @module dsh-browser-crossplatform/src/event-generation
 */

import type { RespondResult } from '@dsh-browser/protocol'
import { openWireStream, type TypertGatewayLike } from './dsh-gateway.ts'
import { isSessionSnapshot, type SessionSnapshot } from './session-history.ts'
import type { HostEventFrame } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { ExtensionSessionRegistry, shouldBridgeOwnQuestion } from './extension-sessions.ts'

interface PendingQuestion {
  readonly sessionId: string
  settled: boolean
}

/**
 * One Session being read on this connection.
 *
 * Its own abort controller is what makes the followers independent: stopping one — a
 * conversation leaving the mirrored set, or being replaced — must not disturb the
 * others. Nothing here is shared, deliberately.
 */
interface SessionFollower {
  readonly controller: AbortController
}

export type SendRemoteEventResult = (
  clientId: string,
  eventId: string,
  outcome: RemoteEventOutcome,
  signal: AbortSignal,
) => Promise<void>

export type RemoteEventOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: unknown }
  | {
    readonly kind: 'rejected'
    readonly error: {
      readonly name: string
      readonly message: string
      readonly code?: string
      readonly details?: unknown
    }
  }

/** One authenticated extension connection's event streams and its Session followers. */
export class EventGeneration {
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly queue = new AsyncEventQueue()
  private readonly tasks = new Set<Promise<void>>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private clientId: string | undefined
  /**
   * One follower per Session, keyed by Session id.
   *
   * A map rather than a single slot: 「工作区内」 mirrors a whole workspace, and with one
   * slot each follow aborted the one before it — so nineteen conversations produced one
   * live stream and eighteen silent ones.
   */
  private readonly followers = new Map<string, SessionFollower>()
  private disposed = false

  constructor(
    private readonly gateway: TypertGatewayLike,
    private readonly sendResult: SendRemoteEventResult,
    private readonly extensionSessions: ExtensionSessionRegistry,
    private readonly onHistoryCursor: (sessionId: string, cursor: number) => void,
    outerSignal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([outerSignal, this.lifetime.signal])
  }

  start(): void {
    this.track(this.pumpRemoteEvents())
  }

  events(): AsyncIterable<HostEventFrame> {
    return this.queue.iterate(this.signal)
  }

  async openSessionHistory(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<SessionSnapshot> {
    return this.openSessionFollow(sessionId, callSignal, maxMessages)
  }

  /**
   * Follow one Session, opening its stream if this connection is not already reading it.
   *
   * One follower **per Session**, not one follower per connection. A single slot was
   * enough while the panel mirrored exactly one conversation, but 「工作区内」 mirrors a
   * whole workspace: with a single slot each `session.follow` aborted the previous
   * follower, so asking for nineteen conversations left exactly one streaming and the
   * panel silently showed one conversation out of nineteen.
   *
   * Idempotent for the same Session, so a caller may ask repeatedly — the extension
   * does, on every refresh tick.
   *
   * @param sessionId - the Session to read.
   * @param callSignal - the caller's cancellation.
   */
  async ensureSessionFollow(sessionId: string, callSignal: AbortSignal): Promise<void> {
    const existing = this.followers.get(sessionId)
    if (existing !== undefined && existing.controller.signal.aborted === false) return
    await this.openSessionFollow(sessionId, callSignal)
  }

  /**
   * Stop following the Sessions that are not in the given set.
   *
   * Called when the mirrored set shrinks — a conversation left the workspace, or the
   * user switched back to a single-conversation mode — so the bridge stops reading
   * Sessions nobody is looking at, instead of streaming them for the connection's
   * lifetime.
   *
   * @param keep - Sessions to keep following.
   */
  retainSessionFollows(keep: ReadonlySet<string>): void {
    for (const [sessionId, follower] of [...this.followers]) {
      if (keep.has(sessionId)) continue
      this.followers.delete(sessionId)
      follower.controller.abort(new Error('browser bridge Session follower no longer watched'))
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const pending = this.pendingQuestions.get(rpcId)
    const clientId = this.clientId
    if (pending === undefined || pending.settled || clientId === undefined) {
      return { accepted: false, reason: 'not-pending' }
    }
    pending.settled = true
    try {
      await this.sendResult(clientId, rpcId, respondOutcome(result), AbortSignal.any([this.signal, signal]))
      return { accepted: true }
    } catch (error: unknown) {
      pending.settled = false
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const follower of this.followers.values()) {
      follower.controller.abort(new Error('browser bridge event generation closed'))
    }
    this.followers.clear()
    this.lifetime.abort(new Error('browser bridge event generation closed'))
    this.queue.end()
    await Promise.all(this.tasks)
  }

  private async openSessionFollow(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<SessionSnapshot> {
    // Replaces any existing follower *for this Session only*. Every other Session keeps
    // streaming, which is what makes a whole-workspace mirror possible.
    this.followers.get(sessionId)?.controller.abort(new Error('browser bridge Session follower reopened'))
    const controller = new AbortController()
    const follower: SessionFollower = { controller }
    this.followers.set(sessionId, follower)
    const signal = AbortSignal.any([this.signal, callSignal, controller.signal])
    /** Whether this follower is still the Session's current one. */
    const current = (): boolean => this.followers.get(sessionId) === follower
    try {
      const source = await openWireStream(this.gateway,
        'session/follow',
        {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              assistantStream: true,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
          },
        },
        signal,
      )
      const iterator = source[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done || !isSessionSnapshot(first.value)) {
        await iterator.return?.()
        throw new TypeError('session/follow did not begin with a snapshot')
      }
      if (!current() || signal.aborted) {
        await iterator.return?.()
        signal.throwIfAborted()
        throw new Error('browser bridge Session follower was replaced while opening')
      }
      this.onHistoryCursor(sessionId, first.value.cursor)
      const snapshotId = first.value.assistantStream === undefined ? undefined : crypto.randomUUID()
      // Publish the reconnect prefix before any suffix chunks. RPC responses
      // and pushed events can otherwise race, dropping the beginning of an
      // already-running attempt when the panel reopens its history.
      if (first.value.assistantStream !== undefined) {
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/assistant-stream',
          payload: {
            sessionId,
            snapshotId,
            frame: { type: 'snapshot', baseline: first.value.assistantStream },
          },
        })
      }
      this.track(this.pumpSessionEvents(sessionId, follower, iterator, signal))
      return {
        cursor: first.value.cursor,
        records: first.value.records,
        hasMore: first.value.hasMore,
        ...(first.value.projections === undefined ? {} : { projections: first.value.projections }),
        ...(first.value.assistantStream === undefined ? {} : { assistantStream: first.value.assistantStream }),
        ...(snapshotId === undefined ? {} : { snapshotId }),
      }
    } catch (error: unknown) {
      // Only this Session's entry, and only if it is still ours: a follower that was
      // replaced by a newer one must not remove its successor's registration.
      if (current()) this.followers.delete(sessionId)
      throw error
    }
  }

  private async pumpSessionEvents(
    sessionId: string,
    follower: SessionFollower,
    iterator: AsyncIterator<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    /**
     * Whether this follower is still the Session's current one.
     *
     * Answered from the follower itself, never from a counter shared by the whole
     * connection. A shared counter made every other Session look replaced the moment a
     * new one was followed, so a workspace mirror kept exactly one stream alive — the
     * same failure as the single abort slot, reached a different way.
     */
    const current = (): boolean => this.followers.get(sessionId) === follower
    try {
      while (!signal.aborted) {
        const next = await iterator.next()
        // Abort is advisory to an AsyncIterator: a buffered frame may still resolve
        // after this follower was replaced. Never let that superseded stream update the
        // extension's state for a Session someone else is now reading.
        if (signal.aborted || !current()) break
        if (next.done) break
        if (isRecord(next.value) && next.value.type === 'assistant-stream' && isRecord(next.value.frame)) {
          this.queue.push({
            rpcId: crypto.randomUUID(),
            method: 'session/assistant-stream',
            payload: { sessionId, frame: next.value.frame },
          })
          continue
        }
        if (!isSessionEventEntry(next.value)) {
          throw new TypeError('session/follow emitted an invalid incremental frame')
        }
        const seq = next.value.event.seq
        if (typeof seq === 'number') this.onHistoryCursor(sessionId, seq)
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/event',
          payload: { type: 'session/event', sessionId, event: next.value.event },
        })
      }
      if (!signal.aborted && current()) {
        throw new Error('session/follow ended unexpectedly')
      }
    } catch (error: unknown) {
      // A stream that was deliberately stopped — replaced, or no longer watched — must
      // not fail the connection's queue: the abort is the expected outcome, not a fault.
      if (!signal.aborted && current()) this.queue.fail(error)
    } finally {
      await iterator.return?.()
      if (current()) this.followers.delete(sessionId)
    }
  }

  private async pumpRemoteEvents(): Promise<void> {
    try {
      const source = await openWireStream(this.gateway, '$events', { args: {} }, this.signal)
      let ready = false
      for await (const value of source) {
        if (!ready) {
          if (!isRemoteEventReady(value)) throw new TypeError('$events did not begin with ready')
          this.clientId = value.clientId
          ready = true
          continue
        }
        await this.handleRemoteEvent(value)
      }
      if (!this.signal.aborted) throw new Error('$events ended unexpectedly')
    } catch (error: unknown) {
      if (!this.signal.aborted) this.queue.fail(error)
    }
  }

  private async handleRemoteEvent(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new TypeError('$events emitted an invalid frame')
    }
    if (value.type === 'emit') return
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      const pending = this.pendingQuestions.get(value.eventId)
      if (pending === undefined) return
      this.pendingQuestions.delete(value.eventId)
      this.queue.push({
        rpcId: crypto.randomUUID(),
        method: 'question/resolved',
        payload: {
          type: 'question/resolved',
          sessionId: pending.sessionId,
          questionRpcId: value.eventId,
        },
      })
      return
    }
    if (value.type !== 'waterfall'
      || typeof value.event !== 'string'
      || typeof value.eventId !== 'string'
      || typeof value.agentId !== 'string'
      || !isRecord(value.request)) {
      throw new TypeError('$events emitted an invalid waterfall frame')
    }
    if (value.event !== 'user-questions/request' || !Array.isArray(value.request.questions)) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sendResult(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    // Desktop-owned sessions keep the native waterfall. Only forward questions
    // for sessions the extension successfully created or prompted.
    if (!shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: value.agentId,
      extensionSessions: this.extensionSessions,
    })) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sendResult(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    this.pendingQuestions.set(value.eventId, { sessionId: value.agentId, settled: false })
    this.queue.push({
      rpcId: value.eventId,
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: value.agentId,
        questions: value.request.questions,
      },
    })
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!this.signal.aborted) this.queue.fail(error)
    })
    this.tasks.add(tracked)
    void tracked.finally(() => { this.tasks.delete(tracked) })
  }
}

class AsyncEventQueue {
  private readonly frames: HostEventFrame[] = []
  private wake: (() => void) | undefined
  private failure: unknown
  private closed = false

  push(frame: HostEventFrame): void {
    if (this.closed || this.failure !== undefined) return
    this.frames.push(frame)
    this.wake?.()
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) return
    this.failure = error
    this.wake?.()
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<HostEventFrame> {
    const onAbort = (): void => { this.wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.frames.length > 0) yield this.frames.shift() as HostEventFrame
        if (this.failure !== undefined) throw this.failure
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function respondOutcome(result: RespondResult): RemoteEventOutcome {
  if (result.ok) {
    const value = isRecord(result.value) && isRecord(result.value.answer)
      ? result.value.answer
      : result.value
    return value === undefined ? { kind: 'result' } : { kind: 'result', value }
  }
  return {
    kind: 'rejected',
    error: {
      name: 'Error',
      message: result.error.message,
      code: result.error.code,
      details: result.error.details,
    },
  }
}

function isSessionEventEntry(value: unknown): value is {
  readonly type: 'event'
  readonly event: Record<string, unknown>
} {
  return isRecord(value) && value.type === 'event' && isRecord(value.event)
}

function isRemoteEventReady(value: unknown): value is {
  readonly type: 'ready'
  readonly clientId: string
} {
  return isRecord(value) && value.type === 'ready'
    && typeof value.clientId === 'string' && value.clientId.length > 0
}
