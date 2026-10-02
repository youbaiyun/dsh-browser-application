// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLocale, localeFromLanguage } from '../src/i18n.ts'
import type { OpenError } from '../control/command.ts'
import { controlCopy, describeOpenError } from '../control/strings.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser locale selection', () => {
  it('uses Chinese for every zh locale variant', () => {
    expect(localeFromLanguage('zh')).toBe('zh')
    expect(localeFromLanguage('zh-CN')).toBe('zh')
    expect(localeFromLanguage('zh-TW')).toBe('zh')
    expect(localeFromLanguage('ZH-hant-HK')).toBe('zh')
  })

  it('defaults every non-Chinese or missing locale to English', () => {
    expect(localeFromLanguage('en-US')).toBe('en')
    expect(localeFromLanguage('ja-JP')).toBe('en')
    expect(localeFromLanguage('fr')).toBe('en')
    expect(localeFromLanguage(undefined)).toBe('en')
  })

  it('uses the browser\'s first preferred language', () => {
    vi.stubGlobal('navigator', { languages: ['zh-Hant', 'en-US'], language: 'en-US' })
    expect(getUiLocale()).toBe('zh')

    vi.stubGlobal('navigator', { languages: ['de-DE', 'zh-CN'], language: 'de-DE' })
    expect(getUiLocale()).toBe('en')
  })
})

describe('open-directive errors are translated', () => {
  /**
   * One of every reason the parser can report.
   *
   * The parser returns a reason rather than a sentence, so a reason with no
   * wording is a message the user would never see. The panel had nine messages
   * hard-coded in Chinese, which meant an English user read Chinese; this is the
   * test that keeps the two lists in step as reasons are added.
   */
  const EVERY_REASON: OpenError[] = [
    { kind: 'directiveFormat', known: '@open', soft: true },
    { kind: 'unknownDirective', directive: 'opne', known: '@open' },
    { kind: 'missingUrl', directive: 'open' },
    { kind: 'firstArgumentNotUrl', directive: 'open', received: 'not a url' },
    { kind: 'notKeyValue', pair: '--fast' },
    { kind: 'paceInvalid', allowed: 'fast / normal / slow', received: 'quick' },
    { kind: 'pinInvalid', received: 'maybe' },
    { kind: 'unknownKey', key: 'verify' },
    { kind: 'unparsable' },
  ]

  it('words every reason in both languages, and differently', () => {
    for (const error of EVERY_REASON) {
      const zh = describeOpenError('zh', error)
      const en = describeOpenError('en', error)
      expect(zh, `${error.kind} (zh)`).toBeTruthy()
      expect(en, `${error.kind} (en)`).toBeTruthy()
      // Identical output would mean one language was never written.
      expect(zh, `${error.kind} must differ by language`).not.toBe(en)
      // An English user must not be handed Chinese.
      expect(en, `${error.kind} (en) must not contain Chinese characters`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('carries the values the user typed back into the message', () => {
    // A complaint that does not repeat the offending value makes the user guess.
    expect(describeOpenError('en', { kind: 'unknownKey', key: 'verify' })).toContain('verify')
    expect(describeOpenError('en', { kind: 'paceInvalid', allowed: 'a / b', received: 'quick' })).toContain('quick')
    expect(describeOpenError('zh', { kind: 'unknownKey', key: 'verify' })).toContain('verify')
  })

  it('says nothing in Chinese to an English reader anywhere in the copy table', () => {
    // A blanket check on the English table, so a string pasted from the Chinese
    // one is caught wherever it lands rather than only in the group being edited.
    const english = controlCopy('en')
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value, `${path} must not be Chinese`).not.toMatch(/[\u4e00-\u9fff]/)
        return
      }
      if (typeof value === 'function') return
      if (value === null || typeof value !== 'object') return
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`)
    }
    walk(english, 'EN')
  })
})
