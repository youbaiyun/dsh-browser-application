import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapGeometricMeanCI, geometricMean, mean, summarize } from './lib/statistics.mjs'
import { TASK_CATALOG } from './lib/tasks.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const taskNames = new Map(TASK_CATALOG.map((task) => [task.id, task.name]))

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—'
}

function percent(numerator, denominator) {
  return denominator === 0 ? '—' : `${fixed(numerator / denominator * 100, 1)}%`
}

function groupBy(values, keyOf) {
  const groups = new Map()
  for (const value of values) {
    const key = keyOf(value)
    groups.set(key, [...groups.get(key) ?? [], value])
  }
  return groups
}

function token(record, key) {
  const value = record.tokens?.[key]
  return Number.isFinite(value) ? value : 0
}

function promptTokens(record) {
  return token(record, 'inputTokens') + token(record, 'cacheReadTokens') + token(record, 'cacheWriteTokens')
}

function summaryRow(label, records) {
  const successful = records.filter((record) => record.success === true)
  const durations = summarize(successful.map((record) => record.timings?.completionMs))
  return [
    label,
    records.length,
    successful.length,
    percent(successful.length, records.length),
    fixed(durations.p50),
    durations.n >= 10 ? fixed(durations.p90) : '—',
    fixed(durations.mean),
    fixed(mean(successful.map((record) => record.tools?.count))),
    fixed(mean(successful.map(promptTokens))),
    fixed(mean(successful.map((record) => token(record, 'outputTokens')))),
  ]
}

function phaseRow(label, records) {
  const successful = records.filter((record) => record.success === true)
  return [
    label,
    successful.length,
    fixed(mean(successful.map((record) => record.timings?.ttftMs))),
    fixed(mean(successful.map((record) => record.timings?.stateReachedMs))),
    fixed(mean(successful.map((record) => record.timings?.llmMs))),
    fixed(mean(successful.map((record) => record.timings?.toolWallMs))),
    fixed(mean(successful.map((record) => record.tools?.count))),
    fixed(mean(successful.map((record) => token(record, 'inputTokens')))),
    fixed(mean(successful.map((record) => token(record, 'cacheReadTokens')))),
    fixed(mean(successful.map((record) => token(record, 'cacheWriteTokens')))),
    fixed(mean(successful.map((record) => token(record, 'outputTokens')))),
  ]
}

function escapeCell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/gu, ' ')
}

function table(headers, rows) {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n')
}

function pairKey(record) {
  const logicalPair = record.pairId ?? `${record.taskId}:${record.seed}:${record.trial ?? 1}`
  return `${record.benchmarkId ?? '(missing benchmark ID)'}\u0000${logicalPair}`
}

function effectiveDuration(record) {
  const duration = record.timings?.completionMs
  if (record.success === true && Number.isFinite(duration) && duration > 0) return duration
  const timeout = Number.isFinite(record.timeoutMs) && record.timeoutMs > 0 ? record.timeoutMs : 120_000
  return timeout * 2
}

function pairedAnalysis(records) {
  const pairs = groupBy(records, pairKey)
  const taskRatios = new Map()
  const taskPenalized = new Map()
  const taskCounts = new Map()
  const orderRatios = new Map()
  const warnings = []

  for (const [identifier, pair] of pairs) {
    const playwrightRecords = pair.filter((record) => record.backend === 'playwright')
    const extensionRecords = pair.filter((record) => record.backend === 'extension')
    if (playwrightRecords.length > 1 || extensionRecords.length > 1) {
      warnings.push(`配对 ${identifier.replace('\u0000', ' / ')} 有重复后端记录，已跳过。`)
      continue
    }
    const playwright = playwrightRecords[0]
    const extension = extensionRecords[0]
    if (playwright === undefined || extension === undefined) continue
    if (playwright.taskId !== extension.taskId) {
      warnings.push(`配对 ${identifier.replace('\u0000', ' / ')} 的 taskId 不一致，已跳过。`)
      continue
    }

    const taskId = playwright.taskId
    const counts = taskCounts.get(taskId) ?? {
      pairs: 0,
      bothSuccess: 0,
      playwrightOnly: 0,
      extensionOnly: 0,
      bothFailed: 0,
    }
    counts.pairs += 1
    if (playwright.success && extension.success) counts.bothSuccess += 1
    else if (playwright.success) counts.playwrightOnly += 1
    else if (extension.success) counts.extensionOnly += 1
    else counts.bothFailed += 1

    const playwrightDuration = playwright.timings?.completionMs
    const extensionDuration = extension.timings?.completionMs
    if (playwright.success && extension.success && playwrightDuration > 0 && extensionDuration > 0) {
      const ratio = playwrightDuration / extensionDuration
      taskRatios.set(taskId, [...taskRatios.get(taskId) ?? [], ratio])
      if (extension.pairOrder === 1 || extension.pairOrder === 2) {
        orderRatios.set(extension.pairOrder, [...orderRatios.get(extension.pairOrder) ?? [], ratio])
      }
    }
    taskPenalized.set(taskId, [
      ...taskPenalized.get(taskId) ?? [],
      effectiveDuration(playwright) / effectiveDuration(extension),
    ])
    taskCounts.set(taskId, counts)
  }

  const rows = [...taskCounts.keys()].sort().map((taskId) => {
    const ratios = taskRatios.get(taskId) ?? []
    const counts = taskCounts.get(taskId)
    return [
      taskNames.get(taskId) ?? taskId,
      counts.pairs,
      counts.bothSuccess,
      counts.playwrightOnly,
      counts.extensionOnly,
      counts.bothFailed,
      fixed(geometricMean(ratios), 2),
      fixed(geometricMean(taskPenalized.get(taskId) ?? []), 2),
    ]
  })
  const allRatios = [...taskRatios.values()].flat()
  const allPenalized = [...taskPenalized.values()].flat()
  const ci = bootstrapGeometricMeanCI(allRatios)
  const totalCounts = [...taskCounts.values()].reduce((sum, value) => ({
    pairs: sum.pairs + value.pairs,
    bothSuccess: sum.bothSuccess + value.bothSuccess,
    playwrightOnly: sum.playwrightOnly + value.playwrightOnly,
    extensionOnly: sum.extensionOnly + value.extensionOnly,
    bothFailed: sum.bothFailed + value.bothFailed,
  }), { pairs: 0, bothSuccess: 0, playwrightOnly: 0, extensionOnly: 0, bothFailed: 0 })
  rows.push([
    '总计',
    totalCounts.pairs,
    totalCounts.bothSuccess,
    totalCounts.playwrightOnly,
    totalCounts.extensionOnly,
    totalCounts.bothFailed,
    ci === undefined
      ? fixed(geometricMean(allRatios), 2)
      : `${fixed(geometricMean(allRatios), 2)}（95% CI ${fixed(ci.low, 2)}–${fixed(ci.high, 2)}）`,
    fixed(geometricMean(allPenalized), 2),
  ])

  const orderRows = [...orderRatios.entries()]
    .sort(([left], [right]) => left - right)
    .map(([order, ratios]) => [
      order === 1 ? '扩展先运行' : '扩展后运行',
      ratios.length,
      fixed(geometricMean(ratios), 2),
    ])
  return { rows, orderRows, warnings }
}

function failureCategory(record) {
  const reason = String(record.validationReason ?? record.infrastructureError ?? 'unknown')
  if (record.infrastructureError !== undefined || reason.startsWith('runner error:')) return '基础设施错误'
  if (record.timedOut === true || /timed out|timeout/iu.test(reason)) return '超时'
  if (/forbidden tool|used forbidden tools/iu.test(reason)) return '使用禁用工具'
  if (reason.startsWith('answer did not contain')) return '答案不匹配'
  if (reason.startsWith('final page state did not match')) return '页面状态不匹配'
  if (/approval/iu.test(reason)) return '意外审批请求'
  if (record.turnReason?.kind !== undefined && record.turnReason.kind !== 'completed') return 'Turn 未正常完成'
  return '其他'
}

function failureRows(records) {
  const groups = groupBy(
    records.filter((record) => !record.success),
    (record) => `${record.backend}\u0000${failureCategory(record)}`,
  )
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, rows]) => {
      const [backend, category] = key.split('\u0000')
      const example = String(rows[0].validationReason ?? rows[0].infrastructureError ?? 'unknown')
      return [backend, category, rows.length, example.length > 180 ? `${example.slice(0, 177)}…` : example]
    })
}

export function renderReport(records, { sourceName = 'benchmark.jsonl' } = {}) {
  const valid = records.filter((record) => record?.schemaVersion === 1 && typeof record.backend === 'string')
  const suiteVersions = [...new Set(valid.map((record) => record.benchmarkSuiteVersion ?? 'legacy/unknown'))]
  if (suiteVersions.length > 1) {
    throw new Error(`不能汇总多个评测套件版本：${suiteVersions.join('、')}。请按 benchmarkSuiteVersion 分别生成报告。`)
  }
  const benchmarkIds = [...new Set(valid.map((record) => record.benchmarkId).filter(Boolean))]
  const backendGroups = groupBy(valid, (record) => record.backend)
  const overview = [...backendGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([backend, rows]) => summaryRow(backend, rows))
  const taskRows = []
  for (const [backend, rows] of [...backendGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (const [taskId, taskRecords] of [...groupBy(rows, (record) => record.taskId).entries()].sort(([left], [right]) => left.localeCompare(right))) {
      taskRows.push(summaryRow(`${backend} / ${taskNames.get(taskId) ?? taskId}`, taskRecords))
    }
  }
  const failures = valid.filter((record) => !record.success)
  const paired = pairedAnalysis(valid)
  const phaseRows = [...backendGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([backend, rows]) => phaseRow(backend, rows))
  const controlledRecords = valid.filter((record) => record.environment !== undefined && record.model !== undefined)
  const configurationCount = new Set(controlledRecords.map((record) => JSON.stringify({
    environment: record.environment,
    model: record.model,
    timeoutMs: record.timeoutMs,
  }))).size
  const consistencyNotes = [
    `有效记录 ${valid.length} 条，Benchmark ID ${benchmarkIds.length} 个。配对键同时包含 Benchmark ID，不会把追加到同一 JSONL 的多次运行交叉配对。`,
    `评测套件版本：${suiteVersions.join('、')}。`,
    ...(suiteVersions.includes('legacy/unknown') ? ['部分记录没有评测套件版本；它们属于旧结果，不应与修正成功标准后的结果直接比较。'] : []),
    ...(configurationCount > 1 ? [`检测到 ${configurationCount} 套环境、模型或超时配置；不要把它们当成一个受控实验直接汇总。`] : []),
    ...paired.warnings,
  ]

  const lines = [
    '# DSH Browser 基准评测报告',
    '',
    `数据文件：\`${sourceName}\`  `,
    `Benchmark ID：${benchmarkIds.length === 0 ? '—' : benchmarkIds.map((id) => `\`${id}\``).join('、')}  `,
    `生成时间：${new Date().toISOString()}`,
    '',
    '## 总览',
    '',
    table(['后端', '运行数', '成功数', '成功率', 'P50 完成耗时(ms)', 'P90*(ms)', '平均(ms)', '平均工具调用', '平均 prompt token（含缓存）', '平均输出 token'], overview),
    '',
    '完成耗时从提交 `session.prompt` 前一刻计到对应 `turn/end` 被 runner 收到。耗时统计只包含成功运行；成功率必须与耗时一起解读。P90 仅在至少 10 个成功样本时展示，避免给小样本制造虚假精度。',
    '',
    '## 分任务',
    '',
    table(['后端 / 任务', '运行数', '成功数', '成功率', 'P50 完成耗时(ms)', 'P90*(ms)', '平均(ms)', '平均工具调用', '平均 prompt token（含缓存）', '平均输出 token'], taskRows),
    '',
    '## 成功运行的阶段与 token',
    '',
    table(['后端', '成功数', '平均 TTFT(ms)', '平均状态达成(ms)', '平均 LLM(ms)', '平均工具墙钟(ms)', '平均工具调用', '平均新输入 token', '平均缓存读取 token', '平均缓存写入 token', '平均输出 token'], phaseRows),
    '',
    '`状态达成`只对具有可外部验证页面状态的任务有值；该列是有值样本的均值。`LLM` 来自 DSH session projection，`工具墙钟`来自 runner 观察到的 tool call/result 区间，两者可能重叠，不能与完成耗时直接相加。',
    '',
    '## 配对对比',
    '',
    table(['任务', '配对数', '双方成功', '仅 Playwright 成功', '仅扩展成功', '双方失败', 'Playwright / 扩展耗时比', '失败惩罚后耗时比'], paired.rows),
    '',
    '比值大于 1 表示扩展后端更快，小于 1 表示 Playwright 后端更快。“双方成功”列使用同 Benchmark ID、同任务、同 seed、同 trial 的成功配对并取几何均值；样本至少有两对时，总计给出固定随机种子的 bootstrap 95% 置信区间。“失败惩罚后”把失败运行计为 `2 × timeout`，用于降低只看成功样本造成的幸存者偏差。',
    '',
    ...(paired.orderRows.length === 0 ? [] : [
      '### 运行顺序敏感性',
      '',
      table(['配对顺序', '双方成功配对数', 'Playwright / 扩展耗时比'], paired.orderRows),
      '',
      '若两行差异明显，结果可能仍受热身、缓存或时间漂移影响，应增加 trial 并随机化更大的运行块。',
      '',
    ]),
    '## 失败摘要',
    '',
    failures.length === 0
      ? '无失败运行。'
      : table(['后端', '类别', '次数', '示例'], failureRows(valid)),
    '',
    '## 数据一致性',
    '',
    ...consistencyNotes.map((note) => `- ${note}`),
    '',
    '## 解释边界',
    '',
    '- 两边使用相同 DSH profile、模型选择、任务提示词、seed、机器和本地网页；模型可见的工具名称、说明、参数与通用系统提示保持对齐。',
    '- 这是完整浏览器后端的端到端比较，不是纯传输开销实验。两边的页面结构化表示、索引实现和浏览器动作执行仍不同，这些差异属于被测后端的一部分。',
    '- 运行顺序按配对交替，避免总是让某一个后端先跑；正式结果建议至少 5 个 seed，并在空闲机器上重复。',
    '- 这是端到端耗时：包含模型推理、工具编排、浏览器执行和本地通信。`stateReachedMs` 可用于单独观察写操作在网页状态上何时真正完成。',
    '- 常规延迟与阶段表只包含成功样本；必须同时看配对成功结果和失败惩罚指标。本报告也不能隔离模型服务端抖动。若置信区间较宽，应增加 seed/trial。',
    '',
  ]
  return lines.join('\n')
}

export async function readJsonl(path) {
  const text = await readFile(path, 'utf8')
  return text.split(/\r?\n/u).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${path}:${index + 1}: invalid JSON: ${error.message}`) }
  })
}

export async function writeReportForFile(inputPath, outputPath) {
  const records = await readJsonl(inputPath)
  const target = outputPath ?? inputPath.slice(0, -extname(inputPath).length) + '.report.md'
  await writeFile(target, renderReport(records, { sourceName: basename(inputPath) }))
  return target
}

async function latestResult() {
  const resultsRoot = join(benchmarkRoot, 'results')
  const candidates = (await readdir(resultsRoot)).filter((name) => name.endsWith('.jsonl')).sort().reverse()
  if (candidates.length === 0) throw new Error('benchmark/results 中没有 JSONL 结果，请先运行 node benchmark/run.mjs')
  return join(resultsRoot, candidates[0])
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] === undefined ? await latestResult() : resolve(process.argv[2])
  const output = await writeReportForFile(input)
  console.log(`report: ${output}`)
}
