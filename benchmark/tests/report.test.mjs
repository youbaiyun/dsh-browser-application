import test from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../report.mjs'

function record(backend, completionMs, success = true) {
  return {
    schemaVersion: 1,
    benchmarkId: 'test-benchmark',
    benchmarkSuiteVersion: 2,
    pairId: 'contact_form:seed-1:trial-1',
    trial: 1,
    backend,
    taskId: 'contact_form',
    seed: 1,
    success,
    validationReason: success ? 'validated' : 'timed out',
    timeoutMs: 1_000,
    timings: { completionMs, ttftMs: 100, stateReachedMs: 300, llmMs: 500, toolWallMs: 80 },
    tools: { count: 4 },
    tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
  }
}

test('report renders success, latency and paired speed ratio', () => {
  const markdown = renderReport([record('playwright', 800), record('extension', 400)])
  assert.match(markdown, /Playwright \/ 扩展耗时比/u)
  assert.match(markdown, /2\.00/u)
  assert.match(markdown, /100\.0%/u)
  assert.match(markdown, /联系信息表单/u)
  assert.match(markdown, /平均 TTFT/u)
  assert.match(markdown, /平均 prompt token（含缓存）/u)
})

test('report isolates identical pair IDs from different benchmark runs', () => {
  const firstPlaywright = record('playwright', 800)
  const firstExtension = record('extension', 400)
  const secondPlaywright = { ...record('playwright', 300), benchmarkId: 'second-benchmark' }
  const secondExtension = { ...record('extension', 600), benchmarkId: 'second-benchmark' }

  const markdown = renderReport([firstPlaywright, firstExtension, secondPlaywright, secondExtension])
  assert.match(markdown, /\| 总计 \| 2 \| 2 \| 0 \| 0 \| 0 \| 1\.00/u)
  assert.match(markdown, /Benchmark ID 2 个/u)
})

test('report exposes asymmetric outcomes and groups dynamic failure reasons', () => {
  const playwright = record('playwright', 800)
  const extension = {
    ...record('extension', 700, false),
    validationReason: 'answer did not contain "Birch 旅行杯"',
  }
  const secondFailure = {
    ...record('extension', 600, false),
    pairId: 'contact_form:seed-2:trial-1',
    seed: 2,
    validationReason: 'answer did not contain "Cedar 旅行杯"',
  }

  const markdown = renderReport([playwright, extension, secondFailure])
  assert.match(markdown, /\| 联系信息表单 \| 1 \| 0 \| 1 \| 0 \| 0 \|/u)
  assert.match(markdown, /\| extension \| 答案不匹配 \| 2 \|/u)
})

test('report skips duplicate backend records instead of silently cross-pairing them', () => {
  const markdown = renderReport([
    record('playwright', 800),
    record('playwright', 900),
    record('extension', 400),
  ])

  assert.match(markdown, /有重复后端记录，已跳过/u)
  assert.match(markdown, /\| 总计 \| 0 \| 0 \| 0 \| 0 \| 0 \|/u)
})

test('report rejects records from incompatible benchmark suite versions', () => {
  const legacy = { ...record('playwright', 800), benchmarkSuiteVersion: 1 }
  const current = record('extension', 400)

  assert.throws(
    () => renderReport([legacy, current]),
    /不能汇总多个评测套件版本：1、2/u,
  )
})
