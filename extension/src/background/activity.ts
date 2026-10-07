/**
 * The activity line the panel shows for one tool call.
 *
 * Pure formatting, kept out of the worker entry point so it can be asserted
 * without standing up a `chrome` API: it turns a call and its answer into the
 * single line the activity list renders.
 *
 * @module
 */

import type { ToolAnswer, ToolCall } from './tools.ts'
/**
 * Keep one readable line per call even when the tool never needed an approval.
 *
 * The line carries the **outcome**, not just the attempt. "browser_navigate
 * https://www.bilibili.com" says what was asked for but not whether it happened,
 * which left the reader unable to tell a finished step from a pending one — the
 * list looked like the same request repeated. The tools already answer with a
 * one-line `text` describing what they did, so that line is what is shown.
 *
 * Deliberately never echoes typed text (a `browser_type` value may be a
 * password or a token) and reduces a URL to its origin (paths carry session
 * ids, invite codes, and search terms). The control strip is local, but page
 * input should not accumulate in any long-lived list. That is also why a
 * multi-line result — a snapshot — is reduced to a summary rather than quoted.
 */
export function activitySummary(call: ToolCall, answer: ToolAnswer): string {
  const target = activityTarget(call)
  const head = target === '' ? call.name : `${call.name} ${target}`
  if (!answer.ok) return `${head} · ${answer.error?.message ?? 'failed'}`
  if (call.name === 'browser_type') {
    const length = typeof call.args.text === 'string' ? call.args.text.length : 0
    return `${head} (${length} chars)`
  }
  const outcome = activityOutcome(answer.result)
  return outcome === undefined ? head : `${head} ✓ ${outcome}`
}

/**
 * One short, single-line description of what a successful call actually did.
 *
 * Every tool answers with `{ text }` (the content-script actions and the tab
 * tools alike), so the **first line** of that text is the outcome. A first line
 * that is too long to be an outcome is page content that happens to start the
 * result, so it is dropped rather than truncated into the list.
 */
export function activityOutcome(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const { text, tabs, snapshot } = result as { text?: unknown; tabs?: unknown; snapshot?: unknown }
  if (Array.isArray(tabs)) return `${String(tabs.length)} tabs listed`
  if (typeof text !== 'string') return snapshot === undefined ? undefined : 'snapshot captured'
  // Read-side results are wrapped in the untrusted-content boundary, whose first
  // lines are the security notice and the nonce-bearing tag — neither is an
  // outcome. `browser_list_tabs` puts a tab record inside that wrapper, so its
  // size is reported rather than its opening marker.
  const inner = payloadBetweenMarkers(text)
  if (inner !== undefined) {
    const listed = countTabs(inner)
    // A wrapped payload this formatter cannot read is page content, and quoting
    // its opening brace would be worse than showing nothing at all.
    return listed === undefined ? undefined : `${String(listed)} tabs listed`
  }
  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? ''
  // A fragment of the trust notice is not an outcome either: it appears when a
  // wrapped payload was truncated away to nothing.
  if (firstLine === '' || firstLine.length > 90 || firstLine.startsWith('Security:')) return undefined
  return firstLine
}

/** The body between the untrusted-content markers, or undefined when unwrapped. */
function payloadBetweenMarkers(text: string): string | undefined {
  const open = /<UNTRUSTED_PAGE_CONTENT[^>]*>\n?/u.exec(text)
  if (open === null) return undefined
  const rest = text.slice(open.index + open[0].length)
  const close = rest.indexOf('\n</UNTRUSTED_PAGE_CONTENT')
  return (close === -1 ? rest : rest.slice(0, close)).trim()
}

/** How many tab records a `browser_list_tabs` payload names, when it is that shape. */
function countTabs(payload: string): number | undefined {
  if (!payload.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const listed = (parsed as { tabs?: unknown }).tabs
    return Array.isArray(listed) ? listed.length : undefined
  } catch {
    return undefined
  }
}

/** The safe, non-secret part of a call's arguments for the activity list. */
function activityTarget(call: ToolCall): string {
  const url = typeof call.args.url === 'string' ? call.args.url : ''
  if (url !== '') {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }
  const index = typeof call.args.index === 'number' ? call.args.index : undefined
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0 ? ` frame=${call.args.frame}` : ''
  if (index !== undefined) return `[${index}]${frame}`
  const key = typeof call.args.key === 'string' ? call.args.key : ''
  if (key !== '') return `${key}${frame}`
  const direction = typeof call.args.direction === 'string' ? call.args.direction : ''
  return direction === '' ? '' : `${direction}${frame}`
}

