import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTools } from '../plugin/playwright-browser.mjs'

test('Playwright baseline exposes the canonical model-facing browser contract', () => {
  const tools = defineTools(async () => ({ text: 'ok' }))
  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_navigate',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_get_text',
    'browser_wait',
  ])
  assert.match(tools.find((tool) => tool.name === 'browser_snapshot').description, /untrusted data/u)
  assert.equal(tools.find((tool) => tool.name === 'browser_click').parameters.index.description, 'Element index from the browser_snapshot inventory.')
  assert.equal(tools.find((tool) => tool.name === 'browser_type').parameters.replace.description, 'When true, clear the existing value before entering text. Defaults to append.')
})
