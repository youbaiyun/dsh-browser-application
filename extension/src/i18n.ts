/** Languages supported by the extension UI. */
export type UiLocale = 'en' | 'zh'

/**
 * Chinese browser locales use Chinese; every other locale deliberately falls
 * back to English so an untranslated third language never leaks into the UI.
 */
export function localeFromLanguage(language: string | null | undefined): UiLocale {
  const normalized = language?.trim().toLowerCase() ?? ''
  return normalized === 'zh' || normalized.startsWith('zh-') ? 'zh' : 'en'
}

/** Read the browser's first preferred language, with the extension UI locale as a fallback. */
export function getUiLocale(): UiLocale {
  let language: string | undefined
  if (typeof navigator !== 'undefined') {
    const preferred = navigator.languages?.find((candidate) => candidate.trim() !== '') ?? navigator.language
    language = preferred.trim() === '' ? undefined : preferred
  }
  if (language === undefined && typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage !== undefined) {
    try {
      language = chrome.i18n.getUILanguage()
    } catch {
      // A partially mocked or stale extension context may expose an unusable API.
    }
  }
  return localeFromLanguage(language)
}
