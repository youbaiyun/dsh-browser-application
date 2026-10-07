import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  browsersWithExtensionInstalled,
  buildLaunchArgs,
  browserCandidates,
  defaultBrowserExecutable,
  detectBrowsers,
  extensionsPageUrl,
  hasVisibleBrowserWindow,
  launchBrowser,
  probeRunningBrowsers,
  userDataRoots,
  webUrlOrUndefined,
  type BrowserCandidate,
  type LaunchDeps,
} from '../src/browser-launch.ts'
import { resolveExtensionPath } from '../src/index.ts'

/**
 * Launching the browser is the only browser operation the bridge can perform
 * without an extension, so it is also the only one that must keep working when
 * everything else is unavailable. These tests inject every effect — the
 * filesystem probe, the spawn, the clock — so the whole decision surface is
 * checked without starting a process.
 */

describe('buildLaunchArgs', () => {
  it('adds the profile directory and the feature-flag escape before the extension', () => {
    const args = buildLaunchArgs({ extensionPath: '/repo/extension/dist', userDataDir: '/home/u/.dsh/browser-profile' })
    expect(args).toEqual([
      '--user-data-dir=/home/u/.dsh/browser-profile',
      // Chromium needs this flag to accept the unpacked load at all.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--load-extension=/repo/extension/dist',
      '--disable-extensions-except=/repo/extension/dist',
    ])
  })

  it('never loads the extension into the user\'s own profile, where a session load would install nothing', () => {
    expect(buildLaunchArgs({ extensionPath: '/repo/extension/dist' })).toEqual([])
  })

  it('launches the user\'s browser with no profile flag at all', () => {
    // The whole point: an ordinary launch of the browser they already use, with
    // their own profile and sessions — not a second browser beside it.
    expect(buildLaunchArgs({ extraArgs: [] })).toEqual([])
    expect(buildLaunchArgs({ extensionPath: '/repo/extension/dist', extraArgs: [] })).toEqual([])
  })

  it('adds no URL when none was asked for, so the browser opens its own new tab', () => {
    expect(buildLaunchArgs({ userDataDir: '/tmp/p' })).toEqual(['--user-data-dir=/tmp/p'])
    expect(buildLaunchArgs({}, undefined)).toEqual([])
  })

  it('puts the requested page before the user\'s extra arguments', () => {
    const args = buildLaunchArgs({ extraArgs: ['--no-first-run'] }, 'https://example.com/')
    expect(args).toEqual(['https://example.com/', '--no-first-run'])
  })

  it('refuses to pass anything that is not a web address to the browser', () => {
    // The URL becomes a command-line argument, so a caller-supplied string like
    // `--headless` would be read as a switch instead of as a page.
    for (const hostile of ['--headless', '--load-extension=/tmp/evil', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      expect(buildLaunchArgs({}, hostile)).toEqual([])
    }
    expect(buildLaunchArgs({}, 'http://127.0.0.1:3080/ok')).toEqual(['http://127.0.0.1:3080/ok'])
  })

  it('trims a padded address, which spawn would otherwise pass with the space', () => {
    expect(webUrlOrUndefined(' https://ok.example ')).toBe('https://ok.example')
    expect(webUrlOrUndefined('   ')).toBeUndefined()
    expect(webUrlOrUndefined(undefined)).toBeUndefined()
  })
})

describe('detectBrowsers', () => {
  it('offers Chromium-family paths first on Windows', () => {
    const candidates = browserCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
    expect(candidates.chrome[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(candidates.edge[0]).toContain('msedge.exe')
    expect(candidates.firefox[0]).toContain('firefox.exe')
  })

  it('uses the platform\'s default install roots when the environment does not name them', () => {
    const candidates = browserCandidates('win32', {})
    expect(candidates.chrome[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(candidates.chrome).toHaveLength(2)
  })

  it('keeps Firefox last, because it has no side panel', () => {
    const found = detectBrowsers('linux', {}, () => true)
    const lastChromeFamily = found.findLastIndex((candidate) => candidate.id !== 'firefox')
    expect(found.findIndex((candidate) => candidate.id === 'firefox')).toBeGreaterThan(lastChromeFamily)
  })

  it('reports what exists rather than filtering the list, so a failure can name what was looked at', () => {
    const found = detectBrowsers('linux', {}, (path) => path === '/usr/bin/google-chrome')
    expect(found.filter((candidate) => candidate.exists).map((candidate) => candidate.id)).toEqual(['chrome'])
    expect(found.some((candidate) => candidate.id === 'firefox' && !candidate.exists)).toBe(true)
  })
})

/** Launcher deps with every effect stubbed; overrides name the case under test. */
function deps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    platform: 'linux',
    env: {},
    exists: () => false,
    spawnDetached: () => {},
    waitForConnection: async () => true,
    probeRunning: async () => [],
    timeoutMs: 100,
    ...overrides,
  }
}

describe('browsersWithExtensionInstalled', () => {
  const id = 'kdhkdgfcinfkmogifamoapmheihhcjfk'

  it('finds the extension in a Chrome profile and names only that browser', () => {
    const probe = (path: string): boolean => path === `C:\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\${id}`
    const installed = browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, probe)
    expect(installed).toEqual(['chrome'])
  })

  it('reports nothing when the extension is installed nowhere', () => {
    expect(browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, () => false)).toEqual([])
  })

  it('checks secondary profiles too, not just Default', () => {
    const probe = (path: string): boolean => path.startsWith('C:\\Local\\Google\\Chrome') && path.includes('Profile 2')
    expect(browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, probe)).toEqual(['chrome'])
  })

  it('uses the target platform\'s separators, not the host\'s', () => {
    // The same call must describe a Windows layout whether the test runs on
    // Windows or Linux; `join` would have produced forward slashes on Linux.
    const probed: string[] = []
    browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, (path) => { probed.push(path); return false })
    expect(probed.every((path) => path.includes('\\') && !path.includes('/'))).toBe(true)
  })
})

describe('userDataRoots', () => {
  it('points at the per-platform profile directory', () => {
    expect(userDataRoots('win32', { LOCALAPPDATA: 'C:\\Local' }).chrome).toContain('Chrome')
    expect(userDataRoots('darwin', { HOME: '/Users/u' }).chrome).toBe('/Users/u/Library/Application Support/Google/Chrome')
    expect(userDataRoots('linux', { HOME: '/home/u' }).chrome).toBe('/home/u/.config/google-chrome')
  })
})

describe('defaultBrowserExecutable', () => {
  it('reads a quoted Windows command line and ignores its arguments', () => {
    const path = defaultBrowserExecutable('win32', () => '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1', () => true)
    expect(path).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('does not invent a path that is not there', () => {
    expect(defaultBrowserExecutable('win32', () => '"C:\\gone\\chrome.exe" --x', () => false)).toBeUndefined()
    expect(defaultBrowserExecutable('win32', () => undefined, () => true)).toBeUndefined()
  })

  it('maps a macOS bundle id to the app it names, and nothing else', () => {
    // LaunchServices reports a bundle id; only the browsers this extension can
    // drive are mapped, so an unknown one falls through to detection rather than
    // to a guessed path.
    expect(defaultBrowserExecutable('darwin', () => 'com.google.Chrome', () => true))
      .toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(defaultBrowserExecutable('darwin', () => 'com.apple.Safari', () => true)).toBeUndefined()
    expect(defaultBrowserExecutable('darwin', () => 'COM.MICROSOFT.EDGEMAC', () => true))
      .toBe('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  })
})

describe('extensionsPageUrl', () => {
  it('points each browser at its own page', () => {
    expect(extensionsPageUrl('chrome')).toBe('chrome://extensions/')
    expect(extensionsPageUrl('edge')).toBe('edge://extensions/')
    expect(extensionsPageUrl('brave')).toBe('chrome://extensions/')
  })
})

describe('probeRunningBrowsers', () => {
  const known = detectBrowsers('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86' }, () => true)

  it('reports a browser running on the platform default profile', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
    ])
    expect(running).toEqual([{ id: 'chrome', userDataDir: '' }])
  })

  it('reads a quoted --user-data-dir and de-duplicates the renderer processes', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir="C:\\tmp\\prof" --type=renderer' },
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir="C:\\tmp\\prof"' },
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir=C:\\other' },
    ])
    expect(running).toEqual([
      { id: 'chrome', userDataDir: 'C:\\tmp\\prof' },
      { id: 'chrome', userDataDir: 'C:\\other' },
    ])
  })

  it('ignores executables that are not the detected browsers', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'node.exe', commandLine: 'node server.js' },
      { name: 'msedge.exe', commandLine: 'msedge.exe' },
    ])
    expect(running).toEqual([{ id: 'edge', userDataDir: '' }])
  })

  it('does not mistake a running Chrome for chromium, whose executable shares the name', async () => {
    // Both entries end in `chrome.exe`; the first match must win, or the message
    // names the wrong browser.
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
    ])
    expect(running).toEqual([{ id: 'chrome', userDataDir: '' }])
  })

  it('reports nothing when the process listing is unavailable', async () => {
    expect(await probeRunningBrowsers('linux', known, async () => undefined)).toEqual([])
  })
})

describe('launchBrowser', () => {
  it('does not start anything when the extension is already connected', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(deps({ spawnDetached }), () => true)
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ launched: false, connected: true })
  })

  it('starts a detected browser and reports the connection', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({ exists: (path) => path === '/usr/bin/google-chrome', spawnDetached }),
      () => false,
      'https://example.com/',
    )
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', ['https://example.com/'])
    expect(outcome).toMatchObject({ launched: true, connected: true })
    expect(outcome.message).toContain('extension connected')
  })

  it('launches without loading the extension, because a session load installs nothing', async () => {
    // With no extensionPath configured the plain launch is the point: the profile
    // is where the extension already lives.
    const spawnDetached = vi.fn()
    await launchBrowser(deps({ exists: (path) => path === '/usr/bin/google-chrome', spawnDetached }), () => false)
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('starts the user\'s default browser, not a second one, with no flags', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({
        exists: () => true,
        executableOfDefaultBrowser: () => '/usr/bin/google-chrome',
        extensionPath: '/repo/extension/dist',
        spawnDetached,
      }),
      () => false,
    )
    // No profile and no extension flag: the browser they already use, opened as usual.
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('refuses to "launch" when the default-profile browser is already running', async () => {
    // A second launch hands the request to the running process and discards the
    // flags, so opening a window and claiming a launch would be a lie.
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        spawnDetached,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
      }),
      () => false,
    )
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome.launched).toBe(false)
    expect(outcome.message).toContain('already running')
    // And it names the page the user has to act on, so nobody is left hunting.
    expect(outcome.message).toContain('chrome://extensions/')
    expect(outcome.installUrl).toBe('chrome://extensions/')
  })

  it('names the browser\'s own extensions page when the extension is installed but not connected', async () => {
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }],
        browsersWithExtension: () => ['edge'],
      }),
      () => false,
    )
    expect(outcome.message).toContain('already running')
    expect(outcome.message).toContain('edge://extensions/')
    // Installed already: nothing to install, so no install link is offered.
    expect(outcome.installUrl).toBeUndefined()
  })

  it('says the extension is installed nowhere when that is the case', async () => {
    // The honest diagnosis: no launch can help until it is installed once.
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        browsersWithExtension: () => [],
      }),
      () => false,
    )
    expect(outcome.message).toContain('not installed in any browser profile')
    expect(outcome.message).toContain('install')
  })

  it('prefers the user\'s default browser over the first detected install', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome' || path === '/opt/edge/msedge',
        executableOfDefaultBrowser: () => '/opt/edge/msedge',
        spawnDetached,
      }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalledWith('/opt/edge/msedge', [])
  })

  it('still launches when the running browser uses a different profile', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        spawnDetached,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '/tmp/other' }],
      }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalled()
    expect(outcome).toMatchObject({ launched: true, connected: true })
  })

  it('prefers an explicitly configured executable and ignores detection', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({ executablePath: '/opt/x/chrome', exists: () => false, spawnDetached }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalledWith('/opt/x/chrome', [])
  })

  it('names every browser it looked for when none is present', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(deps({ spawnDetached }), () => false)
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome.launched).toBe(false)
    expect(outcome.message).toContain('chrome')
    expect(outcome.message).toContain('firefox')
    expect(outcome.message).toContain('browserExecutablePath')
  })

  it('passes the extension only when the directory exists', async () => {
    // The probe answers for both the browser and the extension: detection must
    // still find a browser, and only an existing extension dir may be loaded.
    const existing = vi.fn((path: string) => path === '/repo/extension/dist' || path === '/usr/bin/google-chrome')
    const spawnDetached = vi.fn()
    await launchBrowser(deps({ extensionPath: '/repo/extension/dist', userDataDir: '/tmp/profile', exists: existing, spawnDetached }), () => false)
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [
      '--user-data-dir=/tmp/profile',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--load-extension=/repo/extension/dist',
      '--disable-extensions-except=/repo/extension/dist',
    ])

    const missing = vi.fn((path: string) => path === '/usr/bin/google-chrome')
    const second = vi.fn()
    await launchBrowser(deps({ extensionPath: '/gone/dist', exists: missing, spawnDetached: second }), () => false)
    expect(second).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('says the launch happened but the extension stayed away, and why that might be', async () => {
    const outcome = await launchBrowser(
      deps({ exists: (path) => path === '/usr/bin/google-chrome', waitForConnection: async () => false, timeoutMs: 1_000 }),
      () => false,
    )
    expect(outcome).toMatchObject({ launched: true, connected: false })
    expect(outcome.message).toContain('did not connect within 1s')
  })

  it('waits for the connection by default instead of reporting immediately', async () => {
    // A directly constructed launcher (no injected waiter) used to return
    // "not connected" in the same millisecond it started the browser. The shared
    // helper injects a waiter, so this case must remove it to exercise the default.
    let asked = 0
    const withoutWaiter = deps({ exists: (path) => path === '/usr/bin/google-chrome' })
    delete withoutWaiter.waitForConnection
    const outcome = await launchBrowser(withoutWaiter, () => { asked += 1; return asked > 1 })
    expect(asked).toBeGreaterThan(1)
    expect(outcome).toMatchObject({ launched: true, connected: true })
  })

  it('turns a spawn failure into words rather than throwing', async () => {
    const outcome = await launchBrowser(
      deps({ executablePath: '/opt/x/chrome', spawnDetached: () => { throw new Error('EACCES') } }),
      () => false,
    )
    expect(outcome).toMatchObject({ launched: false, connected: false })
    expect(outcome.message).toContain('EACCES')
  })
})

describe('resolveExtensionPath', () => {
  it('uses the configured path as written', () => {
    expect(resolveExtensionPath('/custom/dist', '/repo/packages/bridge/src')).toBe('/custom/dist')
  })

  it('finds the build from src/ and from lib/, whatever machine the package is installed on', () => {
    // A real temporary tree, so the assertion does not depend on this checkout —
    // or on any absolute path a particular machine happens to have. `src` and
    // `lib` sit at different depths; the extension is the sibling either way.
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-path-'))
    try {
      mkdirSync(join(root, 'packages', 'bridge', 'src'), { recursive: true })
      mkdirSync(join(root, 'packages', 'bridge', 'lib'), { recursive: true })
      mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
      writeFileSync(join(root, 'extension', 'dist', 'manifest.json'), '{}')
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'src'))).toBe(join(root, 'extension', 'dist'))
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'lib'))).toBe(join(root, 'extension', 'dist'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores a directory that is not a built extension', () => {
    // An unrelated `extension/dist` above the installed package must not be
    // passed to `--load-extension`: Chrome refuses to start over a bad path, so
    // the launch would fail rather than fall back.
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-bogus-'))
    try {
      mkdirSync(join(root, 'packages', 'bridge', 'lib'), { recursive: true })
      mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'lib'))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves to nothing when no build is shipped, so a launch passes no extension flag', () => {
    // The normal installed-package case: the extension is not next to the plugin,
    // and an empty result is correct rather than an error.
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-none-'))
    try {
      mkdirSync(join(root, 'lib'), { recursive: true })
      expect(resolveExtensionPath('', join(root, 'lib'))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('hasVisibleBrowserWindow', () => {
  const chrome: BrowserCandidate[] = [{ id: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', exists: true }]

  it('reads a window count out of the one shell call, per browser', async () => {
    // "chrome=2" means two Chrome processes own a window; the answer is yes without
    // asking about the others.
    const stdout = 'chrome=2\r\nmsedge=0\r\n'
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => stdout)).resolves.toBe(true)
  })

  it('reports a running browser with no window as false, which is what makes a launch happen', async () => {
    // A Chromium process outlives its last window, and the extension keeps its socket
    // open while it does — so "connected" said nothing about whether there was a page
    // to act on. This is the state the bridge now acts on.
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => 'chrome=0\r\nmsedge=0\r\n')).resolves.toBe(false)
  })

  it('withholds an answer it cannot stand behind, rather than guessing', async () => {
    // Nothing recognised in the output, a shell that did not run, and a platform
    // whose window manager we do not drive: all three must be "unknown", because a
    // false here opens a browser window the user did not ask for.
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => 'unexpected output')).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => undefined)).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('linux', chrome, async () => 'chrome=1')).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('win32', [], async () => 'chrome=1')).resolves.toBeUndefined()
  })

  it('asks macOS for the app by name, and accepts the first window it finds', async () => {
    const asked: string[] = []
    const run = async (_command: string, args: readonly string[]): Promise<string> => {
      asked.push(args.join(' '))
      return '1'
    }
    await expect(hasVisibleBrowserWindow('darwin', chrome, run)).resolves.toBe(true)
    // The bundle name, not the executable name: that is what System Events knows.
    expect(asked[0]).toContain('Google Chrome')
  })
})
