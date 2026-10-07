// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WAIT_MAX_BUDGET_MS, runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * The two capabilities whose *schema* existed long before their implementation:
 * filling a `<select>` or a checkbox/radio through `browser_type`, and waiting on
 * a `browser_wait` condition.
 *
 * Both are advertised to the model in `packages/bridge/src/tools.ts`, so a model
 * that follows the description reaches for them. Until these tests, the select
 * case threw `is not editable`, the checkbox branch wrote into `.value`, and a
 * wait condition was silently ignored — success reported for something that never
 * happened.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function append<T extends HTMLElement>(element: T): T {
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('browser_type on a <select>', () => {
  function select(): HTMLSelectElement {
    const el = document.createElement('select')
    for (const [value, label] of [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      el.append(option)
    }
    return append(el)
  }

  it('selects by option value', async () => {
    const el = select()
    const result = await runAction('browser_type', { index: 1, text: 'b' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('b')
    expect(result.text).toContain('Beta')
  })

  it('selects by visible label when no value matches', async () => {
    const el = select()
    await runAction('browser_type', { index: 1, text: 'Gamma' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('c')
  })

  it('selects by 1-based position as a last resort', async () => {
    const el = select()
    await runAction('browser_type', { index: 1, text: '3' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('c')
  })

  it('fires the change event the page listens for', async () => {
    const el = select()
    const seen: string[] = []
    el.addEventListener('change', () => seen.push('change'))
    await runAction('browser_type', { index: 1, text: 'a' }, { ids: idsFor(el), budget: BUDGET })
    expect(seen).toContain('change')
  })

  it('lists the available options when nothing matches, instead of a dead end', async () => {
    const el = select()
    // The labels are what make the list usable: `1. a` alone says nothing.
    await expect(runAction('browser_type', { index: 1, text: 'nope' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toThrow(/no option matching "nope".*Alpha.*Gamma/su)
  })
})

describe('browser_type on a checkbox or radio', () => {
  it('checks a checkbox from "true" and reports the state', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    const result = await runAction('browser_type', { index: 2, text: 'true' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.checked).toBe(true)
    expect(result.text).toContain('Checked')
  })

  it('unchecks from "false" without touching the value property', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    el.checked = true
    await runAction('browser_type', { index: 2, text: 'false' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.checked).toBe(false)
  })

  it('moves the selection within a radio group', async () => {
    const first = append(document.createElement('input'))
    first.type = 'radio'
    first.name = 'pick'
    first.checked = true
    const second = append(document.createElement('input'))
    second.type = 'radio'
    second.name = 'pick'

    await runAction('browser_type', { index: 2, text: 'true' }, { ids: idsFor(second), budget: BUDGET })
    expect(second.checked).toBe(true)
    expect(first.checked).toBe(false)
  })

  it('rejects a value that is not a boolean, and says what to pass', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    await expect(runAction('browser_type', { index: 2, text: 'maybe' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toThrow(/pass true or false/u)
  })
})

describe('browser_wait conditions', () => {
  const context = (): { ids: ElementIds; budget: typeof BUDGET } => ({ ids: idsFor(document.body), budget: BUDGET })

  it('returns as soon as the selector matches', async () => {
    const target = append(document.createElement('div'))
    target.id = 'ready'
    const result = await runAction('browser_wait', { selector: '#ready' }, context())
    expect(result.text).toContain('#ready')
  })

  it('waits for a selector that appears later', async () => {
    setTimeout(() => {
      const late = document.createElement('span')
      late.className = 'late'
      document.body.append(late)
    }, 250)
    const result = await runAction('browser_wait', { selector: '.late' }, context())
    expect(result.text).toContain('.late')
  })

  it('fails with the timeout code when the selector never appears', async () => {
    // The whole point of a condition: "it never showed up" must not be reported
    // as success, or the model waits forever on a page that will not change.
    await expect(runAction('browser_wait', { selector: '#never', ms: 300 }, context()))
      .rejects.toMatchObject({ code: 'timeout' })
  })

  it('waits for text and fails when it never appears', async () => {
    const target = append(document.createElement('p'))
    target.textContent = 'loaded'
    const result = await runAction('browser_wait', { text: 'loaded' }, context())
    expect(result.text).toContain('loaded')

    await expect(runAction('browser_wait', { text: 'absent', ms: 300 }, context()))
      .rejects.toMatchObject({ code: 'timeout' })
  })

  it('matches text after the same whitespace collapse the page text gets', async () => {
    // `pageText` turns every whitespace run into a single space, so a needle with a
    // newline or a double space in it could never match without the same treatment.
    const target = append(document.createElement('p'))
    target.textContent = 'Order confirmed'
    const result = await runAction('browser_wait', { text: 'Order\n  confirmed', ms: 2_000 }, context())
    expect(result.text).toContain('Order confirmed')
  })

  it('bounds the caller-supplied budget, so a wait cannot hold the slot forever', () => {
    // Asserted on the constant rather than by waiting: an `ms` of `1e999` parses to
    // Infinity through JSON, and the clamp is what stops that becoming a poll that
    // never ends. Exercising it for real would mean a 60-second test.
    expect(WAIT_MAX_BUDGET_MS).toBe(60_000)
    expect(WAIT_MAX_BUDGET_MS).toBeLessThan(90_000)
  })

  it('keeps working as a plain delay when no condition is given', async () => {
    const started = Date.now()
    const result = await runAction('browser_wait', { ms: 200 }, context())
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(result.text).toContain('stable')
  })
})
