/**
 * A stand-in vision endpoint, for measuring the round trip without a provider.
 *
 * Answers the same request shape a real endpoint would, after a delay you choose.
 * Because the delay is the only slow part, whatever you observe beyond it is the
 * extension, the bridge and the fill — which is the part worth knowing before
 * paying anyone to find out.
 *
 * It is also the cheapest way to check the direct path end to end: loopback
 * addresses are already allowed by the extension's policy, so pointing the panel
 * at this needs no manifest change and no key.
 *
 * The request body is never printed: it holds the user's image. Only its size is.
 *
 * Usage:
 *   node tools/vision-stub.mjs                 # answers after 800ms
 *   STUB_MS=2500 node tools/vision-stub.mjs    # or whatever you want to feel
 *   STUB_DESC=一张季度营收折线图 node tools/vision-stub.mjs
 *
 * Then set the panel's cloud address to http://127.0.0.1:9099/v1 and leave the key
 * empty. Ask for an image, and the console prints what it received and when.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? '9099')
const HOST = '127.0.0.1'
const DELAY_MS = Number(process.env.STUB_MS ?? '800')
const DESCRIPTION = process.env.STUB_DESC ?? '一张折线图，横轴是季度，纵轴是营收'

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'GET' && path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ delayMs: DELAY_MS, description: DESCRIPTION }))
    return
  }
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'this stub answers POST …/chat/completions only' } }))
    return
  }
  void (async () => {
    const receivedAt = performance.now()
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    // How much of the request is the image itself rather than the wrapper around
    // it. The base64 is measured, never printed: it is the user's picture.
    const imageChars = /"url":\s*"data:[^;]+;base64,([A-Za-z0-9+/=]*)"/.exec(body.toString('utf8'))?.[1].length ?? 0
    console.log(
      `[vision-stub] request in  ${(body.length / 1024).toFixed(1)}KB`
      + `  (image ${(imageChars * 3 / 4 / 1024).toFixed(1)}KB)`
      + `  waiting ${String(DELAY_MS)}ms`,
    )
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: DESCRIPTION } }],
        usage: { prompt_tokens: 0, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } },
      }))
      console.log(`[vision-stub] answered after ${String(Math.round(performance.now() - receivedAt))}ms`)
    }, DELAY_MS)
  })()
})

server.listen(PORT, HOST, () => {
  console.log(`[vision-stub] http://${HOST}:${String(PORT)}/v1  answering after ${String(DELAY_MS)}ms`)
  console.log(`[vision-stub] panel cloud address: http://${HOST}:${String(PORT)}/v1   key: leave empty`)
})
