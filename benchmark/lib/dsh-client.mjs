import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const WebSocket = createRequire(new URL('../../packages/browser/bridge-browser/package.json', import.meta.url))('ws')

export class DshRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.code ?? 'unknown'}: ${error?.message ?? 'DSH RPC failed'}`)
    this.name = 'DshRpcError'
    this.method = method
    this.code = error?.code
    this.details = error?.details
  }
}

// Keep this client deliberately limited to the benchmark's current Typert API.
const REQUEST_METHODS = new Set(['session.create', 'session.selectModel', 'session.prompt', 'session.cancel'])

export class DshClient {
  constructor(baseUrl) {
    this.baseUrl = new URL(baseUrl)
    this.listeners = new Set()
    this.streams = new Map()
    this.socket = null
    this.connecting = null
    this.cancelConnection = null
    this.sessionFollow = null
    this.eventStream = null
    this.cookie = undefined
  }

  async authenticate(launchUrl) {
    const url = new URL(launchUrl)
    if (url.origin !== this.baseUrl.origin || url.pathname !== '/' || !url.searchParams.has('token')) {
      throw new Error('DSH launch URL must belong to this benchmark backend')
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_500) })
    const cookies = response.headers.getSetCookie()
    const cookie = cookies.find((value) => value.startsWith('dsh-auth-'))?.split(';')[0]
    await response.body?.cancel()
    if (response.status !== 303 || cookie === undefined) throw new Error('DSH launch-token exchange did not establish a browser session')
    this.cookie = cookie
  }

  async rpc(method, payload = {}, { signal, timeoutMs = 30_000 } = {}) {
    if (method === 'session.history') return this.sessionHistory(payload.sessionId, timeoutMs)
    const rpcId = randomUUID()
    let endpoint
    let args
    if (REQUEST_METHODS.has(method)) {
      endpoint = method.replace('.', '/')
      args = { request: method === 'session.prompt' ? { ...payload, requestId: rpcId } : payload }
    } else if (method === 'session.modelCatalog') {
      endpoint = 'session/modelCatalog'
      args = {}
    } else if (method === '$events/result') {
      endpoint = method
      args = payload
    } else {
      throw new Error(`unsupported benchmark RPC: ${method}`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs)
    const combinedSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    try {
      const response = await fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cookie === undefined ? {} : { cookie: this.cookie }) },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: combinedSignal,
      })
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${await response.text()}`)
      const envelope = await response.json()
      if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${method}: invalid response correlation`)
      if (envelope.result?.ok !== true) throw new DshRpcError(method, envelope.result?.error)
      return envelope.result.value
    } finally {
      clearTimeout(timer)
    }
  }

  async connectMux(timeoutMs = 15_000) {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connecting !== null) return this.connecting
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: this.cookie === undefined ? {} : { cookie: this.cookie } })
    this.socket = socket
    this.connecting = new Promise((resolve, reject) => {
      let opened = false
      const timer = setTimeout(() => failed(new Error(`DSH remote mux did not open within ${timeoutMs}ms`)), timeoutMs)
      const failed = (error) => {
        if (this.socket !== socket) return
        clearTimeout(timer)
        if (!opened) reject(error)
        this.failStreams(error)
        if (this.socket === socket) this.socket = null
        socket.close()
      }
      this.cancelConnection = failed
      socket.addEventListener('open', () => {
        opened = true
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => failed(new Error('DSH remote mux WebSocket failed')), { once: true })
      socket.addEventListener('close', () => failed(new Error('DSH remote mux WebSocket closed')), { once: true })
      socket.addEventListener('message', (message) => {
        if (this.socket !== socket) return
        try {
          if (typeof message.data !== 'string') throw new Error('DSH remote mux requires text frames')
          const frame = JSON.parse(message.data)
          if (typeof frame?.streamId !== 'string' || !['item', 'error', 'end'].includes(frame.type)) {
            throw new Error('invalid DSH remote stream frame')
          }
          const stream = this.streams.get(frame.streamId)
          if (stream === undefined) return // A canceled logical stream can have buffered frames.
          if (frame.type === 'item') stream.item(frame.value)
          else stream.fail(frame.type === 'error'
            ? new DshRpcError(stream.endpoint, frame.error)
            : new Error(`${stream.endpoint} ended unexpectedly`))
        } catch (error) {
          failed(error)
        }
      })
    })
    try { await this.connecting } finally { this.connecting = null }
  }

  async openStream(endpoint, args, onItem, onError, timeoutMs = 15_000) {
    await this.connectMux(timeoutMs)
    const streamId = randomUUID()
    const socket = this.socket
    let first = true
    let resolveFirst
    let rejectFirst
    const opening = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
    const close = () => {
      clearTimeout(timer)
      this.streams.delete(streamId)
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
    }
    const fail = (error) => {
      close()
      if (first) rejectFirst(error)
      else onError(error)
    }
    const timer = setTimeout(() => fail(new Error(`${endpoint} did not produce its opening frame within ${timeoutMs}ms`)), timeoutMs)
    this.streams.set(streamId, {
      endpoint,
      fail,
      item: (value) => {
        try {
          onItem(value, first)
          if (first) {
            first = false
            clearTimeout(timer)
            resolveFirst(value)
          }
        } catch (error) { fail(error) }
      },
    })
    try {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      const snapshot = await opening
      return { snapshot, close }
    } catch (error) {
      close()
      throw error
    }
  }

  async followSession(sessionId) {
    this.sessionFollow?.close()
    this.sessionFollow = null
    this.sessionFollow = await this.openStream('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true },
    }, (value, first) => {
      if (first) return assertSnapshot(value)
      if (value?.type === 'event') this.emit({ type: 'session/event', sessionId, event: value.event })
      else if (value?.type === 'assistant-stream') this.emit({ type: 'session/assistant-stream', sessionId, frame: value.frame })
      else throw new Error('session/follow emitted an invalid incremental frame')
    }, error => this.emit({ type: 'connection/error', sessionId, error }))
    return this.sessionFollow.snapshot
  }

  async sessionHistory(sessionId, timeoutMs = 15_000) {
    const stream = await this.openStream('session/follow', {
      request: { address: { kind: 'session', sessionId } },
    }, (value, first) => { if (first) assertSnapshot(value) }, () => {}, timeoutMs)
    stream.close()
    return { events: stream.snapshot.records, hasMore: stream.snapshot.hasMore, projections: stream.snapshot.projections }
  }

  async connectEvents() {
    this.eventStream?.close()
    let clientId
    this.eventStream = await this.openStream('$events', {}, (value, first) => {
      if (first) {
        if (value?.type !== 'ready' || typeof value.clientId !== 'string') throw new Error('$events did not begin with ready')
        clientId = value.clientId
        return
      }
      if (value?.type !== 'waterfall') return
      if (value.event === 'approval/request' || value.event === 'user-questions/request') {
        this.emit({ type: 'approval/requested', sessionId: value.agentId, toolName: value.request?.toolName ?? value.event })
      }
      // Benchmarks observe unexpected interaction, never approve or answer it.
      void this.rpc('$events/result', { clientId, eventId: value.eventId, outcome: { kind: 'next' } })
        .catch(error => this.emit({ type: 'connection/error', sessionId: value.agentId, error }))
    }, error => this.emit({ type: 'connection/error', error }))
  }

  failStreams(error) {
    for (const stream of [...this.streams.values()]) stream.fail(error)
  }

  emit(frame) {
    const receivedAt = performance.now()
    for (const listener of this.listeners) {
      try { listener(frame, receivedAt) } catch { /* Observer errors do not corrupt other streams. */ }
    }
  }

  onFrame(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.listeners.clear()
    this.cancelConnection?.(new Error('DSH benchmark client closed'))
    this.failStreams(new Error('DSH benchmark client closed'))
    this.sessionFollow = null
    this.eventStream = null
    const socket = this.socket
    this.socket = null
    socket?.close()
  }
}

function assertSnapshot(value) {
  if (value?.type !== 'snapshot' || !Number.isSafeInteger(value.cursor)
    || !Array.isArray(value.records) || typeof value.hasMore !== 'boolean') {
    throw new Error('session/follow did not begin with a valid snapshot')
  }
}

export async function waitForDsh(baseUrl, { timeoutMs = 60_000, process, getLaunchUrl } = {}) {
  const client = new DshClient(baseUrl)
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (process?.exitCode !== null && process?.exitCode !== undefined) {
      client.close()
      throw new Error(`DSH exited before becoming ready (exit ${process.exitCode})`)
    }
    try {
      if (getLaunchUrl !== undefined && client.cookie === undefined) {
        const launchUrl = getLaunchUrl()
        if (launchUrl === undefined) throw new Error('waiting for DSH authenticated launch URL')
        await client.authenticate(launchUrl)
      }
      await client.rpc('session.modelCatalog', {}, { timeoutMs: 1_500 })
      await client.connectEvents()
      return client
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  client.close()
  throw new Error(`DSH did not become ready at ${baseUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
