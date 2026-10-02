// @vitest-environment jsdom

/**
 * Tests for the composer's input classifier.
 *
 * The classifier decides whether a typed line runs in the browser or is sent to
 * the model, so the cases that matter are the ambiguous ones: a bare word, a
 * sentence that starts with a tool name, a URL with a path, malformed JSON.
 */

import { describe, expect, it } from 'vitest'
import {
  BROWSER_TOOL_NAMES,
  OPEN_DEFAULTS,
  classifyInput,
  parseOpenDirective,
  parseUrlLike,
  requiresConfirmArgument,
} from '../control/command.ts'

describe('classifyInput', () => {
  it('recognizes an explicit tool name with JSON arguments', () => {
    const intent = classifyInput('browser_click {"index":3,"frame":0}')
    expect(intent).toEqual({
      kind: 'command',
      name: 'browser_click',
      args: { index: 3, frame: 0 },
      echo: 'browser_click {"index":3,"frame":0}',
    })
  })

  it('recognizes key=value arguments and types them', () => {
    expect(classifyInput('click index=3 frame=1')).toMatchObject({
      kind: 'command',
      name: 'browser_click',
      args: { index: 3, frame: 1 },
    })
    expect(classifyInput('type index=2 text="hello world"')).toMatchObject({
      kind: 'command',
      name: 'browser_type',
      args: { index: 2, text: 'hello world' },
    })
    expect(classifyInput('snapshot delta=true')).toMatchObject({
      kind: 'command',
      name: 'browser_snapshot',
      args: { delta: true },
    })
  })

  it('maps the shorthand words people actually type', () => {
    expect(classifyInput('snapshot')).toMatchObject({ kind: 'command', name: 'browser_snapshot', args: {} })
    expect(classifyInput('tabs')).toMatchObject({ kind: 'command', name: 'browser_list_tabs', args: {} })
    expect(classifyInput('back')).toMatchObject({ kind: 'command', name: 'browser_back', args: {} })
    // Case-insensitive on the verb, so `Click` works too.
    expect(classifyInput('Click index=7')).toMatchObject({ kind: 'command', name: 'browser_click', args: { index: 7 } })
  })

  it('fills in the arguments a tool implies', () => {
    // A leading URL is the destination, and scroll defaults to a page down.
    expect(classifyInput('browser_navigate https://example.com/a?b=1')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/a?b=1' },
    })
    expect(classifyInput('scroll')).toMatchObject({
      kind: 'command',
      name: 'browser_scroll',
      args: { direction: 'down' },
    })
    expect(classifyInput('scroll up')).toMatchObject({
      kind: 'command',
      name: 'browser_scroll',
      args: { direction: 'up' },
    })
  })

  it('treats a bare URL or dotted host as navigation', () => {
    expect(classifyInput('https://example.com/help')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/help' },
    })
    expect(classifyInput('example.com')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/' },
    })
  })

  it('sends anything else to the model', () => {
    expect(classifyInput('总结这个页面')).toEqual({ kind: 'prompt', text: '总结这个页面' })
    expect(classifyInput('summarize the page and list the links')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('read the docs please')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('')).toEqual({ kind: 'prompt', text: '' })
  })

  it('treats a single-label host as prose unless it is really a host', () => {
    // `wiki` is a word; `localhost` and a bare IP are addresses people type.
    expect(classifyInput('wiki')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('localhost:8080')).toMatchObject({ kind: 'command', name: 'browser_navigate' })
    expect(classifyInput('127.0.0.1:3080')).toMatchObject({ kind: 'command', name: 'browser_navigate' })
  })

  it('keeps an explicit tool name a command even when the arguments are unreadable', () => {
    // `browser_*` is unambiguous; the background validates the call and fails
    // closed, which is a better answer than forwarding it to the model.
    expect(classifyInput('browser_click oops')).toMatchObject({
      kind: 'command',
      name: 'browser_click',
      args: {},
    })
  })

  it('treats a shorthand with prose after it as a prompt', () => {
    // `read` is also an ordinary English word; only a clean argument list makes
    // it a command, so this stays with the model.
    expect(classifyInput('read the docs please')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('read index=3')).toMatchObject({
      kind: 'command',
      name: 'browser_get_text',
      args: { index: 3 },
    })
  })

  it('collapses whitespace in the echoed command', () => {
    expect(classifyInput('  click    index=3  ')).toMatchObject({
      kind: 'command',
      echo: 'click index=3',
    })
  })
})

describe('parseUrlLike', () => {
  it('accepts complete URLs and single dotted hosts', () => {
    expect(parseUrlLike('https://example.com/a')).toBe('https://example.com/a')
    expect(parseUrlLike('example.com/a')).toBe('https://example.com/a')
    expect(parseUrlLike('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('refuses prose, other schemes, and dotted words inside a sentence', () => {
    expect(parseUrlLike('hello world')).toBeUndefined()
    expect(parseUrlLike('file:///etc/passwd')).toBeUndefined()
    expect(parseUrlLike('chrome://extensions')).toBeUndefined()
    expect(parseUrlLike('check example.com now')).toBeUndefined()
    expect(parseUrlLike('')).toBeUndefined()
  })
})

describe('tool surface', () => {
  it('exposes every browser tool once', () => {
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length)
    expect(BROWSER_TOOL_NAMES).toContain('browser_close_tab')
  })

  it('agrees with the registry the background actually dispatches', () => {
    // The composer's list is imported from `src/background/tools.ts`, and the
    // background rejects any name outside its own registry. A shorthand that
    // points at a name the background does not know would be a dead command, so
    // every alias is resolved back to a real tool here.
    for (const word of ['snapshot', 'read', 'text', 'click', 'type', 'fill', 'press', 'key', 'scroll', 'wait', 'tabs', 'back', 'forward', 'reload']) {
      const intent = classifyInput(word)
      expect(intent.kind, `shorthand "${word}" must resolve to a command`).toBe('command')
      if (intent.kind === 'command') expect(BROWSER_TOOL_NAMES).toContain(intent.name)
    }
  })

  it('requires an explicit confirmation only for closing a tab', () => {
    expect(requiresConfirmArgument('browser_close_tab')).toBe(true)
    expect(requiresConfirmArgument('browser_click')).toBe(false)
  })
})

describe('@open directive', () => {
  it('parses the documented formula and fills in the defaults', () => {
    const parsed = parseOpenDirective('@open https://store.steampowered.com')
    expect(parsed?.url).toBe('https://store.steampowered.com/')
    // Omitting every key leaves the documented defaults, not an empty object.
    expect(parsed?.options).toEqual(OPEN_DEFAULTS)
  })

  it('accepts every documented key', () => {
    const parsed = parseOpenDirective('@open https://example.com pace=slow pin=off')
    expect(parsed?.options).toEqual({ pace: 'slow', pin: false })
  })

  it('rejects a key it does not implement rather than accepting and ignoring it', () => {
    // `verify` used to parse and then do nothing, which is worse than refusing:
    // the user believes a guarantee they were never given.
    const parsed = parseOpenDirective('@open https://example.com verify=step')
    expect(parsed?.error).toContain('未知参数')
    expect(parsed?.error).toContain('verify')
  })

  it('accepts the whole-domain shorthand the URL helper understands', () => {
    expect(parseOpenDirective('@open example.com')?.url).toBe('https://example.com/')
  })

  it('exposes the directive as its own intent, not a command or a prompt', () => {
    const intent = classifyInput('@open https://example.com pace=fast')
    expect(intent.kind).toBe('open')
    if (intent.kind !== 'open') throw new Error('unreachable')
    expect(intent.url).toBe('https://example.com/')
    expect(intent.options.pace).toBe('fast')
    // The echo is what the panel shows, so it is the cleaned original line.
    expect(intent.echo).toBe('@open https://example.com pace=fast')
  })

  it('treats @show and @watch as the same directive', () => {
    for (const word of ['show', 'watch']) {
      const intent = classifyInput(`@${word} https://example.com`)
      expect(intent.kind, `@${word} must open`).toBe('open')
    }
  })

  it('reports a bad formula instead of quietly forwarding it', () => {
    // A typo in an explicit directive is the user's problem to see, not prose to
    // hand the model, so each of these becomes a prompt carrying the complaint.
    const cases: [string, RegExp][] = [
      ['@opne https://example.com', /未知指令/],
      ['@open', /缺少网址/],
      ['@open not a url', /必须是网址/],
      ['@open https://example.com pace=quick', /pace 只能是/],
      ['@open https://example.com verify=sometimes', /未知参数/],
      ['@open https://example.com pin=maybe', /pin 只能是/],
      ['@open https://example.com colour=red', /未知参数/],
      ['@open https://example.com --fast', /key=value/],
    ]
    for (const [input, expected] of cases) {
      const intent = classifyInput(input)
      expect(intent.kind, input).toBe('prompt')
      if (intent.kind === 'prompt') expect(intent.text, input).toMatch(expected)
    }
  })

  it('shows the formula while the directive is still being typed', () => {
    // Half-typed input is not a mistake yet, so it must not be reported as one.
    // A bare `@open` is different: the directive is complete and the URL is
    // genuinely missing, so that case is asserted above as an error.
    for (const partial of ['@', '@o', '@op', '@sho']) {
      const intent = classifyInput(partial)
      expect(intent.kind, partial).toBe('prompt')
      if (intent.kind === 'prompt') expect(intent.text, partial).toMatch(/指令格式/)
    }
  })

  it('is not confused by an @ that is not a directive', () => {
    // An email handle or a stray @ is prose.
    for (const text of ['@', '@  spaced', 'mail me @ example.com', 'user@example.com']) {
      const parsed = parseOpenDirective(text)
      expect(parsed === undefined || parsed.error !== undefined, text).toBe(true)
    }
  })

  it('rejects a non-http scheme before anything opens a tab', () => {
    // `javascript:` and `file:` must never reach chrome.tabs.
    for (const bad of ['@open javascript:alert(1)', '@open file:///C:/windows', '@open chrome://settings']) {
      const intent = classifyInput(bad)
      expect(intent.kind, bad).toBe('prompt')
    }
  })
})
