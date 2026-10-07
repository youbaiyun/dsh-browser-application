import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTaskInstance, stateReached, TASK_IDS, validateTask } from '../lib/tasks.mjs'

test('all catalog tasks build deterministic seeded instances', () => {
  for (const taskId of TASK_IDS) {
    const first = makeTaskInstance(taskId, 3, 'run-a', 'http://127.0.0.1:4173')
    const again = makeTaskInstance(taskId, 3, 'run-a', 'http://127.0.0.1:4173')
    assert.deepEqual(first, again)
    assert.match(first.prompt, /browser_\*/u)
    assert.equal(first.seed, 3)
  }
})

test('state and answer validators reject incorrect results and forbidden tools', () => {
  const instance = makeTaskInstance('notification_toggle', 1, 'state-run', 'http://127.0.0.1:4173')
  const correct = { notificationSaved: true, emailNotifications: true, extra: 'allowed' }
  assert.equal(stateReached(instance, correct), true)
  assert.equal(validateTask(instance, correct, '', ['browser_snapshot', 'browser_click']).success, true)
  assert.equal(validateTask(instance, correct, '', ['exec_command']).success, false)
  assert.equal(validateTask(instance, { notificationSaved: true, emailNotifications: false }, '', []).success, false)
})

test('answer validators normalize lightweight markdown and whitespace', () => {
  const instance = makeTaskInstance('order_lookup', 2, 'answer-run', 'http://127.0.0.1:4173')
  assert.equal(validateTask(instance, {}, `**${instance.expected.value}**`, ['browser_snapshot']).success, true)
  assert.equal(validateTask(instance, {}, '¥0.00', ['browser_snapshot']).success, false)
})

test('inventory validation measures the unique filtered product, not a seed suffix', () => {
  const instance = makeTaskInstance('inventory_filter', 1, 'inventory-run', 'http://127.0.0.1:4173')
  const state = { filterApplied: true, filter: instance.page.filter }
  const target = instance.page.products.find((product) => product.sku === `SKU-${instance.page.filter.sku}`)

  assert.equal(instance.expected.value, target.name)
  assert.doesNotMatch(instance.expected.value, /\s1$/u)
  assert.equal(validateTask(instance, state, `${target.name}（${target.sku}，¥${(target.cents / 100).toFixed(2)}）`, ['browser_snapshot']).success, true)
  assert.equal(validateTask(instance, state, '其他商品', ['browser_snapshot']).success, false)
})
