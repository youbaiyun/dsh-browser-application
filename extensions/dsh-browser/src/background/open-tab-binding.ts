/**
 * Affinity binding for tabs created by `browser_open_tab`.
 *
 * Foreground opens (`active !== false`) follow the new tab; background opens
 * keep the visible tab and rebind only the controlled target so later tools
 * hit the new tab without activating it.
 *
 * @module
 */

import type { AffinityTab, TabAffinityController } from './tab-affinity.ts'

export interface BindOpenedTabOptions {
  /** When false, bind as controlled without following the visible tab. */
  active?: boolean
}

/**
 * Bind a newly opened tab into the affinity controller.
 *
 * @returns Whether the affinity controller accepted the bind.
 */
export function bindOpenedTabAffinity(
  affinity: TabAffinityController,
  tab: AffinityTab,
  options: BindOpenedTabOptions = {},
): boolean {
  return options.active === false
    ? affinity.rebindControlled(tab)
    : affinity.rebindActive(tab)
}
