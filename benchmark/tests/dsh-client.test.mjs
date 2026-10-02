import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { DshClient, waitForDsh } from '../lib/dsh-client.mjs'

const { WebSocketServer } = createRequire(new URL('../../packages/browser/bridge-browser/package.json', import.meta.url))('ws')
const SID = 'session-benchmark'
const snapshot = {
  type: 'snapshot', cursor: 0, records: [], hasMore: false,
  projections: { asOfSeq: 0, values: { sessionStats: { turns: 1 } } },
  assistantStream: { revision: 0 },
}

async function fixture(t, { unary, stream, onUpgrade, authentication = false } = {}) {
  const requests = []
  const messages = []
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    if (authentication && request.method === 'GET') {
      assert.equal(request.url, '/?token=fixture-launch-token')
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fixture=signed-fixture; HttpOnly; SameSite=Strict; Path=/' })
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ url: request.url, body })
    const value = await unary?.(body, request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: value ?? {} } }))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/api/remote.mux')
    onUpgrade?.(request)
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws))
  })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      messages.push(frame)
      stream?.(frame, ws)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const client = new DshClient(baseUrl)
  t.after(async () => {
    client.close()
    for (const ws of sockets) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { client, baseUrl, requests, messages, sockets }
}

const item = (ws, streamId, value) => ws.send(JSON.stringify({ type: 'item', streamId, value }))
const until = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition did not become true')
}

test('unary calls use current Typert endpoints, args and correlated prompt IDs', async (t) => {
  const { client, requests } = await fixture(t, { unary: () => ({ accepted: true }) })
  await client.rpc('session.create', { cwd: '/tmp/benchmark' })
  await client.rpc('session.modelCatalog')
  await client.rpc('session.prompt', { sessionId: SID, mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(requests.map((entry) => entry.url), ['/api/session/create', '/api/session/modelCatalog', '/api/session/prompt'])
  assert.deepEqual(requests[0].body.payload, { args: { request: { cwd: '/tmp/benchmark' } } })
  assert.deepEqual(requests[1].body.payload, { args: {} })
  assert.equal(requests[2].body.method, 'session/prompt')
  assert.equal(requests[2].body.payload.args.request.requestId, requests[2].body.rpcId)
  await assert.rejects(client.rpc('session.models'), /unsupported benchmark RPC/)
  assert.equal(requests.length, 3)
})

test('launch tokens exchange for a same-origin cookie shared by HTTP and WebSocket requests', async (t) => {
  let upgraded = false
  const { client, baseUrl } = await fixture(t, {
    authentication: true,
    unary(_body, request) { assert.equal(request.headers.cookie, 'dsh-auth-fixture=signed-fixture') },
    onUpgrade(request) {
      upgraded = true
      assert.equal(request.headers.cookie, 'dsh-auth-fixture=signed-fixture')
    },
    stream(frame, ws) { if (frame.type === 'open') item(ws, frame.streamId, snapshot) },
  })
  await assert.rejects(client.authenticate('https://unrelated.invalid/?token=fixture-launch-token'), /must belong to this benchmark backend/)
  await client.authenticate(`${baseUrl}/?token=fixture-launch-token`)
  await client.rpc('session.modelCatalog')
  await client.followSession(SID)
  assert.equal(upgraded, true)
})

test('follow admission precedes prompts and forwards transient tokens separately from durable history', async (t) => {
  let follower
  const { client, messages } = await fixture(t, {
    stream(frame, ws) {
      if (frame.type === 'open') {
        follower = { ws, streamId: frame.streamId }
        assert.equal(frame.endpoint, 'session/follow')
        assert.equal(frame.payload.args.request.assistantStream, true)
        item(ws, frame.streamId, snapshot)
      }
    },
    unary(body) {
      assert.ok(follower, 'prompt must not arrive before follow')
      const { ws, streamId } = follower
      item(ws, streamId, { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } })
      item(ws, streamId, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, chunk: { type: 'text-delta', text: 'hello', index: 0 } } })
      item(ws, streamId, { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hello' }] } } } })
      assert.equal(body.method, 'session/prompt')
      return { accepted: true }
    },
  })
  await client.followSession(SID)
  const frames = []
  client.onFrame((frame, at) => frames.push({ frame, at }))
  await client.rpc('session.prompt', { sessionId: SID, mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
  await until(() => frames.length === 3)
  assert.deepEqual(frames.map(({ frame }) => frame.type), ['session/event', 'session/assistant-stream', 'session/event'])
  assert.equal(frames[1].frame.frame.chunk.text, 'hello')
  assert.ok(frames.every(({ frame, at }) => frame.sessionId === SID && Number.isFinite(at)))
  assert.equal(messages[0].payload.args.request.address.sessionId, SID)
})

test('history snapshots use independent streams and cancel only their own subscription', async (t) => {
  const { client, messages } = await fixture(t, {
    stream(frame, ws) { if (frame.type === 'open') item(ws, frame.streamId, snapshot) },
  })
  await client.followSession(SID)
  const history = await client.rpc('session.history', { sessionId: SID })
  await until(() => messages.some((frame) => frame.type === 'cancel'))
  const opens = messages.filter((frame) => frame.type === 'open')
  const cancels = messages.filter((frame) => frame.type === 'cancel')
  assert.equal(opens.length, 2)
  assert.deepEqual(cancels, [{ type: 'cancel', streamId: opens[1].streamId }])
  assert.equal(history.projections.values.sessionStats.turns, 1)
})

test('stream errors and premature disconnects fail explicitly without waiting for a model timeout', async (t) => {
  const { client, sockets } = await fixture(t, {
    stream(frame, ws) {
      if (frame.type === 'open' && frame.payload.args.request.address.sessionId === 'missing') {
        ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'session/not-found', message: 'missing', details: {} } }))
      } else if (frame.type === 'open') item(ws, frame.streamId, snapshot)
    },
  })
  await assert.rejects(client.followSession('missing'), { code: 'session/not-found' })
  await client.followSession(SID)
  const failure = new Promise((resolve) => client.onFrame((frame) => { if (frame.type === 'connection/error') resolve(frame) }))
  for (const ws of sockets) ws.terminate()
  const frame = await failure
  assert.equal(frame.sessionId, SID)
  assert.match(frame.error.message, /WebSocket (closed|failed)/)
})

test('readiness verifies the new model catalog and event source; interaction remains unapproved', async (t) => {
  let eventSource
  const { client, baseUrl, requests } = await fixture(t, {
    stream(frame, ws) {
      if (frame.type === 'open') {
        assert.equal(frame.endpoint, '$events')
        eventSource = { ws, streamId: frame.streamId }
        item(ws, frame.streamId, { type: 'ready', clientId: 'benchmark-events', host: { home: '/tmp' } })
      }
    },
    unary: () => ({ default: { provider: 'test', model: 'test' }, routableProviders: ['test'], groups: [], failures: [] }),
  })
  const readyClient = await waitForDsh(baseUrl, { timeoutMs: 1_000 })
  t.after(() => readyClient.close())
  const seen = new Promise((resolve) => readyClient.onFrame(resolve))
  item(eventSource.ws, eventSource.streamId, { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: SID, request: { toolName: 'unexpected-tool' } })
  assert.equal((await seen).type, 'approval/requested')
  await until(() => requests.length === 2)
  assert.equal(requests[0].url, '/api/session/modelCatalog')
  assert.equal(requests[1].url, '/api/$events/result')
  assert.deepEqual(requests[1].body.payload.args.outcome, { kind: 'next' })
  client.close()
})
