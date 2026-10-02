import { performance } from 'node:perf_hooks'
import { stateReached, validateTask } from './tasks.mjs'

function round(value) {
  return value === undefined ? undefined : Math.round(value * 100) / 100
}

function tokenDelta(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk?.type === 'tool-call-delta') return (chunk.name ?? '') !== '' || chunk.argumentsDelta !== ''
  return false
}

function visibleText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function addUsage(target, usage) {
  if (usage === undefined || usage === null) return
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    target[key] += Number(usage[key] ?? 0)
  }
}

export function appendEventTypeRun(runs, type) {
  const current = runs.at(-1)
  if (current?.type === type) current.count += 1
  else runs.push({ type, count: 1 })
}

async function readState(siteOrigin, runId) {
  const response = await fetch(`${siteOrigin}/api/state?run=${encodeURIComponent(runId)}`, {
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`benchmark state returned HTTP ${response.status}`)
  return response.json()
}

async function resetState(siteOrigin, instance) {
  const response = await fetch(`${siteOrigin}/api/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: instance.runId, taskId: instance.id }),
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`benchmark reset returned HTTP ${response.status}`)
}

async function prepareBackend(backend, instance, extensionBrowser) {
  if (backend.backend === 'extension') {
    if (extensionBrowser === undefined) throw new Error('extension browser is not running')
    await extensionBrowser.prepare(instance.url)
    return
  }
  const url = `${backend.baseUrl}/benchmark/playwright/reset?url=${encodeURIComponent(instance.url)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Playwright reset returned HTTP ${response.status}: ${await response.text()}`)
}

async function readPlaywrightMetrics(backend) {
  if (backend.backend !== 'playwright') return undefined
  const response = await fetch(`${backend.baseUrl}/benchmark/playwright/metrics`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) return undefined
  return (await response.json()).metrics
}

function waitForTurn() {
  let resolveTurn
  let rejectTurn
  const promise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
  // A carrier can fail while prompt admission is still awaiting its RPC.
  void promise.catch(() => {})
  return { promise, resolve: resolveTurn, reject: rejectTurn }
}

export async function runOne({
  backend,
  extensionBrowser,
  instance,
  siteOrigin,
  workspace,
  timeoutMs,
  modelSelection,
  metadata = {},
}) {
  await resetState(siteOrigin, instance)
  await prepareBackend(backend, instance, extensionBrowser)

  const created = await backend.client.rpc('session.create', { cwd: workspace })
  const sessionId = created.sessionId
  const models = await backend.client.rpc('session.modelCatalog')
  let selectedModel = models.default
  if (modelSelection !== undefined) {
    const selection = await backend.client.rpc('session.selectModel', { sessionId, ...modelSelection })
    selectedModel = selection.selected
  }
  // Establish the gap-free follower before the measured prompt so first-turn
  // events cannot race subscription setup for either backend.
  const opening = await backend.client.followSession(sessionId)
  selectedModel = opening?.projections?.values?.modelSelection?.next ?? selectedModel
  if (!models.routableProviders.includes(selectedModel.provider)) throw new Error(`model route is not available: ${selectedModel.provider}/${selectedModel.model}`)

  const startedEpochMs = Date.now()
  const started = performance.now()
  let promptAcceptedAt
  let turnStartedAt
  let firstTokenAt
  let stateReachedAt
  let endedAt
  let turnReason
  let finalAnswer = ''
  let assistantModel
  let timedOut = false
  let observerError
  let statePollError
  const eventTypeRuns = []
  const toolCalls = []
  const openCalls = new Map()
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  const turn = waitForTurn()

  const unsubscribe = backend.client.onFrame((frame, receivedAt) => {
    if (frame.type === 'connection/error' && (frame.sessionId === undefined || frame.sessionId === sessionId)) {
      turn.reject(frame.error)
      return
    }
    if (frame.sessionId !== sessionId) return
    try {
      if (frame.type === 'approval/requested') {
        appendEventTypeRun(eventTypeRuns, frame.type)
        observerError ??= `unexpected approval request for ${frame.toolName}`
        turn.reject(new Error(observerError))
        return
      }
      if (frame.type === 'session/assistant-stream') {
        appendEventTypeRun(eventTypeRuns, `assistant-stream/${frame.frame.type}`)
        if (frame.frame.type === 'chunk' && firstTokenAt === undefined && tokenDelta(frame.frame.chunk)) firstTokenAt = receivedAt
        return
      }
      if (frame.type !== 'session/event') return
      const event = frame.event
      appendEventTypeRun(eventTypeRuns, event.type)
      if (event.type === 'turn/start') turnStartedAt ??= receivedAt
      else if (event.type === 'assistant/message') {
        addUsage(totals, event.data?.usage)
        const text = visibleText(event.data?.message)
        if (text !== '') finalAnswer = text
        if (event.data?.message?.source?.kind === 'model') {
          assistantModel = {
            provider: event.data.message.source.provider,
            model: event.data.message.source.model,
          }
        }
      } else if (event.type === 'tool/call') {
        const call = {
          callId: event.data?.callId,
          name: event.data?.name ?? '(unknown)',
          arguments: event.data?.arguments,
          startedMs: round(receivedAt - started),
        }
        toolCalls.push(call)
        if (typeof call.callId === 'string') openCalls.set(call.callId, { call, receivedAt })
        if (!call.name.startsWith('browser_')) observerError ??= `forbidden tool called: ${call.name}`
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId
        const open = openCalls.get(callId)
        if (open !== undefined) {
          open.call.durationMs = round(receivedAt - open.receivedAt)
          open.call.ok = event.data?.message?.content?.[0]?.isError !== true && event.data?.error === undefined
          openCalls.delete(callId)
        }
      } else if (event.type === 'turn/end') {
        endedAt = receivedAt
        turnReason = event.data?.reason
        turn.resolve(event)
      }
    } catch (error) {
      observerError ??= error instanceof Error ? error.message : String(error)
    }
  })

  let stopPolling = false
  const pollState = (async () => {
    while (!stopPolling) {
      try {
        const state = await readState(siteOrigin, instance.runId)
        if (stateReachedAt === undefined && stateReached(instance, state)) stateReachedAt = performance.now()
      } catch (error) {
        statePollError ??= error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  })()

  let executionError
  let timeoutTimer
  try {
    const prompt = backend.client.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: instance.prompt }],
      clientTimeZone: 'Asia/Shanghai',
    }, { timeoutMs: 30_000 })
    await prompt
    promptAcceptedAt = performance.now()
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(`task timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    await Promise.race([turn.promise, timeout])
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error)
    timedOut = executionError.includes('timed out after')
    await backend.client.rpc('session.cancel', { sessionId }, { timeoutMs: 5_000 }).catch(() => undefined)
    endedAt ??= performance.now()
  } finally {
    clearTimeout(timeoutTimer)
    unsubscribe()
    stopPolling = true
    await pollState
  }

  const finalState = await readState(siteOrigin, instance.runId).catch((error) => ({ __readError: String(error) }))
  if (stateReachedAt === undefined && stateReached(instance, finalState)) stateReachedAt = performance.now()
  const history = await backend.client.rpc('session.history', { sessionId }).catch(() => undefined)
  const projectionStats = history?.projections?.values?.sessionStats
  const playwrightMetrics = await readPlaywrightMetrics(backend)
  const validation = validateTask(instance, finalState, finalAnswer, toolCalls.map((call) => call.name))
  const success = validation.success && executionError === undefined && observerError === undefined && turnReason?.kind === 'completed'
  const finished = endedAt ?? performance.now()
  const toolDurationMs = toolCalls.reduce((sum, call) => sum + Number(call.durationMs ?? 0), 0)

  return {
    schemaVersion: 1,
    ...metadata,
    backend: backend.backend,
    taskId: instance.id,
    seed: instance.seed,
    runId: instance.runId,
    sessionId,
    url: instance.url,
    timeoutMs,
    startedAt: new Date(startedEpochMs).toISOString(),
    model: assistantModel ?? selectedModel,
    success,
    validationReason: success ? validation.reason : executionError ?? observerError ?? validation.reason,
    timedOut,
    turnReason,
    finalAnswer,
    finalState,
    timings: {
      completionMs: round(finished - started),
      promptAcceptedMs: promptAcceptedAt === undefined ? undefined : round(promptAcceptedAt - started),
      turnStartMs: turnStartedAt === undefined ? undefined : round(turnStartedAt - started),
      ttftMs: firstTokenAt === undefined ? undefined : round(firstTokenAt - started),
      stateReachedMs: stateReachedAt === undefined ? undefined : round(stateReachedAt - started),
      toolWallMs: round(toolDurationMs),
      llmMs: projectionStats?.llmMs,
      projectedToolMs: projectionStats?.toolMs,
      projectedTtftMs: projectionStats?.ttftMs,
    },
    tokens: totals,
    tools: {
      count: toolCalls.length,
      names: toolCalls.map((call) => call.name),
      calls: toolCalls,
      playwrightMetrics,
    },
    diagnostics: {
      executionError,
      observerError,
      statePollError,
      eventTypeCount: eventTypeRuns.reduce((sum, run) => sum + run.count, 0),
      eventTypeRuns,
      projectionStats,
    },
  }
}
