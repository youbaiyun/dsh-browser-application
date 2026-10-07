/**
 * A loopback pass-through for image recognition, so the extension can call a cloud
 * endpoint without a manifest change.
 *
 * The extension's pages may only reach hosts listed in the manifest's
 * `content_security_policy.connect-src`, and that policy allows loopback —
 * `ws://127.0.0.1:*` and `http://127.0.0.1:*`, plain http only. Pointing the
 * extension at this proxy therefore needs no manifest edit, keeps the provider key
 * out of extension storage, and makes the provider's latency visible, which is the
 * number a recognition call is actually made of.
 *
 * It forwards one shape only — `POST …/chat/completions` — because that is the only
 * request the extension makes. Anything else is refused rather than guessed at.
 *
 * Nothing is logged but sizes, timings and status: request bodies carry the user's
 * images, and a proxy that prints them would put them in a terminal scrollback and
 * in whatever collects it.
 *
 * Usage:
 *   VISION_UPSTREAM=https://api.example.com/v1 VISION_KEY=sk-... \
 *     node tools/vision-proxy.mjs
 *
 * Then set the panel's cloud address to http://127.0.0.1:8080/v1
 */

import { createServer } from 'node:http'

const UPSTREAM = (process.env.VISION_UPSTREAM ?? '').replace(/\/+$/, '')
const KEY = process.env.VISION_KEY ?? ''
const PORT = Number(process.env.VISION_PORT ?? '8080')
const HOST = '127.0.0.1'

if (UPSTREAM === '') {
  console.error('Set VISION_UPSTREAM to the provider base URL, for example https://api.example.com/v1')
  process.exit(2)
}

/** Read a request body with a hard cap, so a stray upload cannot exhaust memory. */
async function readBody(request, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error(`request body over ${String(limit)} bytes`)
    chunks.push(chunk)
  }
  return { buffer: Buffer.concat(chunks), size }
}

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'GET' && path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ upstream: UPSTREAM, hasKey: KEY !== '' }))
    return
  }
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'this proxy forwards POST …/chat/completions only' } }))
    return
  }

  void (async () => {
    const startedAt = performance.now()
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
      return
    }
    const upstreamAt = performance.now()
    try {
      const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The proxy's key wins when it has one, so the extension can leave the
          // key field empty and keep the secret out of its storage.
          authorization: `Bearer ${KEY === '' ? (request.headers.authorization ?? '').replace(/^Bearer /, '') : KEY}`,
        },
        body: body.buffer,
      })
      const text = await upstream.text()
      const finishedAt = performance.now()
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      response.end(text)
      console.log(
        `[vision-proxy] ${upstream.status}  upstream ${Math.round(finishedAt - upstreamAt)}ms`
        + `  total ${Math.round(finishedAt - startedAt)}ms`
        + `  in ${(body.size / 1024).toFixed(0)}KB  out ${(text.length / 1024).toFixed(1)}KB`,
      )
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
      console.log(`[vision-proxy] upstream failed after ${Math.round(performance.now() - upstreamAt)}ms: ${String(error)}`)
    }
  })()
})

server.listen(PORT, HOST, () => {
  console.log(`[vision-proxy] ${HOST}:${String(PORT)} → ${UPSTREAM}/chat/completions`)
  console.log(`[vision-proxy] set the panel's cloud address to http://${HOST}:${String(PORT)}/v1`)
})
