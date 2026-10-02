import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const workspaceRequire = createRequire(new URL('../../packages/browser/bridge-browser/package.json', import.meta.url))
export const { chromium } = workspaceRequire('playwright-core')

async function executable(path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined
  try {
    await access(path, constants.X_OK)
    return path
  } catch {
    return undefined
  }
}

export function playwrightCacheRoot({ platform = process.platform, env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  if (configured !== undefined && configured !== '' && configured !== '0') {
    return isAbsolute(configured) ? configured : resolve(cwd, configured)
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright')
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright')
}

export function systemBrowserCandidates({
  platform = process.platform,
  requireExtensions = false,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === 'darwin') {
    return requireExtensions
      ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
      : [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
  }
  if (platform === 'linux') {
    return requireExtensions
      ? ['/usr/bin/chromium', '/usr/bin/chromium-browser']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  }
  if (platform === 'win32') {
    // Per-user first: an install that needed no elevation lands under
    // LOCALAPPDATA, and that is the copy the user can actually run.
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const names = requireExtensions
      ? ['Chromium\\Application\\chrome.exe']
      : [
          'Google\\Chrome\\Application\\chrome.exe',
          'Google\\Chrome Beta\\Application\\chrome.exe',
          'Google\\Chrome SxS\\Application\\chrome.exe',
          'Chromium\\Application\\chrome.exe',
          // Edge is Chromium and can load this extension, so it is a legitimate
          // last resort — last, because the project targets Chrome.
          'Microsoft\\Edge\\Application\\msedge.exe',
        ]
    return names.flatMap((name) => [
      join(local, name),
      join(programFiles, name),
      join(programFilesX86, name),
    ])
  }
  return []
}

async function newestPlaywrightChromium({ requireExtensions = false } = {}) {
  const cacheRoot = playwrightCacheRoot()
  let entries
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && (requireExtensions
      ? /^chromium-/u.test(entry.name)
      : /^(?:chromium|chromium_headless_shell)-/u.test(entry.name)))
    .sort((left, right) => right.name.localeCompare(left.name))
  const relativeExecutables = requireExtensions ? [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-linux', 'chrome'],
    ['chrome-win', 'chrome.exe'],
  ] : [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-linux', 'chrome'],
    ['chrome-win', 'chrome.exe'],
    ['headless-shell-mac-arm64', 'headless_shell'],
    ['headless-shell-mac', 'headless_shell'],
    ['headless-shell-linux', 'headless_shell'],
    ['headless-shell-win', 'headless_shell.exe'],
  ]
  for (const entry of candidates) {
    for (const parts of relativeExecutables) {
      const found = await executable(join(cacheRoot, entry.name, ...parts))
      if (found !== undefined) return found
    }
  }
  return undefined
}

export async function findChromiumExecutable(
  override = process.env.PLAYWRIGHT_CHROMIUM_PATH,
  { requireExtensions = false } = {},
) {
  const explicit = await executable(override)
  if (explicit !== undefined) return explicit
  const bundled = await executable(chromium.executablePath())
  if (bundled !== undefined) return bundled
  const cached = await newestPlaywrightChromium({ requireExtensions })
  if (cached !== undefined) return cached
  for (const candidate of systemBrowserCandidates({ requireExtensions })) {
    const found = await executable(candidate)
    if (found !== undefined) return found
  }
  return undefined
}
