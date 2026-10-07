/**
 * Pure state machine for binding browser tools to one user-visible tab.
 *
 * The controller deliberately separates Chrome event handling from the
 * affinity rules so transitions can be tested without a browser runtime.
 * A manual tab switch never silently changes the tool target: it creates a
 * handoff decision, and tool dispatch remains blocked until the user chooses.
 * `keep-always` is the one way out of that per-switch prompt: it pins the
 * controlled tab so later switches resolve straight to `background` instead of
 * asking again, and `ask-again` reverses it without disturbing the binding.
 * Pinning never widens what the tools may touch — the target is still exactly
 * the tab the user already approved — and any change of binding clears it.
 *
 * One extension connection owns exactly one controlled tab. The dsh side may
 * drive several conversations through that single binding; per-conversation
 * tabs were removed so the device can never hold a hidden second target.
 *
 * @module
 */

/** Minimal, control-strip-safe metadata for one Chrome tab. */
export interface AffinityTab {
  tabId: number
  windowId: number
  title: string
  url: string
}

export type TabAffinityStatus = 'unbound' | 'following' | 'handoff' | 'background' | 'lost'
export type TabAffinityDecision = 'keep' | 'follow' | 'keep-always' | 'ask-again'

/**
 * How a manual tab switch is resolved.
 *
 * `ask` raises the handoff prompt and blocks tool dispatch until it is answered;
 * `follow` moves the binding to whatever the user is now looking at; `keep`
 * holds the binding on the tab the tools already had. The last two exist because
 * a prompt on every switch is exhausting once the user knows what they want —
 * and answering the prompt with "don't ask again" writes that choice here, so
 * the preference outlives the browser session.
 *
 * `ask` stays the default: following the active tab can move the target off a
 * tab the model opened on purpose (`active: false`), so it is opt-in rather than
 * assumed.
 */
export type TabSwitchMode = 'ask' | 'follow' | 'keep'

/** Narrow an untrusted settings field to a switch mode. */
export function isTabSwitchMode(value: unknown): value is TabSwitchMode {
  return value === 'ask' || value === 'follow' || value === 'keep'
}

/** Narrow an untrusted control-strip message field to a decision. */
export function isTabAffinityDecision(value: unknown): value is TabAffinityDecision {
  return value === 'keep' || value === 'follow'
    || value === 'keep-always' || value === 'ask-again'
}

/** Serializable state sent from the service worker to every control strip. */
export interface TabAffinityState {
  revision: number
  status: TabAffinityStatus
  controlled: AffinityTab | null
  active: AffinityTab | null
  /** True once the user chose `keep-always`; tab switches stop prompting. */
  pinned: boolean
}

export type TabTargetResolution =
  | { kind: 'initial' }
  | { kind: 'target'; tab: AffinityTab }
  | { kind: 'handoff' }
  | { kind: 'lost' }

function sameTab(left: AffinityTab | null, right: AffinityTab | null): boolean {
  return left?.tabId === right?.tabId
    && left?.windowId === right?.windowId
    && left?.title === right?.title
    && left?.url === right?.url
}

/** Owns the controlled-tab lifecycle for one extension/bridge connection. */
export class TabAffinityController {
  private controlled: AffinityTab | null = null
  private active: AffinityTab | null = null
  private keptActiveTabId: number | null = null
  private pinned = false
  private switchMode: TabSwitchMode = 'ask'
  private hasBound = false
  private lost = false
  private revision = 0

  /**
   * Apply the persisted tab-switch preference.
   *
   * Switching to `follow` clears any pin and lets the existing active tab stand
   * as the target — {@link status} reports `following` from here on, so a tool
   * call resolves to what the user is looking at. The stored `controlled` record
   * is refreshed when the user next switches tabs, through `observeActive`.
   */
  setSwitchMode(mode: TabSwitchMode): boolean {
    if (mode === this.switchMode) return false
    this.switchMode = mode
    if (mode === 'follow') {
      this.pinned = false
      this.keptActiveTabId = null
    }
    this.revision += 1
    return true
  }

  /** The mode in force, for tests and for echoing back to a panel. */
  get mode(): TabSwitchMode {
    return this.switchMode
  }

  snapshot(): TabAffinityState {
    return {
      revision: this.revision,
      status: this.status(),
      controlled: this.controlled === null ? null : { ...this.controlled },
      active: this.active === null ? null : { ...this.active },
      pinned: this.pinned,
    }
  }

  /** Observe the active tab after a user tab/window focus change. */
  observeActive(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) {
      this.controlled = { ...tab }
      this.keptActiveTabId = null
    } else if (previousActive?.tabId !== tab.tabId) {
      this.keptActiveTabId = null
    }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Refresh title/URL metadata without interpreting it as a tab switch. */
  observeTab(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.active?.tabId === tab.tabId) this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) this.controlled = { ...tab }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Bind the first browser tool call to the then-active tab. */
  bindInitial(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.hasBound = true
    this.keptActiveTabId = null
    this.pinned = false
    this.revision += 1
    return true
  }

  /** Explicitly rebind to the active tab. */
  rebindActive(tab: AffinityTab): boolean {
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** Explicitly control an existing tab without changing the browser's active tab. */
  rebindControlled(tab: AffinityTab): boolean {
    this.controlled = { ...tab }
    this.keptActiveTabId = this.active !== null && this.active.tabId !== tab.tabId
      ? this.active.tabId
      : null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** Rehydrate a still-live controlled tab after an MV3 worker restart. */
  restoreControlled(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.controlled = { ...tab }
    this.hasBound = true
    this.revision += 1
    return true
  }

  /**
   * Rehydrate a `keep-always` choice after an MV3 worker restart.
   *
   * Only valid once a controlled tab exists, so a stale pin can never suppress
   * the handoff prompt for a binding the user has not approved.
   */
  restorePinned(): boolean {
    if (this.controlled === null || this.pinned) return false
    this.pinned = true
    this.revision += 1
    return true
  }

  /** Rehydrate the fail-closed state when the prior controlled tab was lost. */
  restoreLost(): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.hasBound = true
    this.lost = true
    this.revision += 1
    return true
  }

  /** Remove stale state when Chrome closes a tracked tab. */
  removeTab(tabId: number): boolean {
    if (this.controlled?.tabId !== tabId && this.active?.tabId !== tabId) return false
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === tabId) {
      this.controlled = null
      this.keptActiveTabId = null
      this.pinned = false
      this.hasBound = true
      this.lost = true
    }
    if (this.active?.tabId === tabId) this.active = null
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Transfer tracked identity when Chrome replaces a tab without a user switch. */
  replaceTab(removedTabId: number, addedTabId: number): boolean {
    if (removedTabId === addedTabId) return false
    if (this.controlled?.tabId !== removedTabId
      && this.active?.tabId !== removedTabId
      && this.keptActiveTabId !== removedTabId) {
      return false
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === removedTabId) {
      this.controlled = { ...this.controlled, tabId: addedTabId }
    }
    if (this.active?.tabId === removedTabId) {
      this.active = { ...this.active, tabId: addedTabId }
    }
    if (this.keptActiveTabId === removedTabId) this.keptActiveTabId = addedTabId
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Apply a control-strip choice only if it still describes the visible revision. */
  decide(decision: TabAffinityDecision, revision: number): boolean {
    if (revision !== this.revision) return false
    const currentStatus = this.status()
    if (decision === 'ask-again') {
      // Undo a pin in place. Dropping keptActiveTabId re-raises the prompt for
      // the switch the pin was suppressing, so control stays user-confirmed.
      if (!this.pinned) return false
      this.pinned = false
      this.keptActiveTabId = null
      this.revision += 1
      return true
    }
    if (decision === 'keep' || decision === 'keep-always') {
      if (currentStatus !== 'handoff' || this.active === null) return false
      this.keptActiveTabId = this.active.tabId
      if (decision === 'keep-always') this.pinned = true
      this.revision += 1
      return true
    }
    if (this.active === null || (currentStatus !== 'background' && currentStatus !== 'lost' && currentStatus !== 'handoff')) {
      return false
    }
    this.controlled = { ...this.active }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** Resolve whether a tool may run and, if so, which tab owns it. */
  resolveTarget(): TabTargetResolution {
    switch (this.status()) {
      case 'unbound': return { kind: 'initial' }
      case 'lost': return { kind: 'lost' }
      case 'handoff': return { kind: 'handoff' }
      case 'following':
        // In follow mode the target is the tab the user is looking at, which may
        // be newer than the `controlled` record — that record is refreshed when
        // the switch is observed, and this path must not wait for it.
        if (this.switchMode === 'follow' && this.active !== null) {
          return { kind: 'target', tab: { ...this.active } }
        }
        return { kind: 'target', tab: { ...this.controlled! } }
      case 'background':
        return { kind: 'target', tab: { ...this.controlled! } }
    }
  }

  tracks(tabId: number): boolean {
    return this.controlled?.tabId === tabId || this.active?.tabId === tabId
  }

  /** Final dispatch guard for async calls that began before a tab switch. */
  allowsTarget(tabId: number): boolean {
    const resolution = this.resolveTarget()
    return resolution.kind === 'target' && resolution.tab.tabId === tabId
  }

  private status(): TabAffinityStatus {
    if (this.controlled === null) return this.lost ? 'lost' : 'unbound'
    if (this.active?.tabId === this.controlled.tabId) return 'following'
    // The switch mode decides what a manual tab switch means, so the prompt is
    // only ever reached in `ask` mode.
    if (this.switchMode === 'follow') return 'following'
    if (this.switchMode === 'keep') return 'background'
    if (this.active !== null && !this.pinned && this.keptActiveTabId !== this.active.tabId) return 'handoff'
    return 'background'
  }

  private bumpIfChanged(
    previousActive: AffinityTab | null,
    previousControlled: AffinityTab | null,
    previousKept: number | null,
  ): boolean {
    const changed = !sameTab(previousActive, this.active)
      || !sameTab(previousControlled, this.controlled)
      || previousKept !== this.keptActiveTabId
    if (changed) this.revision += 1
    return changed
  }
}
