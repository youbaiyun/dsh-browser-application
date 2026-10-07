// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  isTabAffinityDecision,
  isTabSwitchMode,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

/**
 * A controller bound to tab 1, now looking at `tabId`, in the mode that raises
 * the handoff prompt.
 *
 * `ask` is no longer the default — a prompt on every switch is what the user
 * asked to remove — so the tests about that prompt opt into it explicitly.
 */
function switchedTo(tabId: number): TabAffinityController {
  return switchedToIn('ask', tabId)
}

/** The same setup, with the switch mode named by the caller. */
function switchedToIn(mode: 'ask' | 'follow' | 'keep', tabId: number): TabAffinityController {
  const affinity = new TabAffinityController()
  affinity.setSwitchMode(mode)
  affinity.observeActive(tab(1))
  affinity.bindInitial(tab(1))
  affinity.observeActive(tab(tabId))
  return affinity
}

describe('TabAffinityController', () => {
  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    expect(affinity.snapshot()).toEqual({
      revision: 0,
      status: 'unbound',
      controlled: null,
      active: null,
      pinned: false,
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.observeActive(tab(1))).toBe(true)
    // Observing the active tab does not bind it: the first tool call does.
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 1 },
      active: { tabId: 1 },
      pinned: false,
    })

    // One connection owns exactly one controlled tab: no hidden second target.
    expect(affinity.bindInitial(tab(2))).toBe(false)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 1 } })

    expect(affinity.observeTab(tab(1, 'Updated title'))).toBe(true)
    expect(affinity.resolveTarget()).toMatchObject({
      kind: 'target',
      tab: { tabId: 1, title: 'Updated title' },
    })
    // Unchanged metadata is not a state change and must not burn a revision.
    expect(affinity.observeTab(tab(1, 'Updated title'))).toBe(false)

    // A snapshot is a broadcast copy: a reader cannot rewrite tracked state.
    const exposed = affinity.snapshot()
    exposed.controlled!.title = 'tampered'
    exposed.active!.url = 'https://tampered.example/'
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 1, title: 'Updated title' },
      active: { tabId: 1, url: 'https://example.com/1' },
    })
  })

  it('fails closed on a manual switch until the matching handoff is decided', () => {
    const affinity = switchedTo(2)
    const handoff = affinity.snapshot()

    expect(handoff).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 1 },
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.allowsTarget(1)).toBe(false)
    expect(affinity.allowsTarget(2)).toBe(false)
    expect(affinity.tracks(1)).toBe(true)
    expect(affinity.tracks(2)).toBe(true)

    // A decision that describes an older revision must not be applied.
    expect(affinity.decide('follow', handoff.revision - 1)).toBe(false)
    expect(affinity.snapshot().status).toBe('handoff')
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    expect(affinity.decide('follow', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('keeps operating the bound tab in the background after an explicit keep choice', () => {
    const affinity = switchedTo(2)

    expect(affinity.decide('keep', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 1 },
      active: { tabId: 2 },
      pinned: false,
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
    expect(affinity.allowsTarget(1)).toBe(true)

    // `keep` covers one switch only; the next manual switch asks again.
    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({ status: 'handoff', active: { tabId: 3 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.decide('keep', affinity.snapshot().revision - 1)).toBe(false)
    expect(affinity.snapshot().status).toBe('handoff')
  })

  it('stops prompting on later tab switches after keep-always', () => {
    const affinity = switchedTo(2)

    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
      active: { tabId: 2 },
    })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
    // Pinning never widens what the tools may touch.
    expect(affinity.allowsTarget(3)).toBe(false)

    // Returning to the controlled tab and leaving again must still not prompt.
    affinity.observeActive(tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: true })
    affinity.observeActive(tab(4))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('drops the keep-always pin whenever the binding changes', () => {
    const followed = switchedTo(2)
    followed.decide('keep-always', followed.snapshot().revision)
    followed.observeActive(tab(3))
    expect(followed.decide('follow', followed.snapshot().revision)).toBe(true)
    expect(followed.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 3 },
    })
    followed.observeActive(tab(5))
    expect(followed.snapshot().status).toBe('handoff')

    const rebound = switchedTo(2)
    rebound.decide('keep-always', rebound.snapshot().revision)
    expect(rebound.rebindActive(tab(2))).toBe(true)
    expect(rebound.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 2 },
    })

    const retargeted = switchedTo(2)
    retargeted.decide('keep-always', retargeted.snapshot().revision)
    expect(retargeted.rebindControlled(tab(7))).toBe(true)
    expect(retargeted.snapshot()).toMatchObject({
      status: 'background',
      pinned: false,
      controlled: { tabId: 7 },
      active: { tabId: 2 },
    })

    const closed = switchedTo(2)
    closed.decide('keep-always', closed.snapshot().revision)
    expect(closed.removeTab(1)).toBe(true)
    expect(closed.snapshot()).toMatchObject({ status: 'lost', pinned: false })
  })

  it('re-raises the prompt when the pin is undone, without rebinding', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))

    const pinned = affinity.snapshot()
    expect(affinity.decide('ask-again', pinned.revision - 1)).toBe(false)
    expect(affinity.decide('ask-again', pinned.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      pinned: false,
      controlled: { tabId: 1 },
      active: { tabId: 3 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    // Undoing a pin that is not set is a no-op rather than a state change.
    expect(affinity.decide('ask-again', affinity.snapshot().revision)).toBe(false)

    const neverPinned = switchedTo(2)
    expect(neverPinned.decide('ask-again', neverPinned.snapshot().revision)).toBe(false)
    expect(neverPinned.snapshot().status).toBe('handoff')
  })

  it('does not burn a revision or drop the pin when nothing tracked changed', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))
    const before = affinity.snapshot()

    // Re-observing the same visible tab is not a new decision point.
    expect(affinity.observeActive(tab(3))).toBe(false)
    expect(affinity.snapshot()).toEqual(before)

    // Metadata for an untracked tab is not a switch either.
    expect(affinity.observeTab(tab(8, 'Unrelated'))).toBe(false)
    expect(affinity.snapshot()).toEqual(before)
    expect(affinity.tracks(8)).toBe(false)

    // Refreshing the visible tab's own metadata is reported, and the pin holds.
    expect(affinity.observeActive(tab(3, 'Tab 3 reloaded'))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
      active: { tabId: 3, title: 'Tab 3 reloaded' },
    })
  })

  it('rejects a keep-always pin that has no controlled tab behind it', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    expect(unbound.restorePinned()).toBe(false)
    expect(unbound.snapshot().pinned).toBe(false)

    const restored = new TabAffinityController()
    restored.setSwitchMode('ask')
    expect(restored.restoreControlled(tab(1))).toBe(true)
    expect(restored.restorePinned()).toBe(true)
    restored.observeActive(tab(2))
    expect(restored.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
    })
    expect(restored.restorePinned()).toBe(false)

    // A pin can never be restored for a binding the user has not approved.
    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    expect(lost.restorePinned()).toBe(false)
    expect(lost.snapshot().pinned).toBe(false)
  })

  it('supports an explicit rebindActive that clears a pending handoff', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 2 },
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })

    // It is also the explicit way back from the fail-closed lost state.
    expect(affinity.removeTab(2)).toBe(true)
    expect(affinity.snapshot().status).toBe('lost')
    expect(affinity.rebindActive(tab(9))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.allowsTarget(9)).toBe(true)
  })

  it('rebinds control to a listed background tab without changing the active tab', () => {
    const affinity = new TabAffinityController()
    // The prompt is what makes "leaving the tab re-raises the prompt" observable,
    // so this test runs in the mode that has one.
    affinity.setSwitchMode('ask')
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))

    expect(affinity.rebindControlled(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 2 },
      active: { tabId: 1 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)

    // Leaving the newly controlled tab re-raises the prompt for the visible tab.
    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 2 },
      active: { tabId: 3 },
    })
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.removeTab(9)).toBe(false)
    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'lost',
      controlled: null,
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.allowsTarget(2)).toBe(false)
    expect(affinity.bindInitial(tab(2))).toBe(false)

    // Only an explicit decision moves the tools onto the visible tab.
    const lost = affinity.snapshot()
    expect(affinity.decide('follow', lost.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 1)).toBe(false)
    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('clears the handoff if the user returns to the controlled tab', () => {
    const affinity = switchedTo(2)
    const handoff = affinity.snapshot()

    affinity.observeActive(tab(1, 'Tab 1 again'))
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 1, title: 'Tab 1 again' },
      active: { tabId: 1, title: 'Tab 1 again' },
    })
    expect(affinity.snapshot().revision).toBeGreaterThan(handoff.revision)
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    restored.setSwitchMode('ask')
    expect(restored.restoreControlled(tab(4))).toBe(true)
    expect(restored.restoreControlled(tab(5))).toBe(false)
    expect(restored.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 4 } })
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 4 },
      active: { tabId: 5 },
    })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    expect(lost.restoreLost()).toBe(false)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
    expect(lost.restoreControlled(tab(5))).toBe(false)
    expect(lost.snapshot()).toMatchObject({ status: 'lost', controlled: null })
  })

  it('refuses a follow decision unless a handoff or lost binding is waiting', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    // The first bind is automatic and fail-closed: follow alone never binds.
    expect(unbound.decide('follow', unbound.snapshot().revision)).toBe(false)
    expect(unbound.snapshot()).toMatchObject({ status: 'unbound', controlled: null })
    expect(unbound.resolveTarget()).toEqual({ kind: 'initial' })

    const following = new TabAffinityController()
    following.observeActive(tab(1))
    following.bindInitial(tab(1))
    expect(following.decide('follow', following.snapshot().revision)).toBe(false)
    expect(following.decide('keep', following.snapshot().revision)).toBe(false)
    expect(following.decide('keep-always', following.snapshot().revision)).toBe(false)
    expect(following.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 1 },
    })
  })
})

describe('isTabAffinityDecision', () => {
  it('accepts only the four control-strip decisions', () => {
    for (const value of ['keep', 'follow', 'keep-always', 'ask-again']) {
      expect(isTabAffinityDecision(value)).toBe(true)
    }
    for (const value of ['KEEP', 'follow ', '', 'deny', null, undefined, 1, {}]) {
      expect(isTabAffinityDecision(value)).toBe(false)
    }
  })
})

describe('tab switch mode', () => {
  it('follows the user by default, with no prompt', () => {
    const affinity = switchedToIn('follow', 2)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })
    // The tool target is the page the user is looking at, and it resolves with
    // no decision from anyone.
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('stays on the bound tab in keep mode, with no prompt', () => {
    const affinity = switchedToIn('keep', 2)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 } })
    // Dispatch still goes to the tab the user originally approved.
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.allowsTarget(1)).toBe(true)
    expect(affinity.allowsTarget(2)).toBe(false)
  })

  it('asks in ask mode, blocking dispatch until the user answers', () => {
    const affinity = switchedTo(2)
    expect(affinity.snapshot()).toMatchObject({ status: 'handoff' })
    // Fail closed: nothing may run while the question is open.
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.allowsTarget(1)).toBe(false)
    expect(affinity.allowsTarget(2)).toBe(false)
  })

  it('changes the mode in place and reports whether anything moved', () => {
    const affinity = switchedToIn('keep', 2)
    expect(affinity.mode).toBe('keep')
    // Already in the requested mode.
    expect(affinity.setSwitchMode('keep')).toBe(false)
    expect(affinity.setSwitchMode('follow')).toBe(true)
    expect(affinity.mode).toBe('follow')
    expect(affinity.snapshot()).toMatchObject({ status: 'following' })
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
  })

  it('clears a pin when the mode becomes follow', () => {
    // A pin is an answer to one prompt; the setting is what the user wants, and
    // the setting wins.
    const affinity = switchedTo(2)
    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })

    affinity.setSwitchMode('follow')
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: false })
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
  })

  it('returns to the original tab when the mode becomes keep', () => {
    const affinity = switchedToIn('follow', 2)
    affinity.setSwitchMode('keep')
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(1) })
  })

  it('models the switch mode the same way a decision does', () => {
    // `keep` and a `keep-always` decision must be indistinguishable to dispatch.
    const byMode = switchedToIn('keep', 2)
    const byDecision = switchedTo(2)
    byDecision.decide('keep-always', byDecision.snapshot().revision)
    expect(byMode.resolveTarget()).toEqual(byDecision.resolveTarget())
    expect(byMode.snapshot().status).toBe(byDecision.snapshot().status)
  })
})

describe('isTabSwitchMode', () => {
  it('accepts only the three modes', () => {
    for (const value of ['ask', 'follow', 'keep']) expect(isTabSwitchMode(value)).toBe(true)
    for (const value of ['ASK', 'always', '', null, undefined, 0, {}]) {
      expect(isTabSwitchMode(value)).toBe(false)
    }
  })
})
