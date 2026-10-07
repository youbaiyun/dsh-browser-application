import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, reserveOutputFile } from '../run.mjs'

test('CLI parses ranges and smoke overrides the task matrix', () => {
  const parsed = parseArgs(['--dry-run', '--seeds', '2-4', '--tasks', 'order_lookup,lazy_load'])
  assert.deepEqual(parsed.seeds, [2, 3, 4])
  assert.deepEqual(parsed.tasks, ['order_lookup', 'lazy_load'])
  assert.equal(parsed.dryRun, true)

  const smoke = parseArgs(['--smoke'])
  assert.deepEqual(smoke.tasks, ['contact_form'])
  assert.deepEqual(smoke.seeds, [1])
})

test('runner refuses to append a new benchmark to an existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-'))
  const output = join(root, 'results', 'benchmark.jsonl')
  try {
    await reserveOutputFile(output)
    await assert.rejects(reserveOutputFile(output), /output already exists/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
