import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { waitForDsh } from './dsh-client.mjs'

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function waitForPlaywrightStatus(baseUrl, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited while the Playwright plugin was loading (exit ${child.exitCode})`)
    try {
      const response = await fetch(`${baseUrl}/benchmark/playwright/status`, { signal: AbortSignal.timeout(1_500) })
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.json()
        if (response.ok && body.ok === true) return body
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Playwright plugin did not become ready: ${lastError instanceof Error ? lastError.message : 'status route unavailable'}`)
}

export async function startDshBackend({
  backend,
  port,
  repoRoot,
  benchmarkRoot,
  runtimeRoot,
  startUrl,
}) {
  const backendRoot = join(runtimeRoot, backend)
  const sessionRoot = join(backendRoot, 'sessions')
  const storageRoot = join(backendRoot, 'storages')
  const logsRoot = join(runtimeRoot, 'logs')
  await Promise.all([mkdir(sessionRoot, { recursive: true }), mkdir(storageRoot, { recursive: true }), mkdir(logsRoot, { recursive: true })])
  const patchTemplate = resolve(benchmarkRoot, 'patches', `${backend}.patch.yml`)
  const patch = join(backendRoot, 'effective.patch.yml')
  const pluginUrl = pathToFileURL(resolve(benchmarkRoot, 'plugin/playwright-browser.mjs')).href
  const bridgePluginUrl = pathToFileURL(resolve(repoRoot, 'packages/browser/bridge-browser/lib/index.js')).href
  const patchText = (await readFile(patchTemplate, 'utf8'))
    .replace('__BENCHMARK_PLAYWRIGHT_PLUGIN__', pluginUrl)
    .replace('__BENCHMARK_BRIDGE_PLUGIN__', bridgePluginUrl)
  await writeFile(patch, patchText)
  const logPath = join(logsRoot, `dsh-${backend}.log`)
  const log = createWriteStream(logPath, { flags: 'a' })
  const child = spawn('pnpm', ['exec', 'dsh', '--profile', 'web', '--patch', patch, '--', '--no-open', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BENCHMARK_SESSION_ROOT: sessionRoot,
      BENCHMARK_STORAGE_ROOT: storageRoot,
      BENCHMARK_START_URL: startUrl,
      DSH_BROWSER_SESSION_WORKSPACE: resolve(benchmarkRoot, 'workspace'),
      DSH_EXT_TOKEN: 'dsh-browser-benchmark-local-token',
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  const baseUrl = `http://127.0.0.1:${port}`
  let launchUrl
  let outputBuffer = ''
  child.stdout.on('data', (chunk) => {
    outputBuffer = (outputBuffer + chunk.toString()).slice(-16_384)
    for (const match of outputBuffer.matchAll(/dsh web: (https?:\/\/\S+)/gu)) {
      try {
        const url = new URL(match[1])
        if (url.origin === baseUrl && url.searchParams.has('token')) launchUrl = url.href
      } catch { /* Startup diagnostics are not necessarily URLs. */ }
    }
  })
  let client
  try {
    client = await waitForDsh(baseUrl, { process: child, getLaunchUrl: () => launchUrl })
    if (backend === 'playwright') {
      await waitForPlaywrightStatus(baseUrl, child)
    }
  } catch (error) {
    child.kill('SIGTERM')
    await waitForExit(child, 3_000)
    log.end()
    throw new Error(`${backend} backend failed to start; see ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    backend,
    baseUrl,
    child,
    client,
    logPath,
    async close() {
      client.close()
      child.kill('SIGTERM')
      if (!await waitForExit(child, 5_000)) {
        child.kill('SIGKILL')
        await waitForExit(child, 2_000)
      }
      await new Promise((resolveLog) => log.end(resolveLog))
    },
  }
}
