// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { FocusedWindowTracker } from '../src/background/focused-window.ts'

describe('FocusedWindowTracker', () => {
  it('accepts activations only from the last-focused window', () => {
    const focused = new FocusedWindowTracker()
    const revision = focused.beginQuery()

    expect(focused.acceptActivation(1)).toBeNull()
    expect(focused.commitQuery(1, revision)).toBe(true)
    expect(focused.acceptActivation(2)).toBeNull()

    const activation = focused.acceptActivation(1)
    expect(activation).not.toBeNull()
    expect(focused.isCurrent(activation!)).toBe(true)

    focused.markFocused(2)
    expect(focused.isCurrent(activation!)).toBe(false)
    expect(focused.acceptActivation(1)).toBeNull()
    expect(focused.acceptActivation(2)).not.toBeNull()
  })

  it('does not let an older last-focused query overwrite a focus event', () => {
    const focused = new FocusedWindowTracker()
    const staleRevision = focused.beginQuery()

    focused.markFocused(2)
    expect(focused.commitQuery(1, staleRevision)).toBe(false)
    expect(focused.acceptActivation(1)).toBeNull()
    expect(focused.acceptActivation(2)).not.toBeNull()
  })

  it('lets newer queries and activations invalidate stale async results', () => {
    const focused = new FocusedWindowTracker()
    const olderQuery = focused.beginQuery()
    const newerQuery = focused.beginQuery()

    expect(focused.commitQuery(1, olderQuery)).toBe(false)
    expect(focused.commitQuery(1, newerQuery)).toBe(true)

    const activation = focused.acceptActivation(1)
    expect(activation).not.toBeNull()
    expect(focused.commitQuery(1, newerQuery)).toBe(false)

    const latestQuery = focused.beginQuery()
    expect(focused.isCurrent(activation!)).toBe(false)
    expect(focused.commitQuery(1, latestQuery)).toBe(true)
  })
})
