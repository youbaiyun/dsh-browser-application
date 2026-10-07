import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { startBenchmarkSite } from './site/server.mjs'
import { startDshBackend } from './lib/dsh-process.mjs'
import { startExtensionBrowser } from './lib/extension-browser.mjs'
import { runOne } from './lib/run-one.mjs'
import { BENCHMARK_SUITE_VERSION, makeTaskInstance, TASK_CATALOG, TASK_IDS } from './lib/tasks.mjs'
import { writeReportForFile } from './report.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(benchmarkRoot, '..')
const taskMetadata = new Map(TASK_CATALOG.map((task) => [task.id, task]))

function valueAfter(args, index, flag) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parsePositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`)
  return number
}

function parseSeeds(value) {
  const values = []
  for (const part of value.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/u)
    if (range !== null) {
      const start = parsePositiveInteger(range[1], '--seeds')
      const end = parsePositiveInteger(range[2], '--seeds')
      if (end < start) throw new Error('--seeds range must be ascending')
      for (let seed = start; seed <= end; seed += 1) values.push(seed)
    } else values.push(parsePositiveInteger(part, '--seeds'))
  }
  return [...new Set(values)]
}

export function parseArgs(args) {
  const options = {
    backends: ['playwright', 'extension'],
    tasks: [...TASK_IDS],
    seeds: [1, 2, 3, 4, 5],
    trials: 1,
    timeoutMs: 120_000,
    sitePort: 4173,
    playwrightPort: 3090,
    extensionPort: 3091,
    dryRun: false,
    smoke: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--smoke') options.smoke = true
    else if (flag === '--backend') {
      const value = valueAfter(args, index, flag)
      index += 1
      options.backends = value === 'both' ? ['playwright', 'extension'] : [value]
      if (options.backends.some((backend) => !['playwright', 'extension'].includes(backend))) throw new Error('--backend must be both, playwright, or extension')
    } else if (flag === '--tasks') {
      options.tasks = valueAfter(args, index, flag).split(',').filter(Boolean)
      index += 1
    } else if (flag === '--seeds') {
      options.seeds = parseSeeds(valueAfter(args, index, flag))
      index += 1
    } else if (flag === '--trials') {
      options.trials = parsePositiveInteger(valueAfter(args, index, flag), flag)
      index += 1
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(valueAfter(args, index, flag), flag)
      index += 1
    } else if (flag === '--site-port' || flag === '--playwright-port' || flag === '--extension-port') {
      const key = flag.slice(2).replace(/-([a-z])/gu, (_match, char) => char.toUpperCase())
      options[key] = parsePositiveInteger(valueAfter(args, index, flag), flag)
      index += 1
    } else if (flag === '--provider' || flag === '--model' || flag === '--reasoning-effort' || flag === '--output') {
      const key = flag.slice(2).replace(/-([a-z])/gu, (_match, char) => char.toUpperCase())
      options[key] = valueAfter(args, index, flag)
      index += 1
    } else throw new Error(`unknown option: ${flag}`)
  }
  const invalidTasks = options.tasks.filter((task) => !TASK_IDS.includes(task))
  if (invalidTasks.length > 0) throw new Error(`unknown tasks: ${invalidTasks.join(', ')}`)
  if ((options.provider === undefined) !== (options.model === undefined)) throw new Error('--provider and --model must be supplied together')
  if (options.smoke) {
    options.tasks = ['contact_form']
    options.seeds = [1]
    options.trials = 1
  }
  return options
}

function usage() {
  return `DSH Browser benchmark\n\nUsage: node benchmark/run.mjs [options]\n\n  --smoke                 Run one paired form task\n  --dry-run               Print the matrix without starting DSH or a model\n  --backend <both|playwright|extension>\n  --tasks <id,id>         Default: all six tasks\n  --seeds <1-5|1,2,3>     Default: 1-5\n  --trials <n>            Default: 1\n  --timeout-ms <n>        Per-run timeout, default: 120000\n  --provider <id> --model <id> [--reasoning-effort <id>]\n  --output <path>         Must stay inside benchmark/; default: results/<timestamp>.jsonl`
}

function pairOrder(taskId, seed, trial, backends) {
  if (backends.length !== 2) return backends
  let hash = 0
  for (const char of `${taskId}:${seed}:${trial}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0
  return hash % 2 === 0 ? backends : [...backends].reverse()
}

function resultPath(option, benchmarkId) {
  const target = option === undefined
    ? join(benchmarkRoot, 'results', `${benchmarkId}.jsonl`)
    : resolve(benchmarkRoot, option)
  const relativePath = relative(benchmarkRoot, target)
  if (relativePath.startsWith('..') || relativePath === '') throw new Error('--output must resolve to a file inside benchmark/')
  return target
}

async function packageVersion() {
  const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  return rootPackage.dependencies?.['@deepseek-ai/dsh'] ?? 'unknown'
}

export async function reserveOutputFile(output) {
  await mkdir(dirname(output), { recursive: true })
  let handle
  try {
    handle = await open(output, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`benchmark output already exists; choose a new --output path: ${output}`)
    }
    throw error
  } finally {
    await handle?.close()
  }
}

export async function runBenchmark(options) {
  const total = options.tasks.length * options.seeds.length * options.trials * options.backends.length
  const benchmarkId = new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')
  const output = resultPath(options.output, benchmarkId)
  if (options.dryRun) {
    return { dryRun: true, total, output, options }
  }
  await reserveOutputFile(output)
  const runtimeRoot = join(benchmarkRoot, 'results', 'runtime', benchmarkId)
  await mkdir(runtimeRoot, { recursive: true })
  const modelSelection = options.provider === undefined ? undefined : {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  }
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dsh: await packageVersion(),
  }
  const resources = []
  const backends = new Map()
  let extensionBrowser
  let site
  let completed = 0
  let stopping = false
  const close = async () => {
    if (stopping) return
    stopping = true
    await extensionBrowser?.close().catch(() => undefined)
    for (const resource of [...resources].reverse()) await resource.close().catch(() => undefined)
  }
  const interrupt = () => { void close().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    site = await startBenchmarkSite({ port: options.sitePort })
    resources.push(site)
    for (const name of options.backends) {
      const port = name === 'playwright' ? options.playwrightPort : options.extensionPort
      const backend = await startDshBackend({
        backend: name,
        port,
        repoRoot,
        benchmarkRoot,
        runtimeRoot,
        startUrl: `${site.origin}/health`,
      })
      resources.push(backend)
      backends.set(name, backend)
    }
    if (options.backends.includes('extension')) {
      extensionBrowser = await startExtensionBrowser({
        repoRoot,
        benchmarkRoot,
        bridgeUrl: `ws://127.0.0.1:${options.extensionPort}/ext/bridge`,
        trustedOrigin: site.origin,
      })
    }
    for (let trial = 1; trial <= options.trials; trial += 1) {
      for (const taskId of options.tasks) {
        for (const seed of options.seeds) {
          const pairId = `${taskId}:seed-${seed}:trial-${trial}`
          const order = pairOrder(taskId, seed, trial, options.backends)
          for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
            const backendName = order[orderIndex]
            const runId = `${benchmarkId}:${pairId}:${backendName}`
            const instance = makeTaskInstance(taskId, seed, runId, site.origin)
            const task = taskMetadata.get(taskId)
            let record
            try {
              record = await runOne({
                backend: backends.get(backendName),
                extensionBrowser,
                instance,
                siteOrigin: site.origin,
                workspace: join(benchmarkRoot, 'workspace'),
                timeoutMs: options.timeoutMs,
                modelSelection,
                metadata: {
                  benchmarkId,
                  benchmarkSuiteVersion: BENCHMARK_SUITE_VERSION,
                  pairId,
                  pairOrder: orderIndex + 1,
                  trial,
                  taskName: task.name,
                  category: task.category,
                  environment,
                },
              })
            } catch (error) {
              record = {
                schemaVersion: 1,
                benchmarkId,
                benchmarkSuiteVersion: BENCHMARK_SUITE_VERSION,
                pairId,
                pairOrder: orderIndex + 1,
                trial,
                backend: backendName,
                taskId,
                taskName: task.name,
                category: task.category,
                seed,
                runId,
                timeoutMs: options.timeoutMs,
                startedAt: new Date().toISOString(),
                success: false,
                validationReason: `runner error: ${error instanceof Error ? error.message : String(error)}`,
                infrastructureError: error instanceof Error ? error.stack : String(error),
                environment,
              }
            }
            await appendFile(output, `${JSON.stringify(record)}\n`)
            completed += 1
            console.log(`[${completed}/${total}] ${backendName} ${taskId} seed=${seed} ${record.success ? 'PASS' : 'FAIL'} ${record.timings?.completionMs ?? '—'}ms`)
          }
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await close()
  }
  const report = await writeReportForFile(output)
  return { dryRun: false, total, completed, output, report }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) console.log(usage())
    else {
      const result = await runBenchmark(options)
      if (result.dryRun) {
        console.log(`dry run: ${result.total} runs`)
        console.log(JSON.stringify(result.options, null, 2))
        console.log(`output: ${result.output}`)
      } else {
        console.log(`results: ${result.output}`)
        console.log(`report: ${result.report}`)
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  }
}
