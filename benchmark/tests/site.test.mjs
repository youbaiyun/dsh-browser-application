import test from 'node:test'
import assert from 'node:assert/strict'
import { startBenchmarkSite } from '../site/server.mjs'

test('benchmark site serves tasks and records externally verifiable state', async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  context.after(() => site.close())
  const runId = 'site-test-run'
  const page = await fetch(`${site.origin}/task/contact_form?seed=1&run=${runId}`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /联系信息/u)

  const action = await fetch(`${site.origin}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      taskId: 'contact_form',
      action: 'submit-contact',
      payload: { name: '陈然', email: 'benchmark+1@example.com', city: '杭州' },
    }),
  })
  assert.equal(action.status, 200)
  const state = await (await fetch(`${site.origin}/api/state?run=${runId}`)).json()
  assert.deepEqual(state.form, { name: '陈然', email: 'benchmark+1@example.com', city: '杭州' })
  assert.equal(state.formSubmitted, true)
})
