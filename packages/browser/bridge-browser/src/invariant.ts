/**
 * Package-owned invariant companion for `@yuxianglin/dsh-bridge-browser`.
 * @module @yuxianglin/dsh-bridge-browser/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@yuxianglin/dsh-bridge-browser'

/** Cordis companion plugin name. */
export const name = 'bridge-browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge's connection registry and pending tool map
 * are instance-private (no published event stream to assert against), and the
 * wire contract is pinned by protocol.ts and covered by its unit tests. The
 * tools are plain ctx.tools registrations observed by dsh-tools' own
 * invariant.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
