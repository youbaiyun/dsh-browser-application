/**
 * dsh 0.2 Host adapter: unary calls through TypertGateway, plus the Session
 * and forwarded-event plumbing assembled from the gateway, history, and
 * event-generation modules.
 *
 * @module dsh-browser-crossplatform/src/remote-host-api
 */

import type { RespondResult } from '@dsh-browser/protocol'
import type {
  BrowserHostApi,
  HostEventFrame,
  HostRpcCall,
  HostRpcFailure,
  HostRpcResult,
} from './host-api.ts'
import { hostFailure, isRecord } from './host-api.ts'
import { ExtensionSessionRegistry } from './extension-sessions.ts'
import { openWireStream, type TypertGatewayLike, type HostConnectionLike } from './dsh-gateway.ts'
import {
  oneShotSessionSnapshot,
  historyValue,
  historyPageValue,
  optionalNonNegativeInteger,
  optionalPositiveInteger,
} from './session-history.ts'
import { EventGeneration, type RemoteEventOutcome } from './event-generation.ts'


interface InvokeTarget {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly adapt?: (value: unknown) => unknown
}


/** Build the dsh 0.2 Host implementation. */
export function createRemoteHostApi(
  gateway: TypertGatewayLike,
  connection: HostConnectionLike,
): BrowserHostApi {
  return new RemoteHostApi(gateway, connection)
}

class RemoteHostApi implements BrowserHostApi {
  private readonly fetchHandler: ReturnType<HostConnectionLike['createSharedFetchHandler']>
  private readonly extensionSessions = new ExtensionSessionRegistry()
  /** Last known session/follow tip per Session; drives session/page throughSeq. */
  private readonly historyCursors = new Map<string, number>()
  private activeEvents: EventGeneration | undefined

  constructor(
    private readonly gateway: TypertGatewayLike,
    connection: HostConnectionLike,
  ) {
    this.fetchHandler = connection.createSharedFetchHandler('/api')
  }

  async call(call: HostRpcCall): Promise<HostRpcResult> {
    if (call.method === 'session.history') return this.sessionHistory(call)
    if (call.method === 'session.models') return this.sessionModels(call)
    if (call.method === 'workspace.list') return this.workspaceList(call)
    if (call.method === 'session.follow') return this.sessionFollow(call)
    if (call.method === 'session.unfollow') return this.sessionUnfollow(call)

    const target = invokeTarget(call)
    if ('error' in target) return { ok: false, error: target.error }

    try {
      // Deferred Sessions have no history call with which to establish the
      // follower. Open it after materialization and before prompt admission,
      // so the first user/turn events cannot race past the extension.
      if (call.method === 'session.prompt') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId !== undefined) await this.activeEvents?.ensureSessionFollow(sessionId, call.signal)
      }
      const value = await this.gateway.invoke({
        namespace: target.namespace,
        method: target.method,
        args: target.args,
        signal: call.signal,
      })
      // Only claim ownership after a successful create/prompt. A failed prompt
      // against a Desktop session must not steal later ask_user_question away
      // from the native waterfall.
      if (call.method === 'session.create' || call.method === 'session.prompt') {
        this.extensionSessions.note(sessionIdOf(call.payload))
        this.extensionSessions.note(sessionIdOf(value))
        if (typeof value === 'string') this.extensionSessions.note(value)
      }
      return { ok: true, value: target.adapt?.(value) ?? value }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<HostEventFrame> {
    const generation = new EventGeneration(
      this.gateway,
      this.sendRemoteEventResult.bind(this),
      this.extensionSessions,
      this.noteHistoryCursor.bind(this),
      signal,
    )
    const previous = this.activeEvents
    this.activeEvents = generation
    await previous?.dispose()
    generation.start()
    try {
      yield * generation.events()
    } finally {
      if (this.activeEvents === generation) this.activeEvents = undefined
      await generation.dispose()
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const generation = this.activeEvents
    if (generation === undefined) return { accepted: false, reason: 'not-pending' }
    return generation.respond(rpcId, result, signal)
  }

  private async sessionHistory(call: HostRpcCall): Promise<HostRpcResult> {
    const sessionId = sessionIdOf(call.payload)
    if (sessionId === undefined) return badRequest('session.history requires a non-empty sessionId')
    let beforeSeq: number | undefined
    let maxMessages: number | undefined
    try {
      beforeSeq = optionalNonNegativeInteger(call.payload, 'beforeSeq')
      maxMessages = optionalPositiveInteger(call.payload, 'maxMessages')
    } catch (error: unknown) {
      return badRequest(error instanceof Error ? error.message : 'session.history pagination is invalid')
    }
    try {
      if (beforeSeq !== undefined) {
        const throughSeq = await this.historyThroughSeq(sessionId, call.signal)
        const page = await this.gateway.invoke({
          namespace: 'session',
          method: 'page',
          args: {
            request: {
              address: { kind: 'session', sessionId },
              throughSeq,
              beforeSeq,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
          },
          signal: call.signal,
        })
        return { ok: true, value: historyPageValue(page) }
      }

      const snapshot = this.activeEvents === undefined
        ? await oneShotSessionSnapshot(this.gateway, sessionId, call.signal, maxMessages)
        : await this.activeEvents.openSessionHistory(sessionId, call.signal, maxMessages)
      this.noteHistoryCursor(sessionId, snapshot.cursor)
      return { ok: true, value: historyValue(snapshot) }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * Start streaming one Session's events to the extension without prompting it.
   *
   * `session.prompt` opens the follower as a side effect, which is why a panel
   * that sends its own prompt sees its own conversation. A panel that is
   * *watching* a conversation the desktop app drives has no prompt to send, so
   * without this it receives nothing: the extension's renderer drops every event
   * whose sessionId is not the one it is bound to, and nothing ever binds it to a
   * running Session.
   *
   * Read-only by construction — it opens the same follower `session.history`
   * would and returns no Session value — so it cannot change a Session's state or
   * admit a turn.
   *
   * @param call - the Host call; `sessionId` names the Session to follow.
   * @returns `{ following: true }`, or a bad-request/gateway failure.
   */
  private async sessionFollow(call: HostRpcCall): Promise<HostRpcResult> {
    const sessionId = sessionIdOf(call.payload)
    if (sessionId === undefined) return badRequest('session.follow requires a non-empty sessionId')
    if (this.activeEvents === undefined) {
      return {
        ok: false,
        error: this.failure(new Error('this deployment cannot stream Session events')),
      }
    }
    try {
      await this.activeEvents.ensureSessionFollow(sessionId, call.signal)
      return { ok: true, value: { following: true } }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * Stop reading every Session except the ones named, releasing their streams.
   *
   * The counterpart to {@link sessionFollow}, and what keeps a whole-workspace mirror
   * from holding a stream per conversation for the lifetime of the connection. The
   * caller declares what it is still watching rather than what to close: the set it
   * holds is the authority, so an extension that missed a state change still ends up
   * with exactly the streams it wants, and naming a Session it does not follow is a
   * no-op rather than an error.
   *
   * Read-only in the same sense as `session.follow` — it only stops reads.
   *
   * @param call - the Host call; `keep` lists the Session ids still wanted.
   * @returns `{ following: n }`, the number of Sessions still being read.
   */
  private sessionUnfollow(call: HostRpcCall): HostRpcResult {
    if (!isRecord(call.payload)) return badRequest('session.unfollow payload must be an object')
    const raw = call.payload.keep
    if (raw !== undefined && !Array.isArray(raw)) {
      return badRequest('session.unfollow keep must be an array of session ids')
    }
    const keep = new Set<string>()
    for (const entry of Array.isArray(raw) ? raw : []) {
      // A malformed entry is skipped rather than failing the call: the request's whole
      // purpose is to release resources, and refusing it would leave them held.
      if (typeof entry === 'string' && entry !== '') keep.add(entry)
    }
    if (this.activeEvents === undefined) {
      return { ok: false, error: this.failure(new Error('this deployment cannot stream Session events')) }
    }
    try {
      this.activeEvents.retainSessionFollows(keep)
      return { ok: true, value: { following: keep.size } }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /** Combine the deployment catalog with the Session's durable next selection. */
  private async sessionModels(call: HostRpcCall): Promise<HostRpcResult> {
    if (!isRecord(call.payload)) return badRequest('session.models payload must be an object')
    const sessionId = sessionIdOf(call.payload)
    try {
      const catalog = await this.gateway.invoke({
        namespace: 'session', method: 'modelCatalog', args: {}, signal: call.signal,
      })
      // Provisional Sessions request only the catalog and overlay their pending choice.
      const projections = sessionId === undefined ? undefined : await this.gateway.invoke({
        namespace: 'session', method: 'projections', args: { request: { sessionId } }, signal: call.signal,
      })
      const values = isRecord(projections) ? projections.values : undefined
      const modelSelection = isRecord(values) ? values.modelSelection : undefined
      const next = isRecord(modelSelection) ? modelSelectionOf(modelSelection.next) : undefined
      return { ok: true, value: adaptModelCatalog(catalog, next) }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * Resolve a Host-legal throughSeq for older history pages.
   * Never invent Number.MAX_SAFE_INTEGER â€” session/page rejects tips past the log cursor.
   */
  private async historyThroughSeq(sessionId: string, signal: AbortSignal): Promise<number> {
    const cached = this.historyCursors.get(sessionId)
    if (cached !== undefined) return cached
    const snapshot = this.activeEvents === undefined
      ? await oneShotSessionSnapshot(this.gateway, sessionId, signal)
      : await this.activeEvents.openSessionHistory(sessionId, signal)
    this.noteHistoryCursor(sessionId, snapshot.cursor)
    const throughSeq = this.historyCursors.get(sessionId)
    if (throughSeq === undefined) {
      throw new TypeError('session/follow snapshot did not provide a usable history cursor')
    }
    return throughSeq
  }

  private noteHistoryCursor(sessionId: string, cursor: number): void {
    // Host session/page refuses throughSeq past the durable tip; MAX_SAFE_INTEGER is
    // only a UI sentinel elsewhere and must never be forwarded as a page tip.
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor === Number.MAX_SAFE_INTEGER) return
    const previous = this.historyCursors.get(sessionId)
    if (previous === undefined || cursor > previous) this.historyCursors.set(sessionId, cursor)
  }

  private async workspaceList(call: HostRpcCall): Promise<HostRpcResult> {
    try {
      const controller = new AbortController()
      const signal = AbortSignal.any([call.signal, controller.signal])
      const source = await openWireStream(this.gateway, 'workspace/follow', { args: {} }, signal)
      const iterator = source[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        if (first.done || !isWorkspaceBaseline(first.value)) {
          throw new TypeError('workspace/follow did not begin with a baseline')
        }
        return { ok: true, value: first.value.value }
      } finally {
        controller.abort(new Error('workspace baseline received'))
        await iterator.return?.()
      }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  private failure(error: unknown): HostRpcFailure {
    try {
      return this.gateway.wireStream.failure(error)
    } catch {
      return hostFailure(error)
    }
  }

  private async sendRemoteEventResult(
    clientId: string,
    eventId: string,
    outcome: RemoteEventOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const rpcId = crypto.randomUUID()
    const request = new Request('http://dsh.internal/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: '$events/result',
        payload: { args: { clientId, eventId, outcome } },
      }),
      signal,
    })
    const response = await this.fetchHandler.fetch(request)
    if (!response.ok) {
      throw new Error(`$events/result transport failed with HTTP ${String(response.status)}: ${await response.text()}`)
    }
    const envelope = await response.json() as unknown
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new TypeError('$events/result returned an invalid server-response')
    }
    if (envelope.result.ok) return
    const error = isRecord(envelope.result.error) ? envelope.result.error : {}
    const failure = new Error(typeof error.message === 'string' ? error.message : '$events/result was rejected') as Error & {
      code?: string
      details?: unknown
    }
    if (typeof error.code === 'string') failure.code = error.code
    if (error.details !== undefined) failure.details = error.details
    throw failure
  }
}


function invokeTarget(call: HostRpcCall): InvokeTarget | { readonly error: HostRpcFailure } {
  if (!isRecord(call.payload)) return { error: badRequestFailure(`${call.method} payload must be an object`) }
  switch (call.method) {
    case 'session.list':
      return { namespace: 'session', method: 'list', args: { _request: call.payload } }
    case 'session.create':
    case 'session.selectModel':
    case 'session.attachment':
    case 'session.cancel':
    case 'workspace.create':
    case 'workspace.rename':
    case 'workspace.archiveSession': {
      const [namespace, method] = call.method.split('.') as [string, string]
      return { namespace, method, args: { request: call.payload } }
    }
    case 'session.prompt':
      return {
        namespace: 'session',
        method: 'prompt',
        args: { request: { requestId: call.rpcId, ...call.payload } },
      }
    case 'settings.describe':
      return { namespace: 'settings', method: 'describe', args: {} }
    case 'settings.mutate':
      return { namespace: 'settings', method: 'mutate', args: call.payload }
    case 'credentials.describe':
      return {
        namespace: 'credentials',
        method: 'describe',
        args: call.payload,
        adapt: value => ({ credentials: value }),
      }
    case 'credentials.set':
    case 'credentials.unset': {
      const method = call.method.slice('credentials.'.length)
      return { namespace: 'credentials', method, args: call.payload, adapt: () => ({}) }
    }
    case 'llm.discoverModels': {
      const { settingsNs, ...request } = call.payload
      if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
        return { error: badRequestFailure('llm.discoverModels requires settingsNs') }
      }
      return {
        namespace: 'llm',
        method: 'discoverModels',
        args: { settingsNs, request },
        adapt: value => ({ models: value }),
      }
    }
    default:
      return {
        error: {
          code: 'not-found',
          message: `browser bridge Host method ${JSON.stringify(call.method)} is unavailable`,
          details: {},
        },
      }
  }
}


function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.sessionId === 'string' && payload.sessionId.length > 0
    ? payload.sessionId
    : undefined
}

/** Map Host ModelCatalog into the extension's session.models directory shape. */
function adaptModelCatalog(value: unknown, next?: ReturnType<typeof modelSelectionOf>): unknown {
  if (!isRecord(value)) return value
  const selection = next ?? modelSelectionOf(value.default)
  const groups = Array.isArray(value.groups) ? value.groups : []
  const failures = Array.isArray(value.failures) ? value.failures : []
  const routableProviders = Array.isArray(value.routableProviders)
    ? value.routableProviders.filter((entry): entry is string => typeof entry === 'string')
    : []
  const current = selection ?? { provider: 'none', model: 'none' }
  return {
    current,
    routable: selection !== undefined && routableProviders.includes(selection.provider),
    groups,
    failures,
  }
}

function modelSelectionOf(value: unknown): {
  provider: string
  model: string
  reasoningEffort?: string
} | undefined {
  if (!isRecord(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
    ? value.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function badRequest(message: string): HostRpcResult {
  return { ok: false, error: badRequestFailure(message) }
}

function badRequestFailure(message: string): HostRpcFailure {
  return { code: 'bad-request', message, details: {} }
}

function isWorkspaceBaseline(value: unknown): value is {
  readonly type: 'baseline'
  readonly value: Record<string, unknown>
} {
  return isRecord(value) && value.type === 'baseline' && isRecord(value.value)
}

