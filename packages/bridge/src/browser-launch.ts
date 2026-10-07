/**
 * Launching the user's browser so the extension can load.
 *
 * Every other browser tool executes inside the extension, which means they all
 * need a browser that is already running — and until now the bridge had no way to
 * change that. With the browser closed there is no extension to connect, so the
 * tools failed with `bridge-closed` and the user got a dead end: "the browser is
 * off" is answerable only by starting it, and nothing on the desktop side could.
 *
 * Two facts shape the design, both verified against the browsers on this
 * machine rather than assumed:
 *
 * 1. **A running browser ignores the launch.** Handing `chrome.exe` a flag while
 *    Chrome is already up just opens a window in the existing process; the flag
 *    is discarded. So when a browser is already running, say so instead of
 *    pretending to start something.
 * 2. **The extension cannot be injected into someone else's profile.** Since
 *    Chrome 137, branded Chrome builds removed `--load-extension` entirely
 *    (Chromium and Chrome for Testing still accept it), and even where it works
 *    it only lasts for that session — it is not installed. So the useful launch
 *    is an ordinary one, into the profile where the extension is *already*
 *    installed: the background worker comes back on its own and connects.
 *
 * The honest consequence: the first time, the user installs the extension (store,
 * or "load unpacked" once). After that, a plain launch is enough and this module
 * makes it automatic. It does not — and cannot — install an extension for the
 * user, so it never claims to have.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** One candidate executable and where the path came from. */
export interface BrowserCandidate {
  /** Short id used in messages (`chrome`, `edge`, `brave`, `chromium`, `firefox`). */
  id: string
  /** Absolute path or bare command name. */
  path: string
  /** True when the path exists (a bare command name is resolved by the OS). */
  exists: boolean
}

/**
 * Everything the launcher needs, resolved from plugin config.
 *
 * Paths are injectable so the whole decision surface is unit-testable without
 * starting a process or requiring a browser to be installed.
 */
export interface LaunchDeps {
  /** Explicit executable; when set, detection is skipped entirely. */
  executablePath?: string
  /**
   * Unpacked extension directory to load. Only used when it exists on disk —
   * passing a stale path would have Chrome refuse the whole launch.
   */
  extensionPath?: string
  /**
   * Chrome/Chromium only: profile directory that carries the session the browser
   * reuses. Required for `--load-extension` to take effect at all on 137+.
   */
  userDataDir?: string
  /** Extra command-line arguments appended verbatim. */
  extraArgs?: readonly string[]
  /**
   * Start without a visible window. Used by the e2e suite and by anyone driving
   * the bridge on a machine with no display; a normal launch leaves it off.
   */
  headless?: boolean
  /** How long to wait for the extension to connect; defaults to 25s. */
  timeoutMs?: number
  /** Injected for tests. */
  exists?: (path: string) => boolean
  /** Injected for tests. */
  spawnDetached?: (command: string, args: readonly string[]) => void
  /** Injected for tests: the process listing `probeRunningBrowsers` reads. */
  processListing?: (platform: NodeJS.Platform) => Promise<{ name: string; commandLine: string }[] | undefined>
  /**
   * Injected for tests: the executable of the user's *default* browser.
   *
   * Preferred over detection, because the user asked to drive the browser they
   * already use — a different Chromium means a different profile, with none of
   * their sessions. Returns undefined when the platform does not record it.
   */
  executableOfDefaultBrowser?: (platform: NodeJS.Platform) => string | undefined
  /**
   * Injected for tests: which browsers already have this extension installed.
   *
   * Decides whether a launch can possibly work, and lets the message name the
   * real situation ("it is not installed anywhere") instead of proposing steps
   * that cannot help.
   */
  browsersWithExtension?: (platform: NodeJS.Platform) => string[]
  /** Injected for tests. */
  waitForConnection?: (timeoutMs: number) => Promise<boolean>
  /**
   * Injected for tests: whether a browser is already running, and with which
   * profile. Detecting this is what stops the bridge from "launching" a browser
   * that is already up (which silently does nothing to the running instance).
   */
  probeRunning?: (candidates: readonly BrowserCandidate[], wantedUserDataDir: string | undefined) => Promise<RunningBrowser[]>
  /** Injected for tests; defaults to the real platform. */
  platform?: NodeJS.Platform
  /** Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Injected for tests: whether the running browser has a visible window.
   *
   * A Chromium process outlives its windows — closing the last window can leave the
   * process resident, and the extension keeps its socket open — so "connected" and
   * "there is a window to act on" are different questions. Only a definite `false`
   * is acted on; `undefined` means this platform could not be asked.
   */
  visibleWindow?: (candidates: readonly BrowserCandidate[]) => Promise<boolean | undefined>
}

/** A live browser process, as far as the probe can tell. */
export interface RunningBrowser {
  /** Detected id (`chrome`, `edge`, …), or `other` when it did not match a known path. */
  id: string
  /** `--user-data-dir` value, or `''` for the platform's default profile. */
  userDataDir: string
}

/** What one launch attempt ended as, for the tool result. */
export interface LaunchOutcome {
  /** Whether a browser process was actually started. */
  launched: boolean
  /** Whether a browser the launch could use was found and targeted. */
  resolved: boolean
  connected: boolean
  /** Human- and model-readable summary, always non-empty. */
  message: string
  /**
   * The extensions page for the browser in play, when the user has to act there.
   *
   * Present exactly when the extension is not installed in any profile the bridge
   * can see — the situation with no automatic way out. Carrying the address means
   * neither the model nor the user has to work out which page to open; a reader
   * who is told "install it" without a destination is the dead end this avoids.
   */
  installUrl?: string
}

/** The page where a browser can load or enable an extension. */
export function extensionsPageUrl(browserId: string): string {
  if (browserId === 'edge') return 'edge://extensions/'
  // Chromium, Brave and Chrome all use Chrome's scheme.
  return 'chrome://extensions/'
}

/**
 * Directory name this extension installs under, used to check whether a profile
 * already has it.
 *
 * A copy of `DEFAULT_EXTENSION_ID`: this module must not import the plugin entry
 * (that would be a cycle), and `tests/extension-identity.spec.ts` asserts the two
 * agree with the manifest's `key`.
 */
const EXTENSION_DIRECTORY_NAME = 'kdhkdgfcinfkmogifamoapmheihhcjfk'

const DEFAULT_LAUNCH_TIMEOUT_MS = 25_000

/** True only for an absolute `http:`/`https:` URL. */
export function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** A web address to open, trimmed, or undefined when it is not one. */
export function webUrlOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed !== '' && isWebUrl(trimmed) ? trimmed : undefined
}

/**
 * Arguments for one launch.
 *
 * A launch of the user's own browser is an *ordinary* launch: just the executable,
 * nothing else. No `--user-data-dir` (that would be a different profile — a
 * different browser from the user's point of view, with none of their tabs or
 * logins) and no `--load-extension` (an unpacked load lasts one session and
 * installs nothing, and since Chrome 137 a branded build ignores it anyway).
 *
 * The flags exist only for the one case that genuinely needs them: a launch into a
 * profile the caller named explicitly, which is how a development or test build
 * comes up. `extensionPath` is therefore ignored unless `userDataDir` is set.
 *
 * @param deps - extension dir, profile, extra args, headless.
 * @param url - a page to open; omit it and the browser opens its own new tab.
 * @returns the argument list.
 */
export function buildLaunchArgs(
  deps: Pick<LaunchDeps, 'extensionPath' | 'userDataDir' | 'extraArgs' | 'headless'>,
  url?: string,
): string[] {
  const args: string[] = []
  const namedProfile = deps.userDataDir !== undefined && deps.userDataDir !== ''
  if (namedProfile) {
    args.push(`--user-data-dir=${deps.userDataDir ?? ''}`)
  }
  // The unpacked load only means anything inside a named profile.
  const loadingExtension = namedProfile && deps.extensionPath !== undefined && deps.extensionPath !== ''
  if (loadingExtension) {
    // Chromium honours the flag as-is; a branded Chrome build ignores it either
    // way, so this only matters for Chromium/Chrome-for-Testing profiles.
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch')
    args.push(`--load-extension=${deps.extensionPath ?? ''}`)
    args.push(`--disable-extensions-except=${deps.extensionPath ?? ''}`)
  }
  if (deps.headless === true) {
    // `new` is the mode that still runs extensions; the legacy one does not.
    args.push('--headless=new')
  }
  // A URL becomes a *command-line argument*, so it is treated as one: only a real
  // http/https address is passed through, or a caller-supplied string like
  // `--headless` would be read by the browser as a switch rather than as a page.
  // No URL means the browser opens whatever it normally opens — the new tab page,
  // or the restored session — and a placeholder is never substituted for that.
  if (url !== undefined && url !== '' && isWebUrl(url)) args.push(url)
  for (const extra of deps.extraArgs ?? []) args.push(extra)
  return args
}

/** Well-known install locations per platform, most common first. */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { chrome: string[]; edge: string[]; brave: string[]; chromium: string[]; firefox: string[] } {
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env['LOCALAPPDATA'] ?? ''
    return {
      chrome: [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...(localAppData === '' ? [] : [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
      ],
      edge: [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
      brave: [
        join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ...(localAppData === '' ? [] : [join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]),
      ],
      chromium: [
        ...(localAppData === '' ? [] : [join(localAppData, 'Chromium', 'Application', 'chrome.exe')]),
      ],
      firefox: [
        join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
        join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    }
  }
  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chrome'],
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    firefox: ['/usr/bin/firefox', '/snap/bin/firefox'],
  }
}

/** Detection order: Chromium-family browsers first, Firefox (no side panel) last. */
const DETECTION_ORDER = ['chrome', 'edge', 'brave', 'chromium', 'firefox'] as const

/**
 * Where a browser keeps its profiles, per platform.
 *
 * Used to answer the only question that decides whether starting a browser can
 * help: is this extension actually installed in it? A launch cannot install one.
 */
export function userDataRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? ''
    return {
      chrome: windowsPath(local, 'Google', 'Chrome', 'User Data'),
      edge: windowsPath(local, 'Microsoft', 'Edge', 'User Data'),
      brave: windowsPath(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      chromium: windowsPath(local, 'Chromium', 'User Data'),
      firefox: windowsPath(env['APPDATA'] ?? '', 'Mozilla', 'Firefox', 'Profiles'),
    }
  }
  if (platform === 'darwin') {
    return {
      chrome: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Google', 'Chrome'),
      edge: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Microsoft Edge'),
      brave: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
      chromium: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Chromium'),
      firefox: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Firefox', 'Profiles'),
    }
  }
  const config = env['XDG_CONFIG_HOME'] ?? posixPath(env['HOME'] ?? '', '.config')
  return {
    chrome: posixPath(config, 'google-chrome'),
    edge: posixPath(config, 'microsoft-edge'),
    brave: posixPath(config, 'BraveSoftware', 'Brave-Browser'),
    chromium: posixPath(config, 'chromium'),
    firefox: posixPath(env['HOME'] ?? '', '.mozilla', 'firefox'),
  }
}

/**
 * Build a Windows profile path with backslashes, whatever platform builds it.
 *
 * `join` uses the host separator, which would make the Windows layout depend on
 * where the test happened to run. These paths are always compared against
 * Windows-style values, so they are built as such.
 */
function windowsPath(root: string, ...parts: string[]): string {
  if (root === '') return ''
  return [root, ...parts].join('\\')
}

/**
 * Build a POSIX profile path with forward slashes, whatever platform builds it.
 *
 * The same reason as {@link windowsPath}: platform-dependent separators from the
 * host would change a macOS or Linux layout depending on where the caller runs.
 */
function posixPath(root: string, ...parts: string[]): string {
  if (root === '') return ''
  return [root.replace(/\/+$/u, ''), ...parts].join('/')
}

/**
 * Whether a browser profile already has this extension installed.
 *
 * Installing is a user action — the store, or "load unpacked" once — and no
 * command-line flag substitutes for it; an unpacked load lasts one session and is
 * gone at the next start (verified). So this answers the question that decides
 * the outcome of a launch, and lets the bridge say which of the two situations
 * the user is actually in instead of guessing.
 *
 * @param platform - target platform.
 * @param env - environment, for the profile roots above.
 * @param extensions - directory name of the extension, or undefined to skip.
 * @param exists - filesystem probe, injected for tests.
 * @returns the browser ids whose default profile has the extension.
 */
export function browsersWithExtensionInstalled(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  extensions: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (extensions === undefined || extensions === '') return []
  const roots = userDataRoots(platform, env)
  const installed: string[] = []
  // Built with the target platform's separator, not the host's: these values are
  // compared against paths that come from the browser itself.
  const under = (root: string, ...parts: string[]): string => platform === 'win32'
    ? windowsPath(root, ...parts)
    : posixPath(root, ...parts)
  for (const id of DETECTION_ORDER) {
    const root = roots[id]
    if (root === undefined || root === '') continue
    // Chrome-family keeps profiles as `Default`/`Profile N`; the extension itself
    // lives under `<profile>/Extensions/<id>`.
    const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3']
    const found = profiles.some((profile) => exists(under(root, profile, 'Extensions', extensions)))
    if (found) installed.push(id)
  }
  return installed
}

/**
 * The executable of the user's default browser, when the platform records it.
 *
 * The user asked to drive *their* browser, so this is preferred over the first
 * detected install: launching a different Chromium would be a browser they do not
 * use, with none of their sessions. Windows and macOS both record the choice;
 * Linux exposes it only through `xdg-settings`, which is not a file, so it is
 * left to the caller's fallback rather than guessed here.
 *
 * @param platform - target platform.
 * @param readDefault - returns the recorded command or app bundle id.
 * @param exists - filesystem probe, injected for tests.
 * @returns an absolute executable path, or undefined when it cannot be resolved.
 */
export function defaultBrowserExecutable(
  platform: NodeJS.Platform,
  readDefault: () => string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const recorded = readDefault()
  if (recorded === undefined || recorded === '') return undefined
  if (platform === 'darwin') {
    // LaunchServices reports a bundle id such as `com.google.Chrome`; only the two
    // that ship this extension's host browser are mapped, and an unknown one falls
    // back to detection rather than to a guess.
    const bundles: Record<string, string> = {
      'com.google.chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'com.microsoft.edgemac': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'org.chromium.chromium': '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'com.brave.browser': '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    }
    const path = bundles[recorded.toLowerCase()]
    return path !== undefined && exists(path) ? path : undefined
  }
  // Windows records a command line like `"C:\...\chrome.exe" --single-argument %1`.
  const quoted = /^"([^"]+)"/u.exec(recorded)
  const first = quoted?.[1] ?? recorded.split(' ')[0]
  if (first === undefined || first === '') return undefined
  return exists(first) ? first : undefined
}

/** Registry value that names the default browser on Windows. */
function readWindowsDefaultBrowser(): string | undefined {
  try {
    // Synchronous on purpose: this runs once, inside a launch the user is waiting on.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const key = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'
    const output = execFileSync('reg', ['query', key, '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true })
    const match = /ProgId\s+REG_SZ\s+(\S+)/u.exec(output)
    const progId = match?.[1]
    if (progId === undefined) return undefined
    // The ProgId names the handler, not the path; its shell\open\command does.
    const command = execFileSync('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], { encoding: 'utf8', windowsHide: true })
    const commandMatch = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/u.exec(command)
    return commandMatch?.[1]?.trim()
  } catch {
    return undefined
  }
}

/**
 * The default browser's bundle id on macOS.
 *
 * LaunchServices records the choice in the user's preferences; the bundle id it
 * returns is what {@link defaultBrowserExecutable} maps to an app path. Reading a
 * preference is best-effort — a locked-down or freshly-imaged machine may not have
 * the key — and an absent answer simply falls through to detection.
 */
function readMacDefaultBrowser(): string | undefined {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const plist = execFileSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    // The first handler for the public http scheme is the one that answers links.
    const httpScheme = /LSHandlerURLScheme\s*=\s*"?https?"?;[\s\S]{0,400}?LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/u.exec(plist)
    return httpScheme?.[1]
  } catch {
    return undefined
  }
}

/** The platform's own record of which browser opens a link, when it has one. */
export function systemDefaultBrowser(platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return readWindowsDefaultBrowser()
  if (platform === 'darwin') return readMacDefaultBrowser()
  return undefined
}

/**
 * Every candidate in detection order, with an `exists` flag.
 *
 * @param platform - target platform.
 * @param env - environment for the platform's install roots.
 * @param exists - filesystem probe, injected for tests.
 * @returns the candidates, unfiltered, so the caller can report what was looked at.
 */
export function detectBrowsers(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): BrowserCandidate[] {
  const groups = browserCandidates(platform, env)
  const found: BrowserCandidate[] = []
  for (const id of DETECTION_ORDER) {
    for (const path of groups[id]) {
      found.push({ id, path, exists: exists(path) })
    }
  }
  return found
}

/** Distinct browser ids present in a candidate list, in first-seen order. */
function distinctIds(candidates: readonly BrowserCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.id))]
}

/**
 * Which browsers are running right now, and with which profile.
 *
 * Needed because a launch against a browser that is already up is a no-op on the
 * running instance: Windows/macOS/Linux browsers all hand the request to the
 * existing process and discard the flags. Reporting "it is already running" is
 * the only useful answer in that state.
 *
 * Reads the process list only; nothing is started or signalled.
 *
 * @param platform - target platform.
 * @param known - detected candidates, used to recognise executables.
 * @returns one entry per running browser process, de-duplicated by profile.
 */
export async function probeRunningBrowsers(
  platform: NodeJS.Platform,
  known: readonly BrowserCandidate[],
  listing: (platform: NodeJS.Platform) => Promise<{ name: string; commandLine: string }[] | undefined> = processListing,
): Promise<RunningBrowser[]> {
  const rows = await listing(platform)
  if (rows === undefined) return []
  const executableNames = new Map<string, string>()
  for (const candidate of known) {
    const name = candidate.path.replaceAll('/', '\\').split('\\').pop()
    // First writer wins: Chromium's executable is also called `chrome.exe`, and
    // the entries are in detection order, so a running Chrome must not be
    // reported as "chromium" just because that entry came later.
    if (name !== undefined && name !== '' && !executableNames.has(name.toLowerCase())) {
      executableNames.set(name.toLowerCase(), candidate.id)
    }
  }
  const seen = new Set<string>()
  const running: RunningBrowser[] = []
  for (const { name, commandLine } of rows) {
    const id = executableNames.get(name.toLowerCase())
    if (id === undefined) continue
    const match = /--user-data-dir=(?:"([^"]+)"|(\S+))/u.exec(commandLine)
    const userDataDir = match === null ? '' : (match[1] ?? match[2] ?? '')
    const key = `${id}\u0000${userDataDir}`
    if (seen.has(key)) continue
    seen.add(key)
    running.push({ id, userDataDir })
  }
  return running
}

/** `tasklist`/`ps` output as `{ name, commandLine }`, or undefined when unavailable. */
async function processListing(platform: NodeJS.Platform): Promise<{ name: string; commandLine: string }[] | undefined> {
  const { execFile } = await import('node:child_process')
  const attempts: { command: string; args: string[]; parse: (stdout: string) => { name: string; commandLine: string }[] }[] =
    platform === 'win32'
      ? [
          { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_GET_CIM], parse: parsePipeSeparated },
          { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_GET_WMI], parse: parsePipeSeparated },
          // `wmic` is absent from current Windows builds; kept last for old ones.
          { command: 'wmic', args: ['process', 'get', 'Name,CommandLine', '/format:csv'], parse: parseWmicCsv },
        ]
      : [{ command: 'ps', args: ['-Axo', 'comm=,args='], parse: parsePs }]

  for (const attempt of attempts) {
    const stdout = await runOnce(execFile, attempt.command, attempt.args)
    if (stdout === undefined) continue
    const parsed = attempt.parse(stdout)
    // An empty list from a command that ran is a real answer ("nothing running"),
    // but a command that produced nothing at all is not — try the next one.
    if (parsed.length > 0 || attempt.command === 'ps') return parsed
  }
  return undefined
}

/** PowerShell: one `Name|CommandLine` pair per process. */
const WIN_GET_CIM = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.Name)|$($_.CommandLine)" }'
/** Fallback for hosts with the older cmdlet only. */
const WIN_GET_WMI = 'Get-WmiObject Win32_Process | ForEach-Object { "$($_.Name)|$($_.CommandLine)" }'

/**
 * PowerShell: how many visible top-level windows each browser process owns.
 *
 * `MainWindowHandle` is 0 for a process that has no window, which is exactly the
 * state this exists to detect. Emitted as `name=count` so one shell call answers for
 * every browser at once, and a process name with no windows is reported as `0`
 * rather than omitted.
 *
 * Two properties are needed, and the first one is the reason this exists in the form
 * it does. Both were found by **running** the command, not by reading it, and the
 * second is a trap that reads as correct:
 *
 * 1. **`Get-Process -Name a,b,c` fails outright when any one name is absent.** A
 *    machine without Brave or Chromium terminated the whole command — `-ErrorAction
 *    SilentlyContinue` does not rescue it — so the probe answered nothing at all on
 *    exactly the machines it was written for. Reading every process and filtering by
 *    name afterwards makes an absent browser harmless (this is what the `-in @(...)`
 *    list is for).
 * 2. **The count has to reach a local before the format operator.** Inlining the
 *    `Where-Object … ).Count` expression into `-f` produced a line with the name and no
 *    count — `chrome` instead of `chrome=1` — which the parser then reads as "reported
 *    zero windows", i.e. the opposite of the truth, and the opposite of the safe
 *    direction.
 *
 * Inner double quotes in the command text are fine: the quoted command is passed as a
 * single `execFile` argument and reaches PowerShell intact.
 */
const WIN_WINDOW_COUNTS = [
  'Get-Process -ErrorAction SilentlyContinue |',
  'Where-Object { $_.ProcessName -in @("chrome","msedge","brave","chromium") } |',
  'Group-Object ProcessName |',
  'ForEach-Object { $n = $_.Name;',
  '$c = ($_.Group | Where-Object { $_.MainWindowHandle -ne 0 }).Count;',
  'Write-Output ("{0}={1}" -f $n, $c) }',
].join(' ')

/**
 * Read `name=count` lines: true if any browser has a window, false if browsers are up
 * without one, and undefined when the output carried no usable answer at all.
 *
 * `undefined` is not pedantry. A probe that cannot answer must not be read as "no
 * window", because the caller opens a browser window on that answer.
 */
function parseWindowCounts(stdout: string): boolean | undefined {
  let sawBrowser = false
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^([^=\s]+)=(\d+)$/u.exec(line.trim())
    if (match === null) continue
    sawBrowser = true
    if (Number(match[2]) > 0) return true
  }
  return sawBrowser ? false : undefined
}

/** AppleScript: the number of windows the named app has open. */
function macWindowCountScript(appName: string): string {
  return `tell application "System Events" to if exists process "${appName}" `
    + `then return count of windows of process "${appName}" else return -1`
}

/**
 * Whether a running browser has a visible window, or `undefined` when unknown.
 *
 * A Chromium process outlives its windows: closing the last window can leave the
 * process resident while the extension keeps its socket open, so the bridge sees a
 * healthy connection and every page tool then fails with "no active tab". Asking the
 * window manager is the only way to tell that state apart from a browser that is
 * genuinely usable — and `undefined` is a real answer, meaning this platform could
 * not be asked, so callers must not treat it as "no window".
 *
 * @param platform - the platform whose window manager to ask.
 * @param candidates - the browsers to look for.
 * @param run - the command runner; injected by tests so the parsing and the
 *   branch it drives are checked without starting a shell.
 * @returns true (a window exists), false (running without one), or undefined.
 */
export async function hasVisibleBrowserWindow(
  platform: NodeJS.Platform,
  candidates: readonly BrowserCandidate[],
  run: (command: string, args: readonly string[]) => Promise<string | undefined> = defaultRunOnce,
): Promise<boolean | undefined> {
  const windowExecutables = candidateExecutables(candidates, platform)
  if (windowExecutables.length === 0) return undefined

  if (platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_WINDOW_COUNTS])
    if (stdout === undefined) return undefined
    return parseWindowCounts(stdout)
  }

  if (platform === 'darwin') {
    let sawBrowser = false
    for (const appName of windowExecutables) {
      const stdout = await run('osascript', ['-e', macWindowCountScript(appName)])
      if (stdout === undefined) continue
      const count = Number(stdout.trim())
      if (!Number.isFinite(count)) continue
      if (count > 0) return true
      if (count === 0) sawBrowser = true
    }
    return sawBrowser ? false : undefined
  }

  // Linux has as many window managers as distributions; guessing would risk
  // launching a browser the user did not ask for, so this answer is withheld.
  return undefined
}

/** The real command runner; `runOnce` needs an `execFile` it does not have yet. */
async function defaultRunOnce(command: string, args: readonly string[]): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  return await runOnce(execFile, command, args)
}

/** The candidate app/process names to ask the window manager about. */
function candidateExecutables(candidates: readonly BrowserCandidate[], platform: NodeJS.Platform): string[] {
  const names: string[] = []
  for (const candidate of candidates) {
    const file = candidate.path.replaceAll('/', '\\').split('\\').pop() ?? ''
    const stem = file.replace(/\.exe$/iu, '')
    if (stem === '') continue
    // macOS names the application bundle, not the process; the mapping is fixed and
    // short, and an unknown bundle is simply skipped.
    const name = platform === 'darwin'
      ? ({ chrome: 'Google Chrome', chromium: 'Chromium', msedge: 'Microsoft Edge', brave: 'Brave Browser' } as Record<string, string>)[stem.toLowerCase()]
      : stem
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

function runOnce(
  execFile: typeof import('node:child_process').execFile,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error !== null ? undefined : stdout)
    })
  })
}

/** `Name|CommandLine` lines, as the PowerShell commands above emit them. */
export function parsePipeSeparated(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('|')
    if (separator <= 0) continue
    const name = trimmed.slice(0, separator).trim()
    const commandLine = trimmed.slice(separator + 1).trim()
    if (name !== '') parsed.push({ name, commandLine })
  }
  return parsed
}

/** `wmic ... /format:csv` rows: `Node,Name,CommandLine` (old Windows only). */
export function parseWmicCsv(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    // CommandLine may itself contain commas, so only the first two are split off.
    const first = line.indexOf(',')
    if (first === -1) continue
    const second = line.indexOf(',', first + 1)
    if (second === -1) continue
    const name = line.slice(first + 1, second).trim()
    const commandLine = line.slice(second + 1).trim()
    if (name !== '' && commandLine !== '') parsed.push({ name, commandLine })
  }
  return parsed
}

/** `ps -Axo comm=,args=` lines: an executable path, then its arguments. */
export function parsePs(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const space = trimmed.indexOf(' ')
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).split('/').pop() ?? ''
    if (name !== '') parsed.push({ name, commandLine: trimmed })
  }
  return parsed
}

/**
 * Start a browser (if needed) and wait for the extension to connect.
 *
 * The order matters: an already-connected extension means the browser is running
 * and there is nothing to do, so a launch is never started while a working
 * connection exists — **unless the caller has established that the running browser
 * has no window left**. A Chromium process outlives its last window and the
 * extension keeps its socket open while it does, so a live connection is not proof
 * that there is anything to operate; `ignoreConnected` is how that case gets past
 * this early return and asks the resident process for a window.
 *
 * @param deps - resolved configuration and injectable effects.
 * @param connected - whether the bridge currently has an authenticated extension.
 * @param url - optional page to open in the launched browser.
 * @param ignoreConnected - start anyway, for the known windowless case above.
 * @returns what happened, in words that name the next step.
 */
export async function launchBrowser(
  deps: LaunchDeps,
  connected: () => boolean,
  url?: string,
  ignoreConnected = false,
): Promise<LaunchOutcome> {
  if (!ignoreConnected && connected()) {
    return { launched: false, resolved: true, connected: true, message: 'The browser is already running and connected; nothing to launch.' }
  }

  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const candidates = detectBrowsers(platform, env, exists)

  // Preference order: the browser the user actually uses, then an explicitly
  // configured one, then the first Chromium-family install found. Never a
  // different browser than the user's own unless they asked for one by path.
  const readDefault = deps.executableOfDefaultBrowser
    ?? ((target: NodeJS.Platform) => defaultBrowserExecutable(target, () => systemDefaultBrowser(target)))
  const defaultExecutable = readDefault(platform)
  const configured = deps.executablePath !== undefined && deps.executablePath !== '' ? deps.executablePath : undefined
  const chosen: BrowserCandidate | undefined = defaultExecutable !== undefined && exists(defaultExecutable)
    ? { id: 'default', path: defaultExecutable, exists: true }
    : configured !== undefined
      ? { id: 'configured', path: configured, exists: true }
      : candidates.find((candidate) => candidate.exists)
  const browsersWithExtension = deps.browsersWithExtension
    ?? ((target: NodeJS.Platform) => browsersWithExtensionInstalled(target, env, EXTENSION_DIRECTORY_NAME, exists))

  if (chosen === undefined) {
    return {
      launched: false,
      resolved: false,
      connected: false,
      message: 'No browser executable was found, so the browser could not be started. '
        + `Looked for: ${distinctIds(candidates).join(', ')} (none present). `
        + 'Ask the user to open their browser — the extension connects on its own once it starts — '
        + 'or set browserExecutablePath in the bridge plugin config.',
    }
  }

  // A browser that is already up will not load anything new from this command:
  // the request is handed to the running process and the flags are discarded.
  // Launching the user's *default* profile is exactly that case, so this check is
  // what stops the bridge from opening a pointless second window.
  const probeRunning = deps.probeRunning ?? ((known, wanted) => defaultProbeRunning(platform, known, wanted, deps.processListing))
  const running = await probeRunning(candidates, deps.userDataDir)
  const ownProfile = deps.userDataDir !== undefined && deps.userDataDir !== ''
  const runningSameProfile = running.some((browser) => ownProfile
    ? browser.userDataDir === deps.userDataDir
    : browser.userDataDir === '')
  if (running.length > 0 && !ownProfile && runningSameProfile) {
    const installed = browsersWithExtension(platform)
    const browserId = running[0]?.id ?? 'chrome'
    return {
      launched: false,
      resolved: true,
      connected: false,
      message: `${browserId} is already running, so starting it again would only open a window in the existing one — no extension would load from it. `
        + (installed.length > 0
          ? `The extension is installed in ${installed.join(', ')}; ask the user to make sure it is enabled at ${extensionsPageUrl(browserId)}, and the connection returns on its own.`
          : `The extension is not installed in any browser profile on this machine, which is why nothing connects. It has to be installed once at ${extensionsPageUrl(browserId)} (turn on developer mode, then "Load unpacked" and pick the built extension folder), or from the extension store. After that single install a normal start reconnects on its own.`),
      ...(installed.length === 0 ? { installUrl: extensionsPageUrl(browserId) } : {}),
    }
  }

  const loadableExtension = deps.extensionPath !== undefined && deps.extensionPath !== '' && exists(deps.extensionPath)
    ? deps.extensionPath
    : undefined

  // A page to open is optional and must be a real web address: the value ends up
  // in the browser's argv (see `buildLaunchArgs`), and an unusable one silently
  // becomes "open the new tab page" rather than being handed to the process.
  const openUrl = webUrlOrUndefined(url)
  const args = buildLaunchArgs(
    {
      ...(loadableExtension === undefined ? {} : { extensionPath: loadableExtension }),
      ...(deps.userDataDir === undefined ? {} : { userDataDir: deps.userDataDir }),
      ...(deps.extraArgs === undefined ? {} : { extraArgs: deps.extraArgs }),
      ...(deps.headless === undefined ? {} : { headless: deps.headless }),
    },
    openUrl,
  )

  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached
  try {
    spawnDetached(chosen.path, args)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      launched: false,
      resolved: true,
      connected: false,
      message: `Starting ${chosen.path} failed: ${detail}. Ask the user to open their browser instead.`,
    }
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const waitForConnection = deps.waitForConnection ?? ((budget: number) => pollForConnection(budget, connected))
  const connectedAfter = await waitForConnection(timeoutMs)

  if (connectedAfter) {
    return {
      launched: true,
      resolved: true,
      connected: true,
      message: `Started ${chosen.path} and the extension connected. Call browser_snapshot to see the page.`,
    }
  }

  const installed = browsersWithExtension(platform)
  const extensionHint = installed.length > 0
    ? `The extension is installed in ${installed.join(', ')}; confirm it is enabled at ${extensionsPageUrl(chosen.id)} and that this browser is the one that profile belongs to.`
    : `The extension is not installed in any browser profile on this machine, so there was nothing to connect. `
      + `It has to be installed once at ${extensionsPageUrl(chosen.id)} (turn on developer mode, then "Load unpacked" and pick the built extension folder), or from the extension store; `
      + 'a command-line load only lasts one session and would have to be repeated every start.'
  return {
    launched: true,
    resolved: true,
    connected: false,
    message: `Started ${chosen.path}, but the extension did not connect within ${Math.round(timeoutMs / 1000)}s. ${extensionHint}`,
    ...(installed.length === 0 ? { installUrl: extensionsPageUrl(chosen.id) } : {}),
  }
}

/** Probe through the real process list, filtered to the profile asked about. */
async function defaultProbeRunning(
  platform: NodeJS.Platform,
  known: readonly BrowserCandidate[],
  wanted: string | undefined,
  listing: LaunchDeps['processListing'],
): Promise<RunningBrowser[]> {
  const running = await probeRunningBrowsers(platform, known, listing ?? processListing)
  if (wanted === undefined || wanted === '') return running
  return running.filter((browser) => browser.userDataDir === wanted)
}

/** Start a process that keeps running after the plugin's own process exits. */
function defaultSpawnDetached(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Open the extensions page in the user's own browser.
 *
 * The one page a user must reach by hand, so it is opened *for* them at the moment
 * the bridge has established they need it. Going through the OS handler rather
 * than a hard-coded browser means the page lands in whichever browser they
 * actually use — including Firefox, which the extension also supports and which no
 * Chromium argument would reach.
 *
 * Failures are swallowed: not being able to open a convenience page must never
 * turn into an error on top of the problem the user already has.
 *
 * @param url - the extensions page (`chrome://extensions/` or `edge://extensions/`).
 * @param spawnDetached - injected for tests; defaults to a detached spawn.
 * @param platform - injected for tests.
 */
export async function openExtensionsPage(
  url: string,
  spawnDetached: (command: string, args: readonly string[]) => void = defaultSpawnDetached,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (url === '') return
  if (!/^(https?:|chrome:\/\/|edge:\/\/)/u.test(url)) return
  const { execFile } = await import('node:child_process')
  const opener = platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'start', '', url] }
    : platform === 'darwin'
      ? { command: 'open', args: [url] }
      : { command: 'xdg-open', args: [url] }
  await new Promise<void>((resolve) => {
    execFile(opener.command, opener.args, { windowsHide: true }, () => { resolve() })
  }).catch(() => {})

  // The `start`/`open` route is the normal one; the executable fallback covers a
  // host where the default handler is not registered for this URL scheme.
  if (platform !== 'win32') return
  try {
    const executable = defaultBrowserExecutable(platform, readWindowsDefaultBrowser)
    if (executable !== undefined) spawnDetached(executable, [url])
  } catch {
    // Nothing to do: the page either opened above or the user can navigate.
  }
}

/**
 * Default connection wait, used when no host-specific one is injected.
 *
 * It must actually wait. An earlier version returned `false` immediately when the
 * caller had not injected a wait, which made a launch look like "started and the
 * extension never came back" within milliseconds — while the plugin's own call
 * site happened to inject a real waiter, so the defect stayed invisible in
 * production and in the injected tests.
 *
 * @param timeoutMs - how long to keep asking.
 * @param isConnected - connection test; the bridge's own `hasConnection`.
 * @returns whether a connection appeared before the deadline.
 */
export async function pollForConnection(timeoutMs: number, isConnected: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isConnected()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => { setTimeout(resolve, 250) })
    // Re-check immediately after the pause: an extension that connects while we
    // sleep must be noticed before the next full interval is spent waiting.
    if (isConnected()) return true
  }
}
