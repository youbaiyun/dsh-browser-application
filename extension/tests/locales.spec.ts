// @vitest-environment jsdom

/**
 * Every locale must ship the same identity.
 *
 * A rename that updates two of three locale files is invisible to every other
 * test in this suite: the browser reads `_locales/<locale>/messages.json` and
 * there was nothing asserting anything about it. That is exactly what happened —
 * `zh_CN` and `en` were renamed and `zh_TW` kept the old name, so Traditional
 * Chinese users would have seen the previous name on the extensions page and in
 * the toolbar. These tests exist so the next rename cannot repeat it.
 *
 * They assert shape and agreement, not wording: a translator may phrase the
 * description however it reads best in their language. What is checked is that
 * every locale defines the same keys, that none of them is empty, and that no
 * locale states a name this project no longer uses.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface LocaleMessage {
  message: string
}

/**
 * A plain directory path rather than a `URL`.
 *
 * `new URL('../x', import.meta.url)` works for `readFile` but not for `readdir`,
 * and under the transform `import.meta.url` is not always a `file:` URL — which
 * is what the first version of this file got wrong: every test failed with "The
 * URL must be of scheme file" before reading anything. Converting once here keeps
 * both calls on the same footing.
 */
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '_locales')

/**
 * The repository root, for reading the store copy this must agree with.
 *
 * Two levels up: this extension lives at `<repo>/extension`, not at upstream's
 * `<repo>/extensions/dsh-browser`. With three levels the path resolved above the
 * repository and the assertion below was skipped forever — the drift it exists to
 * catch, hidden by its own path arithmetic.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Where the store listing lives, when this checkout has one.
 *
 * The listing belongs to the release repository rather than to the extension, so
 * a checkout that contains only the extension has nothing to compare against. The
 * assertion is reported as skipped there instead of being deleted, so a checkout
 * that does have the file still catches the drift that once got an upload
 * rejected.
 */
const storeListingPath = join(repoRoot, 'store-assets', 'store-listing.md')
const hasStoreListing = existsSync(storeListingPath)

/**
 * Read the store listing's short description.
 *
 * The store checks two separate short descriptions and rejects the submission if
 * either is too long: the one typed into the dashboard form, and the
 * `extensionDescription` in each locale file. They were maintained separately
 * here, and the English one had drifted to 145 characters against a limit of 132
 * — which Chrome refused at upload with `语言区域"en"中"description"的翻译太长`.
 * Keeping one copy in the locale files and asserting it equals the listing's is
 * what makes that impossible to repeat.
 */
const storeShortDescription = async (): Promise<string> => {
  const markdown = await readFile(storeListingPath, 'utf8')
  const section = /## Short description[^\n]*\n+```\n([\s\S]*?)\n```/.exec(markdown)
  if (section === null) throw new Error('store-listing.md has no short-description code block')
  return section[1].trim()
}

const readLocale = async (locale: string): Promise<Record<string, LocaleMessage>> =>
  JSON.parse(await readFile(join(localesDir, locale, 'messages.json'), 'utf8')) as Record<string, LocaleMessage>

const allLocales = async (): Promise<string[]> =>
  (await readdir(localesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()

/** Names this project has used and no longer does. */
const RETIRED = ['手與眼', '手与眼', 'Hand & Eye', '浏览器操作', '瀏覽器操作', '浏览器控制', 'Browser Control', 'dsh-browser-lite', 'dsh-browser-crossplatform']

describe('locale files', () => {
  it('defines the keys the manifest and the toolbar need, in every locale', async () => {
    const locales = await allLocales()
    // The extension ships three; a fourth would be welcome but must be complete.
    expect(locales.length).toBeGreaterThanOrEqual(3)
    for (const locale of locales) {
      const messages = await readLocale(locale)
      for (const key of ['extensionName', 'extensionDescription', 'actionTitle']) {
        expect(messages[key]?.message, `${locale}.${key}`).toBeTruthy()
      }
    }
  })

  it('has no empty string in any locale', async () => {
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      for (const [key, value] of Object.entries(messages)) {
        expect(value.message.trim(), `${locale}.${key} must not be blank`).not.toBe('')
      }
    }
  })

  it('states no retired name', async () => {
    // This is the check that the rename needed. It is deliberately a list of past
    // names rather than a fixed expected value: the point is that a locale file is
    // never forgotten, not that all three read identically.
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const text = JSON.stringify(messages)
      for (const retired of RETIRED) {
        expect(text, `${locale} still says "${retired}"`).not.toContain(retired)
      }
    }
  })

  it('agrees on the name across locales, allowing for each language\'s own wording', async () => {
    // Every locale's name must contain the product token that does not translate.
    // The parenthetical is checked in the script each locale actually writes in:
    // Simplified and Traditional differ here, and an earlier version of this test
    // asserted the Traditional form against `zh_CN`, which failed for the right
    // reason — the fixture was wrong, not the locale file.
    const EXPECTED_SUFFIX: Record<string, string> = {
      zh_CN: '应用端',
      zh_TW: '應用端',
    }
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      expect(messages.extensionName.message, `${locale} extensionName`).toContain('dsh')
      const suffix = EXPECTED_SUFFIX[locale]
      if (suffix !== undefined) expect(messages.extensionName.message, `${locale} extensionName`).toContain(suffix)
    }
  })

  it('names the localised form of "extension" in the Chinese locales', async () => {
    // 扩展（Simplified）and 擴充功能（Traditional）are what the browsers themselves
    // use; 拓展 means to expand a business and 手與眼 was this project's old
    // metaphor. A Chinese locale naming something else is a rename that missed.
    const zhCN = await readLocale('zh_CN')
    const zhTW = await readLocale('zh_TW')
    expect(zhCN.extensionName.message).toContain('扩展')
    expect(zhTW.extensionName.message).toContain('擴充功能')
  })

  it('keeps every description within the store\'s 132-character limit', async () => {
    // Chrome counts characters, not bytes, and rejects the whole upload rather
    // than truncating. The limit applies per locale.
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const length = [...messages.extensionDescription.message].length
      expect(length, `${locale} extensionDescription is ${length} characters`).toBeLessThanOrEqual(132)
    }
  })

  it('keeps every name within the store\'s 75-character limit', async () => {
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const length = [...messages.extensionName.message].length
      expect(length, `${locale} extensionName is ${length} characters`).toBeLessThanOrEqual(75)
    }
  })

  it.skipIf(!hasStoreListing)('states the same short description as the store listing', async () => {
    // One text, two places the store reads it from. Drift between them is what
    // caused a rejected upload, so they are asserted equal rather than eyeballed.
    const listing = await storeShortDescription()
    const en = await readLocale('en')
    expect(en.extensionDescription.message).toBe(listing)
  })
})
