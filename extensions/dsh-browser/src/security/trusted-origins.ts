import type { ApprovalPrompt } from './approval.ts'

/**
 * Normalize an exact origin or a wildcard origin for persistent storage.
 * Bare wildcards are HTTPS aliases; explicit schemes and ports stay scoped.
 */
export function normalizeTrustedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const wildcard = normalizeWildcard(trimmed)
  if (wildcard !== undefined) return wildcard
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && !url.hostname.includes('*')
      ? url.origin
      : undefined
  } catch {
    return undefined
  }
}

/** Whether one concrete web origin is covered by an exact or wildcard entry. */
export function originMatchesTrusted(origin: string, trusted: Iterable<string>): boolean {
  let parsedOrigin: URL | undefined
  for (const entry of trusted) {
    if (entry === origin) return true
    const wildcard = parseWildcard(entry)
    if (wildcard === undefined) continue
    try {
      parsedOrigin ??= new URL(origin)
    } catch {
      return false
    }
    if (parsedOrigin.protocol !== wildcard.protocol || parsedOrigin.port !== wildcard.port) continue
    const host = parsedOrigin.hostname.toLowerCase()
    if (host === wildcard.hostname || host.endsWith(`.${wildcard.hostname}`)) return true
  }
  return false
}

/**
 * Skip an action prompt only when its full destination boundary is known.
 * Cross-origin browser_navigate names both origins; history and invalid URLs
 * deliberately remain untrusted because their destination is not represented.
 */
export function actionCoveredByTrustedOrigins(
  prompt: ApprovalPrompt,
  ...trustedCollections: Iterable<string>[]
): boolean {
  if (prompt.kind !== 'action' || prompt.origins.length === 0) return false
  const hasKnownBoundary = prompt.canTrust
    || (prompt.action === 'browser_navigate' && prompt.origins.length > 1)
    || (prompt.action === 'browser_open_tab' && prompt.origins.length === 1)
  if (!hasKnownBoundary) return false
  return prompt.origins.every((origin) =>
    trustedCollections.some((trusted) => originMatchesTrusted(origin, trusted)))
}

interface WildcardOrigin {
  protocol: 'http:' | 'https:'
  hostname: string
  port: string
}

function normalizeWildcard(value: string): string | undefined {
  const decodedStar = value.replace(/^((?:https?:\/\/)?)(?:\*|%2a)\./i, '$1*.')
  if (!/^(?:https?:\/\/)?\*\./i.test(decodedStar)) return undefined
  const candidate = /^https?:\/\//i.test(decodedStar) ? decodedStar : `https://${decodedStar}`
  const placeholder = candidate.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return `${url.protocol}//*.${hostname}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return undefined
  }
}

function parseWildcard(value: string): WildcardOrigin | undefined {
  if (!/^https?:\/\/\*\./i.test(value)) return undefined
  const placeholder = value.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return { protocol: url.protocol as 'http:' | 'https:', hostname, port: url.port }
  } catch {
    return undefined
  }
}

/**
 * Whether a wildcard's host part can be a registrable domain.
 *
 * Two properly formed labels are required, which is what the previous
 * Public-Suffix-List lookup actually enforced here: a single label (an
 * intranet host such as `wiki`) and an IP address may both be real hosts, so
 * `*.` must not be allowed to claim them. The suffix list itself is not
 * consulted — matching `*.co.uk` would need it, and Chrome hands `co.uk` to
 * its registry anyway, so a public suffix is not a domain anyone can control.
 * Skipping the lookup keeps a ~100 KB suffix trie out of the extension.
 */
function isDomainName(hostname: string): boolean {
  const labels = hostname.split('.')
  return labels.length >= 2
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}
