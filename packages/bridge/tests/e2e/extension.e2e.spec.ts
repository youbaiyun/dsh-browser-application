/**
 * End-to-end proof for the built extension against the real BridgeServer.
 *
 * Two things are checked, in the order they depend on each other:
 *
 * 1. The extension authenticates and a tool call is dispatched. The distinguishing
 *    signal is the failure *code*: `bridge-closed` means no authenticated
 *    connection exists and the call never left the server, while any other code
 *    means it was dispatched.
 * 2. Recognition runs the whole way round. Only the model is stubbed — a stubbed
 *    `fetch` inside a real `VisionClient` behind a real `ImageRelay` — so the
 *    request body, the parser, the `image.call`/`image.result` frames and the
 *    marker fill in the page text are all production code. The snapshot is taken
 *    before and after, so the assertion is that a description the model produced
 *    ends up at the image's position in the text, and that asking again costs a
 *    second request only when the answer is not already known.
 *
 * The browser must be one that still honours `--load-extension`: Playwright's
 * bundled Chromium does, while current system Chrome/Edge (137+) ignore it unless
 * developer mode is on. Set `PLAYWRIGHT_CHROMIUM_PATH` to pin a browser. Without a
 * usable browser or a built `extension/dist`, it self-skips.
 *
 * These tests run the built extension, so `pnpm --filter dsh-browser-extension run
 * build` has to happen *before* them: the workspace test script does not rebuild,
 * and a stale `dist` fails here as if the source were wrong.
 */

import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type LaunchPersistentContextOptions } from 'playwright-core'
import { MAX_DESC_CHARS, THINKING_OFF } from '@dsh-browser/protocol'
import { ImageRelay } from '../../src/image-relay.ts'
import { BridgeServer } from '../../src/server.ts'
import { DEFAULT_EXTENSION_IDS } from '../../src/index.ts'
import { launchBrowser } from '../../src/browser-launch.ts'
import { VisionClient } from '../../src/vision.ts'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../../src/host-api.ts'

/** The ports the extension probes, in order; the suite binds the first free one. */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189, 19387] as const
/** Used only by the page under test, so the two servers never contend. */
const PAGE_PORT = 3081
const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../extension/dist')

/** Whether this checkout has a built extension for the suite to drive. */
const hasExtensionBuild = existsSync(join(EXTENSION_DIR, 'manifest.json'))
/** What the stubbed model answers, and what the test looks for in the text. */
const DESCRIPTION = '完成度达到 50%'
/** One transparent pixel: enough for `<img>` to have bytes and dimensions. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolveWait) => {
    signal.addEventListener('abort', () => { resolveWait() }, { once: true })
  })
}

let browser: BrowserContext | undefined
let profile: string | undefined
let http: Server | undefined
let pageServer: Server | undefined
let bridge: BridgeServer | undefined
let serving = false
const calls: HostRpcCall[] = []
/** Every request the vision client sent, so the body can be inspected. */
const visionRequests: { url: string; body: Record<string, unknown> }[] = []

/** Launch options that let a browser load an unpacked extension. */
function launchOptions(): LaunchPersistentContextOptions {
  const options: LaunchPersistentContextOptions = { headless: true }
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (override !== undefined && existsSync(override)) {
    options.executablePath = override
    // System Chrome/Edge 137+ gate the switch behind this feature flag.
    options.args = ['--disable-features=DisableLoadExtensionCommandLineSwitch']
  } else {
    // The bundled Chromium build still honours --load-extension as-is.
    options.channel = 'chromium'
  }
  options.args = [
    ...(options.args ?? []),
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
  ]
  return options
}

/**
 * Save the settings this suite needs, then close.
 *
 * A fresh profile has none, and recognition is off by default — which is the
 * right default and also the reason this has to be seeded. Seeding during the
 * same launch cannot work: the worker reads its settings once at startup, and a
 * reload leaves it with no worker at all.
 */
async function seedSettings(profileDir: string): Promise<void> {
  const context = await chromium.launchPersistentContext(profileDir, launchOptions())
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
    await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('dshSettings')
      const current = typeof stored.dshSettings === 'object' && stored.dshSettings !== null
        ? stored.dshSettings as Record<string, unknown>
        : {}
      await chrome.storage.local.set({
        dshSettings: {
          ...current,
          visionTier: 'standard',
          sharePageContent: 'auto',
          // A tool call from the bridge would otherwise wait for an approval no
          // test can answer, and the panel would take the active tab from the page.
          unrestrictedBrowserAccess: true,
          autoOpenPanel: false,
        },
      })
    })
  } finally {
    await context.close()
  }
}

/** What the stubbed model does next, so a test can choose success or failure. */
type StubReply = { kind: 'ok'; content: string } | { kind: 'http'; status: number }
let nextReply: StubReply = { kind: 'ok', content: DESCRIPTION }

/** A page with two images, served over http so a content script may be injected. */
function startPageServer(): Promise<Server> {
  const server = createServer((req, res) => {
    if ((req.url ?? '') === '/missing.png') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    // The second image has a different address, which is what makes it a
    // different image to the cache: identity is the address.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>营收看板</title></head><body>
      <h1>本季度营收</h1>
      <p>完成度 30%</p>
      <img src="data:image/png;base64,${PIXEL}" alt="季度营收" style="width:64px;height:64px">
      <img src="data:image/png;charset=utf-8;base64,${PIXEL}" alt="退款率" style="width:64px;height:64px">
      <img src="/missing.png" alt="缺失的图" style="width:64px;height:64px">
    </body></html>`)
  })
  return new Promise<Server>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(PAGE_PORT, '127.0.0.1', () => { resolveListen(server) })
  })
}

/** The inventory index of the image whose alt text is `alt`, from a snapshot. */
function indexOfImage(snapshot: string, alt: string): number {
  const match = new RegExp(`\\[(\\d+)\\] img [^\\n]*"${alt}"`).exec(snapshot)
  return match === null ? Number.NaN : Number(match[1])
}

/** The snapshot text a tool call produced. */
function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const text = (result as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

beforeAll(async () => {
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) return

  const api: BrowserHostApi = {
    async call(request): Promise<HostRpcResult> {
      calls.push(request)
      if (request.method === 'session.create') return { ok: true, value: { sessionId: 'session-browser-e2e' } }
      if (request.method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (request.method === 'session.list') return { ok: true, value: { items: [] } }
      if (request.method === 'workspace.list') return { ok: true, value: { items: [], archivedSessionIds: [] } }
      return { ok: true, value: {} }
    },
    async *events(signal) { await abortWait(signal) },
    async respond() { return { accepted: false, reason: 'not-pending' } },
  }
  // Everything except the model is real: the relay, the request builder and the
  // parser are production code, and the stubbed fetch records what they sent.
  const stubFetch: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    visionRequests.push({ url: String(input), body })
    if (nextReply.kind === 'http') {
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: nextReply.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: nextReply.content } }],
      usage: { completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const vision = new VisionClient(
    {
      model: 'stub-vision',
      // Production supplies the thinking switch from the plugin config; the test
      // has to do the same or it would assert a switch nothing was asked to send.
      extraBody: THINKING_OFF,
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'stub',
      timeoutMs: 5_000,
    },
    stubFetch,
  )
  bridge = new BridgeServer({
    token: TOKEN,
    // Same as production: the built extension's manifest `key` derives this id,
    // and it is what lets the zero-config path skip the token. Passing it here
    // keeps the suite testing that path instead of the token fallback.
    extensionId: DEFAULT_EXTENSION_IDS[0]!,
    api,
    toolTimeoutMs: 20_000,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    policy: { openPagesForUser: true },
    imageRelay: new ImageRelay(vision),
    injectBrowserSnapshot: () => {},
    purgeSession: async () => {},
  })

  const server = createServer((req, res) => {
    if (req.url === '/ext/bridge-config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(boundPort)}/ext/bridge` }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.on('upgrade', (req, socket, head) => { bridge?.handleUpgrade(req, socket, head) })
  // Bind one of the ports the extension actually probes, not 3080 specifically: a
  // leftover socket from an interrupted run would otherwise turn into a 60-second
  // "no-connection" failure that says nothing about the cause.
  let boundPort = 0
  for (const candidate of DISCOVERY_PORTS) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => { rejectListen(error) }
        server.once('error', onError)
        server.listen(candidate, '127.0.0.1', () => { server.off('error', onError); resolveListen() })
      })
      boundPort = candidate
      break
    } catch {
      // Taken by something else; try the next port the extension discovers.
    }
  }
  if (boundPort === 0) {
    await bridge.close()
    bridge = undefined
    console.warn(`SKIP: every discovery port (${DISCOVERY_PORTS.join(', ')}) is already in use`)
    return
  }
  http = server
  pageServer = await startPageServer()
  serving = true

  profile = await mkdtemp(join(tmpdir(), 'dsh-browser-extension-e2e-'))
  try {
    await seedSettings(profile)
    browser = await chromium.launchPersistentContext(profile, launchOptions())
  } catch (error: unknown) {
    console.warn(`SKIP: no browser that loads unpacked extensions is available (${String(error)})`)
    browser = undefined
  }
})

afterAll(async () => {
  await browser?.close()
  await bridge?.close()
  if (http !== undefined) {
    await new Promise<void>((resolveClose) => { http?.close(() => { resolveClose() }) })
  }
  if (pageServer !== undefined) {
    await new Promise<void>((resolveClose) => { pageServer?.close(() => { resolveClose() }) })
  }
  if (profile !== undefined) await rm(profile, { recursive: true, force: true })
})

describe.skipIf(!hasExtensionBuild)('extension ↔ bridge e2e', () => {
  it('authenticates a freshly installed extension and dispatches a tool call', { timeout: 120_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined) {
      console.warn('SKIP: needs a Chromium that loads extensions, a built extension/dist, and free port 3080')
      return
    }
    const context = browser
    const server = bridge

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
    expect(worker.url()).toContain('chrome-extension://')

    let outcome = 'no-connection'
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const value = await server.requestTool('browser_list_tabs', {}, AbortSignal.timeout(2_000), 2_000)
        outcome = `ok:${JSON.stringify(value).slice(0, 160)}`
        break
      } catch (error: unknown) {
        const code = (error as { code?: unknown }).code
        const message = error instanceof Error ? error.message : String(error)
        if (code !== 'bridge-closed') {
          outcome = `${String(code)}:${message.slice(0, 160)}`
          break
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, 2_000) })
    }

    expect(outcome).not.toBe('no-connection')
  })

  it('describes an image through the relay and renders it at the image position', { timeout: 180_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined || pageServer === undefined) {
      console.warn('SKIP: needs the harness from the previous test')
      return
    }
    const context = browser
    const server = bridge

    // The page becomes the active tab, which is what the affinity fallback picks
    // up when no tab has been explicitly followed.
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${String(PAGE_PORT)}/`, { waitUntil: 'load' })

    const before = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    expect(before).toContain('Images:')
    // Nothing has been asked about this image yet, and the text says so rather
    // than leaving a gap the model has to interpret.
    expect(before).toContain('img:not-requested')
    // The notation explains itself, and names the tool that fills the gap.
    expect(before).toContain('browser_describe_image')
    // An image the page could not load is reported as such, in the line and in the
    // marker, rather than disappearing from the snapshot.
    expect(before).toContain('[load-failed]')
    expect(before).toContain('img:unavailable:load-failed')
    const index = indexOfImage(before, '季度营收')
    expect(Number.isInteger(index)).toBe(true)

    const describedText = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(describedText).toContain(DESCRIPTION)
    expect(describedText).toContain('Cross-check against the page text')
    // The page says 完成度 30% beside the image and the model answered 50%: the
    // local check has to catch that, and it is what makes the answer unusable for
    // an action without the user.
    expect(describedText).toContain('CONFLICT')

    // The model was asked exactly once, with thinking off, about this image.
    expect(visionRequests).toHaveLength(1)
    const request = visionRequests[0]!
    expect(request.url).toContain('/chat/completions')
    expect(request.body).toMatchObject({ model: 'stub-vision', temperature: 0, max_tokens: MAX_DESC_CHARS })
    expect(request.body).toMatchObject({ thinking: { type: 'disabled' }, reasoning_effort: 'none' })
    expect(JSON.stringify(request.body)).toContain('data:image/png;base64,')

    // The next snapshot carries the description where the image is.
    const after = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    expect(after).toContain(`img:${DESCRIPTION}`)
    // Only the image that was asked about is described; the other still says so,
    // which is what makes "not-requested" a statement worth making.
    expect(indexOfImage(after, '退款率')).toBeGreaterThan(0)
    expect(after).toContain('img:not-requested')

    // Asking again costs nothing: an answer is a property of the image.
    const again = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(again).toContain(DESCRIPTION)
    expect(visionRequests).toHaveLength(1)
  })

  it('grades a provider failure and a model decline differently', { timeout: 180_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined || pageServer === undefined) {
      console.warn('SKIP: needs the harness from the previous tests')
      return
    }
    const context = browser
    const server = bridge

    // The page from the previous test is still the controlled tab, so this uses
    // the other image on it rather than opening a tab the affinity would ignore.
    const snapshot = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    const index = indexOfImage(snapshot, '退款率')
    expect(Number.isInteger(index)).toBe(true)

    // A provider failure says nothing about the image, so it stays retryable.
    const before = visionRequests.length
    nextReply = { kind: 'http', status: 401 }
    const failed = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(failed).toContain('vision-http')
    expect(failed).toContain('Trying again later may succeed')
    expect(visionRequests.length).toBe(before + 1)

    // A decline is a verdict: the model was asked and answered that it cannot tell.
    nextReply = { kind: 'ok', content: 'UNCLEAR' }
    const declined = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(declined).toContain('vision-unclear')
    expect(declined).toContain('will not be asked about again')

    // The page text says the same thing, with the reason, instead of going quiet.
    const after = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    expect(after).toContain('unavailable:vision-unclear')

    // And asking again costs nothing: a declined image is not retried into a loop.
    const asked = visionRequests.length
    const skipped = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(skipped).toContain('vision-skipped')
    expect(visionRequests.length).toBe(asked)

    nextReply = { kind: 'ok', content: DESCRIPTION }
  })

  it('persists a tier chosen in the side panel', { timeout: 120_000 }, async () => {
    if (!serving || browser === undefined) {
      console.warn('SKIP: needs the harness from the previous tests')
      return
    }
    const context = browser
    const worker = context.serviceWorkers()[0]
    expect(worker).toBeDefined()
    const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(worker!.url())?.[1]
    expect(extensionId).toBeDefined()

    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${String(extensionId)}/control/index.html`, { waitUntil: 'load' })
    // The sheet is closed until it is asked for.
    await panel.locator('[data-role="settings"]').first().click()
    // Located by its option values, which do not depend on the UI language the
    // test browser happens to report.
    const tier = panel.locator('select:has(option[value="enhanced"])').first()
    await tier.waitFor({ state: 'visible', timeout: 20_000 })
    // Seeded as `standard`, so this is a change the panel has to carry.
    await tier.selectOption('enhanced')

    await expect.poll(async () => await worker!.evaluate(async () => {
      const stored = await chrome.storage.local.get('dshSettings')
      const settings = stored.dshSettings as { visionTier?: unknown } | undefined
      return settings?.visionTier
    }), { timeout: 20_000 }).toBe('enhanced')

    await panel.close()
  })
})

/**
 * The launch path, exercised against a real browser and a real extension.
 *
 * **Opt-in, `DSH_E2E_COLD_START=1`.** It starts a browser the way the product
 * does, and on a developer's machine that is a window they did not ask for —
 * running the suite must never open the user's browser behind their back. CI sets
 * the variable (headless, on a throwaway profile); locally it is skipped.
 *
 * Kept out of the suite above for a second reason: it has to observe "no
 * extension is connected", and that suite's own context holds the connection. A
 * second bridge on a second discovery port keeps the two from interfering.
 */
const coldStartEnabled = process.env.DSH_E2E_COLD_START === '1'
describe.skipIf(!hasExtensionBuild || process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined || !coldStartEnabled)('cold start', () => {
  it('starts a closed browser and the extension connects by itself', { timeout: 180_000 }, async () => {
    const browserExe = process.env.PLAYWRIGHT_CHROMIUM_PATH
    if (browserExe === undefined) return

    const api: BrowserHostApi = {
      async call() { return { ok: true, value: {} } },
      async *events(signal: AbortSignal) { await abortWait(signal) },
      async respond() { return { accepted: false, reason: 'not-pending' } },
    }
    const bridge = new BridgeServer({
      token: TOKEN,
      extensionId: DEFAULT_EXTENSION_IDS[0]!,
      api,
      toolTimeoutMs: 20_000,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
      policy: { openPagesForUser: true },
      injectBrowserSnapshot: () => {},
      purgeSession: async () => {},
    })
    // The first harness holds 3080 and the page server 3081, so this cold-start
    // bridge takes the next port the extension also probes.
    const port = DISCOVERY_PORTS.find((candidate) => candidate !== 3080 && candidate !== 3081)
    if (port === undefined) throw new Error('the discovery port list has no spare entry')
    const server = createServer((req, res) => {
      if (req.url === '/ext/bridge-config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(port)}/ext/bridge` }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })

    const profile = await mkdtemp(join(tmpdir(), 'dsh-browser-cold-start-'))
    try {
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen)
          server.listen(port, '127.0.0.1', resolveListen)
        })
      } catch {
        // Another process holds that port; skip rather than test the wrong one.
        console.warn(`SKIP: discovery port ${String(port)} is in use`)
        return
      }
      expect(bridge.hasConnection()).toBe(false)

      const outcome = await launchBrowser(
        {
          executablePath: browserExe,
          extensionPath: EXTENSION_DIR,
          userDataDir: profile,
          // This CI host has no display; the launcher spawns the process itself,
          // so it has to be told, unlike a Playwright launch which defaults it.
          headless: true,
          timeoutMs: 60_000,
          // Detection would find a system Chrome, which cannot load an unpacked
          // extension at all; the executable above is the one that can.
        },
        () => bridge.hasConnection(),
      )
      expect(outcome.message).not.toContain('failed')
      expect(outcome.connected).toBe(true)

      // And the connection is usable, not merely present.
      const tabs = textOf(await bridge.requestTool('browser_list_tabs', {}, AbortSignal.timeout(20_000), 20_000))
      expect(tabs).toContain('127.0.0.1')
    } finally {
      await bridge.close()
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      // A browser that just exited can still hold a crashpad file on Windows; a
      // failed cleanup must not turn a passing test into a failing one.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
  })
})
