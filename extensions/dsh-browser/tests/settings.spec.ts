// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  type Settings,
} from '../src/settings.ts'

/** Normalize an untrusted candidate exactly as the storage reader would. */
function normalize(candidate: unknown): Settings {
  return normalizeSettings(candidate as Partial<Settings> | undefined)
}

describe('normalizeSettings', () => {
  it('falls back to the defaults for an empty or missing candidate', () => {
    const fromUndefined = normalizeSettings(undefined)
    expect(fromUndefined).toEqual(SETTINGS_DEFAULTS)
    // The result is a fresh object, not the shared defaults record.
    expect(fromUndefined).not.toBe(SETTINGS_DEFAULTS)

    expect(normalize({})).toEqual(SETTINGS_DEFAULTS)
    // A missing storage value or a corrupted non-object must not throw.
    expect(normalize(null)).toEqual(SETTINGS_DEFAULTS)
    expect(normalize('not settings')).toEqual(SETTINGS_DEFAULTS)
    expect(normalize(7)).toEqual(SETTINGS_DEFAULTS)

    expect(SETTINGS_DEFAULTS).toEqual({
      bridgeUrl: '',
      token: '',
      sharePageContent: 'auto',
      unrestrictedBrowserAccess: false,
      trustedActionOrigins: [],
      approvalNotifications: true,
      autoOpenPanel: true,
      // Asking stays the default: following the active tab can move the target
      // off a tab the model opened on purpose.
      tabSwitch: 'ask',
      // The panel gets its own conversation unless the user names another one.
      sessionScope: 'fresh',
      pinnedSessionId: null,
      readWidth: 640,
    })
    // Every field is always present, so the panel never renders `undefined`.
    expect(Object.keys(fromUndefined).sort()).toEqual([
      'approvalNotifications',
      'autoOpenPanel',
      'bridgeUrl',
      'pinnedSessionId',
      'readWidth',
      'sessionScope',
      'sharePageContent',
      'tabSwitch',
      'token',
      'trustedActionOrigins',
      'unrestrictedBrowserAccess',
    ])
  })

  it('trims bridgeUrl and token, rejecting non-string values', () => {
    expect(normalize({
      bridgeUrl: '  ws://127.0.0.1:8799/bridge  ',
      token: '  bearer-token  ',
    })).toMatchObject({
      bridgeUrl: 'ws://127.0.0.1:8799/bridge',
      token: 'bearer-token',
    })

    // Whitespace-only input collapses to the empty "auto-discover" value.
    expect(normalize({ bridgeUrl: '   ', token: '\t' }))
      .toMatchObject({ bridgeUrl: '', token: '' })
    expect(normalize({ bridgeUrl: 42, token: null }))
      .toMatchObject({ bridgeUrl: '', token: '' })
  })

  it('accepts only ask/auto/off for sharePageContent', () => {
    expect(normalize({ sharePageContent: 'ask' }).sharePageContent).toBe('ask')
    expect(normalize({ sharePageContent: 'auto' }).sharePageContent).toBe('auto')
    expect(normalize({ sharePageContent: 'off' }).sharePageContent).toBe('off')

    for (const invalid of ['sometimes', 'ON', '', true, 1, null, undefined, {}]) {
      expect(normalize({ sharePageContent: invalid }).sharePageContent).toBe('auto')
    }
  })

  it('coerces unrestrictedBrowserAccess to a strict boolean', () => {
    expect(normalize({ unrestrictedBrowserAccess: true }).unrestrictedBrowserAccess).toBe(true)
    expect(normalize({ unrestrictedBrowserAccess: false }).unrestrictedBrowserAccess).toBe(false)

    // Only the literal `true` may widen access; loose values stay restricted.
    for (const loosened of ['true', 'yes', '1', 1, 0, null, undefined, {}, []]) {
      expect(normalize({ unrestrictedBrowserAccess: loosened }).unrestrictedBrowserAccess).toBe(false)
    }
  })

  it('de-duplicates and sorts trustedActionOrigins, dropping invalid entries', () => {
    const settings = normalize({
      trustedActionOrigins: [
        ' https://docs.example.com/guide ',
        'https://app.example.com',
        'https://app.example.com/',
        'not an origin',
        'ftp://files.example.com',
        'https://user:pass@secret.example.com',
        42,
        null,
        '*.example.com',
        'https://*.example.com',
      ],
    })

    expect(settings.trustedActionOrigins).toEqual([
      'https://*.example.com',
      'https://app.example.com',
      'https://docs.example.com',
    ])
  })

  it('keeps an empty allowlist when the candidate has no usable origin list', () => {
    expect(normalize({ trustedActionOrigins: [] }).trustedActionOrigins).toEqual([])
    expect(normalize({ trustedActionOrigins: 'https://app.example.com' }).trustedActionOrigins).toEqual([])
    expect(normalize({ trustedActionOrigins: [42, 'nonsense'] }).trustedActionOrigins).toEqual([])
  })

  it('defaults approvalNotifications unless explicitly disabled', () => {
    expect(normalize({})).toMatchObject({ approvalNotifications: true })
    expect(normalize({ approvalNotifications: true })).toMatchObject({ approvalNotifications: true })
    expect(normalize({ approvalNotifications: false })).toMatchObject({ approvalNotifications: false })

    // Anything that is not literally `false` keeps the default.
    for (const notFalse of ['false', 0, null, undefined, {}, []]) {
      expect(normalize({ approvalNotifications: notFalse })).toMatchObject({ approvalNotifications: true })
    }
  })

  it('keeps the reading cap inside a range that is still a line length', () => {
    expect(normalize({ readWidth: 800 }).readWidth).toBe(800)
    // Narrower than a usable column is raised; absurdly wide is capped.
    expect(normalize({ readWidth: 120 }).readWidth).toBe(360)
    expect(normalize({ readWidth: 9000 }).readWidth).toBe(1200)
    for (const invalid of [undefined, null, 'wide', Number.NaN, {}]) {
      expect(normalize({ readWidth: invalid }).readWidth).toBe(640)
    }
  })

  it('accepts only the three tab-switch modes, defaulting to ask', () => {
    expect(normalize({ tabSwitch: 'follow' }).tabSwitch).toBe('follow')
    expect(normalize({ tabSwitch: 'keep' }).tabSwitch).toBe('keep')
    expect(normalize({ tabSwitch: 'ask' }).tabSwitch).toBe('ask')
    for (const invalid of ['always', 'FOLLOW', '', true, 1, null, undefined, {}]) {
      expect(normalize({ tabSwitch: invalid }).tabSwitch).toBe('ask')
    }
  })

  it('accepts only the two conversation scopes, defaulting to a fresh session', () => {
    expect(normalize({ sessionScope: 'fresh' }).sessionScope).toBe('fresh')
    expect(normalize({ sessionScope: 'pinned' }).sessionScope).toBe('pinned')
    for (const invalid of ['current', 'PINNED', '', true, 1, null, undefined, {}]) {
      expect(normalize({ sessionScope: invalid }).sessionScope).toBe('fresh')
    }
  })

  it('keeps a pinned session id only when it is a usable string', () => {
    expect(normalize({ pinnedSessionId: 'session-7' }).pinnedSessionId).toBe('session-7')
    expect(normalize({ pinnedSessionId: '  session-7  ' }).pinnedSessionId).toBe('session-7')
    // A junk id must collapse to "nothing chosen" rather than routing the next
    // prompt at a session id built from whatever was in storage.
    for (const invalid of ['', '   ', 42, true, null, undefined, {}, []]) {
      expect(normalize({ pinnedSessionId: invalid }).pinnedSessionId).toBeNull()
    }
  })

  it('preserves a complete, already-normalized candidate', () => {
    const candidate: Settings = {
      bridgeUrl: 'ws://127.0.0.1:8799/bridge',
      token: 'bearer-token',
      sharePageContent: 'off',
      unrestrictedBrowserAccess: true,
      trustedActionOrigins: ['https://app.example.com'],
      approvalNotifications: false,
      autoOpenPanel: false,
      tabSwitch: 'ask',
      sessionScope: 'pinned',
      pinnedSessionId: 'session-42',
      readWidth: 800,
    }

    expect(normalizeSettings(candidate)).toEqual(candidate)
  })

  it('never mutates SETTINGS_DEFAULTS and returns an independent allowlist', () => {
    const before = {
      ...SETTINGS_DEFAULTS,
      trustedActionOrigins: [...SETTINGS_DEFAULTS.trustedActionOrigins],
    }

    const dirty = normalize({
      bridgeUrl: ' not-a-url ',
      token: 12,
      sharePageContent: 'whenever',
      unrestrictedBrowserAccess: 'yes',
      trustedActionOrigins: ['https://app.example.com', 'bogus'],
      approvalNotifications: null,
      fixedWidth: 'no',
    })

    expect(SETTINGS_DEFAULTS).toEqual(before)

    // The normalized allowlist is a fresh array: a caller cannot corrupt the
    // defaults or the next read by mutating what it received.
    dirty.trustedActionOrigins.push('https://evil.example.com')
    expect(normalizeSettings(undefined).trustedActionOrigins).toEqual([])
    expect(SETTINGS_DEFAULTS.trustedActionOrigins).toEqual([])
    expect(SETTINGS_DEFAULTS).toEqual(before)
  })
})

describe('settings constants', () => {
  it('pins the storage key and the control-strip port both ends share', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('dshSettings')
    expect(CONTROL_PORT_NAME).toBe('dsh-control')
  })
})
