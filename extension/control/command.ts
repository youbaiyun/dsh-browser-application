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
  /**
   * The user typed something that looks like a directive but is unusable.
   *
   * Distinct from `prompt` so the message is never sent to the model: it is
   * between the user and the parser, and the wording depends on the panel's
   * language. When this was a `prompt` carrying a sentence, submitting a typo
   * would have transmitted the complaint as though it were an instruction.
   */
  | { kind: 'error'; error: OpenError }

/** How an `@open` should behave while it runs. */
export interface OpenOptions {
  /** Delay between the steps, so a person can follow what is happening. */
  pace: 'fast' | 'normal' | 'slow'
  /** Whether the opened tab becomes the tab the browser tools act on. */
  pin: boolean
}

/**
 * Why an `@open` directive could not be used.
 *
 * A code plus its parts, not a sentence. The sentence belongs to the locale table
 * (`strings.ts`), because a user who chose English must not be answered in
 * Chinese — which is what happened while the parser built its own messages: nine
 * of them, in Chinese, whatever language the panel was in.
 *
 * Returning the reason rather than the wording also keeps this module a pure
 * function of its input, which is what makes it testable without a DOM.
 */
export type OpenError =
  | { kind: 'directiveFormat'; known: string; soft: true }
  | { kind: 'unknownDirective'; directive: string; known: string }
  | { kind: 'missingUrl'; directive: string }
  | { kind: 'firstArgumentNotUrl'; directive: string; received: string }
  | { kind: 'notKeyValue'; pair: string }
  | { kind: 'paceInvalid'; allowed: string; received: string }
  | { kind: 'pinInvalid'; received: string }
  | { kind: 'unknownKey'; key: string }
  | { kind: 'unparsable' }

/**
 * Whether a directive error is worth interrupting the user for.
 *
 * `directiveFormat` fires while a correct directive is still being typed — the
 * user has written `@op` and the rest is coming — so it is shown quietly as a
 * reminder of the shape. Everything else is a mistake the user needs to see.
 *
 * This lives here, as a property of the error, rather than being inferred from
 * the message text. The panel used to decide by testing whether the string began
 * with a particular Chinese phrase, which meant the distinction disappeared the
 * moment the text was translated: a half-typed directive would be shown as a hard
 * error in English, and the browser would then have been right.
 */
export const isSoftOpenError = (error: OpenError): boolean =>
  error.kind === 'directiveFormat'

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
export function parseOpenDirective(text: string): { directive: string; url?: string; options?: OpenOptions; error?: OpenError } | undefined {
  if (!text.startsWith('@')) return undefined
  const body = text.slice(1).trim()
  const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body)
  const directive = (match?.[1] ?? '').toLowerCase()
  const rest = (match?.[2] ?? '').trim()
  // The list is joined with a comma-space rather than an ideographic comma: this
  // is a name list rendered inside a sentence written in either language, and the
  // Chinese comma reads as a mistake in English.
  const known = [...OPEN_DIRECTIVES].map((name) => `@${name}`).join(', ')

  // A word that is a prefix of a real directive is still being typed, so it gets
  // the formula rather than a complaint. A *complete* directive with no argument
  // is a different thing — the URL is genuinely missing — and falls through to
  // the error below. That distinction is why this checks the prefix rather than
  // "contains only letters".
  if (!OPEN_DIRECTIVES.has(directive)) {
    if ([...OPEN_DIRECTIVES].some((name) => name.startsWith(directive))) {
      return { directive, error: { kind: 'directiveFormat', known, soft: true } }
    }
    // An unknown directive is almost always a typo of a known one, so name the
    // known ones instead of guessing what was meant.
    return { directive, error: { kind: 'unknownDirective', directive, known } }
  }

  const [first, ...pairs] = tokenize(rest)
  if (first === undefined) {
    return { directive, error: { kind: 'missingUrl', directive } }
  }
  // A leading URL may be followed by key=value pairs; anything else is a typo.
  const url = parseUrlLike(first)
  if (url === undefined) {
    return { directive, error: { kind: 'firstArgumentNotUrl', directive, received: first } }
  }

  const options: OpenOptions = { ...OPEN_DEFAULTS }
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      return { directive, url, error: { kind: 'notKeyValue', pair } }
    }
    const key = pair.slice(0, separator).toLowerCase()
    const value = pair.slice(separator + 1)
    switch (key) {
      case 'pace': {
        if (!PACES.has(value as OpenOptions['pace'])) {
          return { directive, url, error: { kind: 'paceInvalid', allowed: [...PACES].join(' / '), received: value } }
        }
        options.pace = value as OpenOptions['pace']
        break
      }
      case 'pin': {
        const toggle = parseToggle(value)
        if (toggle === undefined) return { directive, url, error: { kind: 'pinInvalid', received: value } }
        options.pin = toggle
        break
      }
      default:
        return { directive, url, error: { kind: 'unknownKey', key } }
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
    if (directive.error !== undefined) return { kind: 'error', error: directive.error }
    if (directive.url === undefined || directive.options === undefined) {
      return { kind: 'error', error: { kind: 'unparsable' } }
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
