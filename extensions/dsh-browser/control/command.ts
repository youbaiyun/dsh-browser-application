/**
 * Input parsing for the bottom composer.
 *
 * The composer accepts two very different things on the same line:
 *
 *  - a **browser command**, which the extension executes itself (`browser_click
 *    {"index":3}`), and
 *  - an **instruction for the model**, which is forwarded to the desktop dsh app.
 *
 * Misreading one as the other is the only dangerous failure here, so the rule is
 * deliberately conservative: a line is a command only when it names a real tool
 * or is unambiguously a URL. Everything else is a prompt for the model.
 *
 * @module
 */

import { BROWSER_TOOL_NAMES as TOOL_NAMES } from '../src/background/tools.ts'

/**
 * The tool surface, re-exported for the composer.
 *
 * This list is imported rather than duplicated on purpose: the background
 * rejects any typed command whose name is not in its own registry, so a second
 * copy here could offer the user a command that is guaranteed to fail.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = TOOL_NAMES

/** One tool name the composer may dispatch. */
export type BrowserToolName = string

/**
 * Bare words a person actually types, mapped onto tool names.
 *
 * Only unambiguous read/positional actions are aliased. Nothing here changes
 * page state except `goto`/`open`, and both of those need a URL anyway.
 */
const SHORTHANDS: Readonly<Record<string, BrowserToolName>> = {
  snapshot: 'browser_snapshot',
  read: 'browser_get_text',
  text: 'browser_get_text',
  click: 'browser_click',
  type: 'browser_type',
  fill: 'browser_type',
  press: 'browser_press',
  key: 'browser_press',
  scroll: 'browser_scroll',
  wait: 'browser_wait',
  tabs: 'browser_list_tabs',
  back: 'browser_back',
  forward: 'browser_forward',
  reload: 'browser_reload',
}

export type InputIntent =
  /** The user typed a browser command; run it here. */
  | { kind: 'command'; name: BrowserToolName; args: Record<string, unknown>; echo: string }
  /**
   * The user declared "open this and show me".
   *
   * Unlike a command, this is not one tool call: the extension opens the tab,
   * brings it to the front, binds it as the controlled tab, and opens the panel
   * itself, in that order, with no model involvement. That is what makes
   * "so I can watch it" a guarantee rather than a request the model may skip.
   */
  | { kind: 'open'; url: string; options: OpenOptions; echo: string }
  /** The user typed an instruction; forward it to the model. */
  | { kind: 'prompt'; text: string }

/** How an `@open` should behave while it runs. */
export interface OpenOptions {
  /** Delay between the steps, so a person can follow what is happening. */
  pace: 'fast' | 'normal' | 'slow'
  /** Whether the opened tab becomes the tab the browser tools act on. */
  pin: boolean
}

/** Milliseconds to pause between `@open` steps, by pace. */
export const OPEN_PACE_MS: Record<OpenOptions['pace'], number> = {
  fast: 0,
  normal: 350,
  slow: 1_200,
}

/** The default formula options, used when a key is omitted. */
export const OPEN_DEFAULTS: OpenOptions = { pace: 'normal', pin: true }

/** Accepted spellings of the directive. */
const OPEN_DIRECTIVES = new Set(['open', 'show', 'watch'])

const PACES = new Set<OpenOptions['pace']>(['fast', 'normal', 'slow'])

/** A truthy/falsy word for a boolean formula key. */
function parseToggle(raw: string): boolean | undefined {
  if (['on', 'true', 'yes', '1'].includes(raw.toLowerCase())) return true
  if (['off', 'false', 'no', '0'].includes(raw.toLowerCase())) return false
  return undefined
}

/**
 * Parse `@open <url> [key=value …]`.
 *
 * `@open https://store.steampowered.com pace=slow pin=off`
 *
 * Returns `undefined` when the text is not an `@` directive at all, and an
 * `error` when it is one but unusable — a typo in an explicit directive should
 * be reported, not silently forwarded to the model as prose.
 */
export function parseOpenDirective(text: string): { directive: string; url?: string; options?: OpenOptions; error?: string } | undefined {
  if (!text.startsWith('@')) return undefined
  const body = text.slice(1).trim()
  const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body)
  const directive = (match?.[1] ?? '').toLowerCase()
  const rest = (match?.[2] ?? '').trim()
  const known = [...OPEN_DIRECTIVES].map((name) => `@${name}`).join('、')

  // A word that is a prefix of a real directive is still being typed, so it gets
  // the formula rather than a complaint. A *complete* directive with no argument
  // is a different thing — the URL is genuinely missing — and falls through to
  // the error below. That distinction is why this checks the prefix rather than
  // "contains only letters".
  if (!OPEN_DIRECTIVES.has(directive)) {
    if ([...OPEN_DIRECTIVES].some((name) => name.startsWith(directive))) {
      return { directive, error: `指令格式：${known} <网址> [pace=…] [pin=…]` }
    }
    // An unknown directive is almost always a typo of a known one, so name the
    // known ones instead of guessing what was meant.
    return { directive, error: `未知指令 @${directive}，可用：${known}` }
  }

  const [first, ...pairs] = tokenize(rest)
  if (first === undefined) {
    return { directive, error: `@${directive} 缺少网址，例如：@${directive} https://example.com` }
  }
  // A leading URL may be followed by key=value pairs; anything else is a typo.
  const url = parseUrlLike(first)
  if (url === undefined) {
    return { directive, error: `@${directive} 的第一个参数必须是网址（http/https 或域名），收到：${first}` }
  }

  const options: OpenOptions = { ...OPEN_DEFAULTS }
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      return { directive, url, error: `参数要写成 key=value，无法识别：${pair}` }
    }
    const key = pair.slice(0, separator).toLowerCase()
    const value = pair.slice(separator + 1)
    switch (key) {
      case 'pace': {
        if (!PACES.has(value as OpenOptions['pace'])) {
          return { directive, url, error: `pace 只能是 ${[...PACES].join(' / ')}，收到：${value}` }
        }
        options.pace = value as OpenOptions['pace']
        break
      }
      case 'pin': {
        const toggle = parseToggle(value)
        if (toggle === undefined) return { directive, url, error: `pin 只能是 on / off，收到：${value}` }
        options.pin = toggle
        break
      }
      default:
        return { directive, url, error: `未知参数：${key}（可用：pace、pin）` }
    }
  }

  return { directive, url, options }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolName(value: string): boolean {
  return BROWSER_TOOL_NAMES.includes(value)
}

/** A complete http(s) URL, optionally without its scheme. */
export function parseUrlLike(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    // A bare word with no dot is far more likely to be prose than a host. The
    // names that really are single-label are allowed explicitly.
    if (!/^https?:\/\//i.test(trimmed) && !isUsableHostname(url.hostname)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function isUsableHostname(hostname: string): boolean {
  return hostname.includes('.')
    || hostname === 'localhost'
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * `key=value` pairs as an alternative to JSON.
 *
 * `click index=3 frame=1` is easier to type than `{"index":3,"frame":1}`, and a
 * value that parses as JSON (number, boolean, quoted string) keeps its type so
 * `index=3` becomes the number the tool schema requires. A double-quoted value
 * may contain spaces, which is what makes `type text="hello world"` work.
 */
function parseAssignments(tokens: readonly string[]): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {}
  for (const token of tokens) {
    const separator = token.indexOf('=')
    if (separator <= 0) return undefined
    const key = token.slice(0, separator)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return undefined
    const raw = token.slice(separator + 1)
    args[key] = parseAssignmentValue(raw)
  }
  return Object.keys(args).length === 0 ? undefined : args
}

/** One assignment value: JSON when it parses, otherwise the literal text. */
function parseAssignmentValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Split an argument list, keeping double-quoted runs together.
 *
 * A naive `split(/\s+/)` would break `text="hello world"` into two tokens and
 * silently drop the argument, so the quoted form is honoured here.
 */
function tokenize(rest: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const char of rest) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * Fill in the arguments a tool obviously implies.
 *
 * These are conveniences, not policy: the background still validates every
 * argument and fails closed on anything it does not recognize.
 */
function withImpliedArgs(name: BrowserToolName, args: Record<string, unknown>, url: string | undefined): Record<string, unknown> {
  if (name === 'browser_navigate' || name === 'browser_open_tab') {
    if (typeof args.url !== 'string' && url !== undefined) return { ...args, url }
  }
  if (name === 'browser_scroll' && typeof args.direction !== 'string' && args.direction === undefined) {
    return { ...args, direction: 'down' }
  }
  if (name === 'browser_snapshot' && args.delta === undefined && args.delta === 'true') {
    return { ...args, delta: true }
  }
  return args
}

/**
 * Decide what the user meant.
 *
 * `browser_click {"index":3}`, `click index=3`, and `https://example.com` are
 * commands. `总结这个页面` and everything else is a prompt.
 */
export function classifyInput(value: string): InputIntent {
  const text = value.trim()
  if (text === '') return { kind: 'prompt', text: '' }

  // An `@` directive is explicit, so it is resolved before anything that could
  // mistake it for prose. A malformed one stays a prompt carrying its error, so
  // the panel can report the typo instead of the model silently receiving it.
  const directive = parseOpenDirective(text)
  if (directive !== undefined) {
    const echo = text.replace(/\s+/g, ' ')
    if (directive.error !== undefined || directive.url === undefined || directive.options === undefined) {
      return { kind: 'prompt', text: `${directive.error ?? '指令无法解析'}` }
    }
    return { kind: 'open', url: directive.url, options: directive.options, echo }
  }

  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/.exec(text)
  const head = match?.[1] ?? ''
  const rest = (match?.[2] ?? '').trim()

  const explicit = isToolName(head) ? head : SHORTHANDS[head.toLowerCase()]
  if (explicit !== undefined) {
    const parsed = parseCommandArguments(rest)
    if (parsed !== undefined) {
      return {
        kind: 'command',
        name: explicit,
        args: withImpliedArgs(explicit, parsed.args, parsed.url),
        echo: text.replace(/\s+/g, ' '),
      }
    }
    // An `browser_*` name is unambiguous even with unreadable arguments: the
    // background validates the call and fails closed, which is a better answer
    // than quietly forwarding a malformed command to the model.
    if (isToolName(head)) return { kind: 'command', name: explicit, args: {}, echo: text.replace(/\s+/g, ' ') }
    // A shorthand is an ordinary English word. "read the docs please" is prose,
    // so a shorthand with arguments we cannot read stays a prompt.
  }

  // A bare URL or a single dotted host both mean "go here".
  const url = parseUrlLike(text)
  if (url !== undefined) {
    return { kind: 'command', name: 'browser_navigate', args: { url }, echo: text }
  }

  return { kind: 'prompt', text }
}

interface ParsedArguments {
  args: Record<string, unknown>
  /** The URL the arguments named, if any, for tools that need one separately. */
  url: string | undefined
}

function parseCommandArguments(rest: string): ParsedArguments | undefined {
  if (rest === '') return { args: {}, url: undefined }

  if (rest.startsWith('{')) {
    try {
      const value = JSON.parse(rest) as unknown
      if (!isRecord(value)) return undefined
      return { args: value, url: typeof value.url === 'string' ? value.url : undefined }
    } catch {
      return undefined
    }
  }

  const tokens = tokenize(rest)
  const head = tokens[0] ?? ''

  // A leading URL, optionally followed by `key=value` pairs.
  const url = parseUrlLike(head)
  if (url !== undefined) {
    const tail = tokens.slice(1)
    const extra = tail.length === 0 ? {} : parseAssignments(tail) ?? {}
    return { args: { ...extra, url }, url }
  }

  // A lone directional word is the scroll argument, not an assignment.
  if (tokens.length === 1 && /^[a-z]+$/i.test(head)) {
    return { args: { direction: head.toLowerCase() }, url: undefined }
  }

  const assignments = parseAssignments(tokens)
  return assignments === undefined ? undefined : { args: assignments, url: undefined }
}

/** Whether a call needs an explicit confirmation argument before it may run. */
export function requiresConfirmArgument(name: string): boolean {
  return name === 'browser_close_tab'
}
