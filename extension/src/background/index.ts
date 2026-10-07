/**
 * Browser-execution worker for the dsh desktop app.
 *
 * The desktop GUI remains the conversation surface: this worker keeps one
 * authenticated bridge socket open so the model's `browser_*` tool calls arrive
 * here, dispatches them into a single user-controlled tab, and answers with a
 * text-only result. It also serves the full-page control UI, which adds two
 * powers over the same bridge: an instruction typed there is forwarded to the
 * desktop model (`session.prompt`) and its streamed reply, turn boundaries, and
 * tool progress are relayed back, while a `browser_*` command typed there runs
 * locally through the very same dispatch path and never involves the desktop
 * app. The worker still hosts no conversation of its own: one session, one
 * bounded timeline, no transcript, and nothing persisted.
 *
 * Lifecycle: connecting starts as soon as settings load — there is no switch to
 * turn on, because installing the extension is the choice — and a half-minute
 * `alarms` heartbeat re-arms both the reconnect loop and this MV3 worker. The control page is a
 * full tab: every view state is pushed as one `state` message, and every
 * decision can also be made from an OS notification, so a closed page never
 * blocks a pending approval.
 *
 * @module
 */

import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  VISION_MODEL,
  type BridgeCaps,
  type ServerFrame,
} from '@dsh-browser/protocol'
import { BridgeClient } from './bridge.ts'
import { ImageCache, type CacheSnapshot } from './image-cache.ts'
import { chooseImageSource } from './image-fetch.ts'
import { VisionCoordinator, describeOutcomeText, type VisionSink } from './vision.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import { activitySummary } from './activity.ts'
import { createRpc, type RpcFacade } from './rpc.ts'
import { ControlSession, assistantStreamEvent, sessionEventMessage } from './session.ts'
import {
  BROWSER_TOOL_NAMES,
  dispatchOpenTab,
  dispatchToolCall,
  isTabManagementTool,
  parseHttpUrl,
  requestImageTarget,
  resetTabSnapshot,
  type ContentBudget,
  type TabManagementContext,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { actionCoveredByTrustedOrigins } from '../security/trusted-origins.ts'
import { ApprovalCoordinator, APPROVAL_TIMEOUT_MS, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { getUiLocale } from '../i18n.ts'
import {
  BROWSER_PANEL_MARKER,
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  type ActivityEntry,
  type ControlMessage,
  type ControlState,
  type SessionSummary,
  type Settings,
} from '../settings.ts'
import type { SessionScope } from '../settings.ts'
import type { BridgePolicy } from '@dsh-browser/protocol'

const BRIDGE_KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const ACTIVITY_LIMIT = 8
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000
const LEGACY_RECENT_SESSION_STORAGE_KEY = 'dshRecentSessions'
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/**
 * Local ports a desktop dsh may be serving on:
 * 3080 is the CLI default, and the desktop app pins its loopback Web port in
 * settings (43189 is the documented choice, 19387 the value observed in the
 * wild). A user-specified `bridgeUrl` skips this list entirely.
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189, 19387]

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null

/**
 * What the desktop app allows, as told by the bridge in `hello.ok`.
 *
 * Null until a handshake completes, and treated as "not allowed" while null:
 * the capability is only ever enabled by the app saying so. That direction
 * matters — if a dropped field meant "allowed", a broken handshake would hand
 * out a permission the user never granted.
 */
let bridgePolicy: BridgePolicy | null = null

/** Whether the desktop app has allowed opening pages on the user's behalf. */
function pagesMayBeOpened(): boolean {
  return bridgePolicy?.openPagesForUser === true
}
/** Tail of the settings write queue; every write chains onto it. */
let settingsWrites = Promise.resolve()
let bridge: BridgeClient | null = null
let bridgeStartRevision = 0

const IMAGE_CACHE_STORAGE_KEY = 'dshImageCache'

/**
 * How long a remembered description stays worth restoring.
 *
 * A description is a property of an image rather than of the view that asked for
 * it, so it deserves to outlive one page — but it is a claim about a URL, and a
 * URL can start serving something else. A day covers "I came back to this tab
 * after lunch" without presenting last week's answer as knowledge about today's
 * bytes at the same address.
 */
const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** What actually goes on disk: the snapshot, and when it was taken. */
interface StoredImageCache {
  savedAt: number
  cache: CacheSnapshot
}

/**
 * Persist the cache, because a service worker is not a place to keep state.
 *
 * Chrome may stop this worker between two tool calls and a browser restart always
 * ends it. The cache is the only lever that measurably shortens a recognition —
 * the same image asked twice is 1.02s and then 0.01s — and keeping it only in
 * module scope would tie that to the worker's lifetime, which nothing guarantees.
 *
 * `storage.local`, not `storage.session`: the session store is cleared when the
 * extension reloads, which during development is every rebuild, so the one lever
 * that worked was thrown away exactly when it was being measured. The timestamp
 * above is what keeps a store that now survives a restart from overstating how
 * much is still known.
 */
function persistImageCache(cache: ImageCache): void {
  const payload: StoredImageCache = { savedAt: Date.now(), cache: cache.snapshot() }
  void chrome.storage.local.set({ [IMAGE_CACHE_STORAGE_KEY]: payload }).catch(() => {})
}

/**
 * Restore descriptions kept on disk, discarding a stale or malformed store.
 *
 * Raced by nothing: recognition waits on the bridge handshake, which is slower
 * than one storage read, so a description that was already paid for is in place
 * before the first image can be asked about again.
 */
async function restoreImageCache(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(IMAGE_CACHE_STORAGE_KEY)
    const payload = stored[IMAGE_CACHE_STORAGE_KEY] as Partial<StoredImageCache> | undefined
    if (payload === undefined || typeof payload.savedAt !== 'number') return
    if (Date.now() - payload.savedAt > IMAGE_CACHE_TTL_MS) {
      await chrome.storage.local.remove(IMAGE_CACHE_STORAGE_KEY)
      return
    }
    imageCache.restore(payload.cache)
  } catch {
    // A cache that cannot be read is an empty cache, never a failure to start.
  }
}

/**
 * Image descriptions for this worker: one cache, two transports.
 *
 * Built on first use because it sends through the bridge client, which the
 * assembly creates later. The cache outlives it: a description is a property of
 * an image, not of a connection, so losing the socket must not mean paying for
 * the same image twice.
 */
const imageCache = new ImageCache(200, 2, persistImageCache)
let visionCoordinator: VisionCoordinator | null = null

/**
 * Page text as the last snapshot or delta rendered it.
 *
 * Feeds the cross-modal check's page-wide fallback: a percentage the answer names
 * can be compared against the percentages the page states anywhere, not only
 * against the image's own caption.
 */
let lastPageText = ''

function vision(): VisionCoordinator {
  visionCoordinator ??= new VisionCoordinator({
    cache: imageCache,
    send: (frame) => bridge?.send(frame) ?? false,
    // The desktop states in `hello.ok` whether it will recognize images on this
    // extension's behalf. Until it does, queueing work here would only fill the
    // cache with failures.
    canRelay: () => bridgePolicy?.imageRecognition === true,
    // The desktop relay wins whenever it can answer — it holds the credentials and
    // needs no manifest change. This is the alternative for when it cannot.
    // The endpoint and the model travel together: pointing the browser at another
    // provider while the model id stayed fixed would send a name that provider has
    // never heard of. Both default to the one endpoint and id that are known to
    // work, so nobody has to fill either in.
    // A key is required, though. A direct call without one can only answer 401, and
    // counting that as configured turns "this path was never set up" into an
    // authentication failure about a key nobody wrote — the same misleading shape
    // the relay path already had to be cured of.
    directConfig: () => settings.visionEndpoint === '' || settings.visionApiKey === ''
      ? undefined
      : {
          endpoint: settings.visionEndpoint,
          model: settings.visionModel === '' ? VISION_MODEL : settings.visionModel,
          apiKey: settings.visionApiKey,
        },
    pageText: () => lastPageText,
  })
  return visionCoordinator
}

/** What the tool dispatcher reports back to the vision pipeline. */
function visionSink(): VisionSink {
  return {
    states: (identity) => vision().stateFor(identity),
    // The caller strips markers first: a filled marker holds a description, and a
    // description naming a number would otherwise be checked against itself.
    sawPageText: (text) => { lastPageText = text },
  }
}
/** Gateway RPC facade for the live bridge generation; created and cleared with `bridge`. */
let rpc: RpcFacade | null = null
const controlPorts = new Set<chrome.runtime.Port>()
const affinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
const activity: ActivityEntry[] = []
/** The one session view the control page renders; kept here, never in a page. */
const control = new ControlSession({ changed: () => { broadcastState() } })

/**
 * One in-flight `browser_*` call.
 *
 * `unrestricted` captures the access mode at the moment the frame arrived, so
 * turning the global switch on can never retroactively elevate a call that was
 * already running under approval rules — and turning it off can find every call
 * that still depends on the grant.
 */
interface ActiveToolCall {
  controller: AbortController
  unrestricted: boolean
  settled: Promise<void>
  settle: () => void
}
/** Ephemeral allowlist: cleared when this worker restarts or the user empties it. */
const sessionTrustedActionOrigins = new Set<string>()
/** Live tool calls, so a cancel, a revoke, or a disconnect can withdraw them. */
const activeToolCalls = new Map<string, ActiveToolCall>()
let affinityReady = Promise.resolve()
let settingsReady = Promise.resolve()

// ---- Settings ----

async function loadSettings(): Promise<void> {
  let stored: Record<string, unknown> = {}
  try {
    stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  } catch {
    // A storage-less context still works with defaults for this worker's life.
  }
  const loaded = normalizeSettings(stored[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined)
  // The old build stored an explicit localhost URL that the discovery path now
  // covers; keeping it would pin the extension to one port forever.
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
  }
  settings = loaded
  // Rewrite the migrated value through the shared queue so a legacy localhost
  // address cannot be re-saved behind a newer patch.
  void persistSettings({}, true).catch(() => {})
}

/**
 * Persist one settings patch.
 *
 * The in-memory snapshot moves immediately so the very next tool call and the
 * next `state` push already respect the user's choice; only the storage write
 * is queued. Two rapid toggles used to race there, and the earlier
 * `storage.local.set` could land after the later one, silently dropping a field
 * and leaving memory and storage disagreeing about a safety setting.
 */
async function persistSettings(next: Partial<Settings>, alreadyNormalized = false): Promise<void> {
  const normalized = alreadyNormalized ? settings : normalizeSettings({ ...settings, ...next })
  settings = normalized
  const write = settingsWrites.then(
    () => chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized }),
    () => chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized }),
  )
  settingsWrites = write.catch(() => {})
  await write
}

// ---- Control strip ----

function postToControl(message: ControlMessage): void {
  for (const port of controlPorts) {
    try {
      port.postMessage(message)
    } catch {
      // The view closed between the check and the send.
    }
  }
}

/** Answer one request on the port that made it; a closed view is not an error. */
function replyToPort(port: chrome.runtime.Port, message: ControlMessage): void {
  try {
    port.postMessage(message)
  } catch {
    // The view closed before it could read the result.
  }
}

/** The human half of an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Record one browser operation.
 *
 * The activity list is the short "what just happened" queue; the same record is
 * mirrored onto its timeline step, so a run reads identically in both places and
 * the page can join a step to its origin by id.
 */
function recordActivity(entry: Omit<ActivityEntry, 'at'>): void {
  const at = Date.now()
  const record: ActivityEntry = { ...entry, at }
  const index = activity.findIndex((candidate) => candidate.id === entry.id)
  if (index === -1) activity.unshift(record)
  else activity[index] = record
  activity.splice(ACTIVITY_LIMIT)
  control.applyActivity(record)
  postToControl({ type: 'activity', entry: record })
}

function controlState(): ControlState {
  return {
    enabled: true,
    bridge: bridge?.state ?? 'stopped',
    caps: caps === null ? null : { snapshotMaxChars: caps.snapshotMaxChars, maxInteractiveItems: caps.maxInteractiveItems },
    affinity: affinity.snapshot(),
    approvals: approvals.pendingRequests(),
    settings: { ...settings, trustedActionOrigins: [...settings.trustedActionOrigins] },
    sessionTrustedOrigins: [...sessionTrustedActionOrigins].sort(),
    activity: activity.map((entry) => ({ ...entry })),
    session: control.session(),
    timeline: control.timeline(),
    policy: bridgePolicy === null ? null : { openPagesForUser: bridgePolicy.openPagesForUser },
    // Read from the client, not inferred from `bridge === 'stopped'`: a
    // replacement and an ordinary stop end in the same state, but only one of
    // them has a way back that the user can act on.
    replaced: bridge?.wasReplaced === true,
  followError: followErrorRef,
  }
}

function syncBadge(): void {
  const count = approvals.pendingRequests().length
  void Promise.resolve(chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) }))
    .then(() => chrome.action.setBadgeBackgroundColor({ color: '#d93025' }))
    .catch(() => {})
}

/** The Chrome side panel API, absent on Firefox. */
interface ChromeSidePanel {
  open(options: { windowId?: number; tabId?: number }): Promise<void>
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
}

/** The Firefox sidebar API, absent on Chrome. */
interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function chromeSidePanel(): ChromeSidePanel | undefined {
  return (chrome as unknown as { sidePanel?: ChromeSidePanel }).sidePanel
}

function firefoxSidebar(): FirefoxSidebarAction | undefined {
  return (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
}

/**
 * Bring the panel in front of the user.
 *
 * Chrome shows the side panel; Firefox shows its sidebar. Both are driven from
 * here rather than by `action.onClicked`, because the same function also serves
 * a notification click and, on Firefox, the browser's own sidebar button.
 *
 * Every call runs inside a user gesture (a click listener, a notification
 * click, or a keyboard command), which is what both APIs require.
 */
function openControlPanel(windowId?: number): void {
  const panel = chromeSidePanel()
  if (panel !== undefined) {
    void panel.open(windowId === undefined ? {} : { windowId }).catch(() => {
      // A window that closed mid-call, or a panel that is already open.
    })
    return
  }
  const sidebar = firefoxSidebar()
  if (sidebar !== undefined) {
    void Promise.resolve(sidebar.open()).catch(() => {})
  }
}

/**
 * Claim the bridge slot again after another browser took it.
 *
 * Close code 4000 means the bridge handed its one connection to a different
 * browser profile, and the retry loop deliberately goes quiet so two open
 * profiles cannot evict each other in a loop. The consequence is that this
 * profile stays disconnected until something claims the slot back, and with the
 * connection settings no longer in the panel there is no longer any way for a
 * user to do that by hand — so it is done when they deliberately open the panel.
 * That gesture is also the signal that they mean to use this browser.
 */
function reclaimBridgeIfReplaced(): void {
  if (bridge?.wasReplaced !== true) return
  armBridgeKeepalive()
  void startBridge()
}

/**
 * Register the browser-specific chrome.
 *
 * Chrome opens its side panel from the toolbar icon through
 * `setPanelBehavior`, which keeps the click inside the browser's own
 * implementation. An explicit `onClicked` opener is registered too: Firefox
 * ignores it because a declared `sidebar_action` is opened by the browser's own
 * sidebar button, and on Chrome the setting above wins, so this listener only
 * ever runs on a target that has neither.
 */
function registerPanelEntryPoints(): void {
  const panel = chromeSidePanel()
  if (panel !== undefined) {
    void panel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  }
  chrome.action.onClicked.addListener(() => { openControlPanel() })
}

registerPanelEntryPoints()

/**
 * Tell a first-time user where the extension went.
 *
 * A newly installed extension is not pinned to the toolbar, and there is no API
 * to pin it — Chrome removed that, and the Web Store is the only path that pins
 * by default. So a user who installs from a file sees nothing appear and has no
 * way to guess that the toolbar's puzzle-piece menu holds it. Every other entry
 * point assumes they got past that.
 *
 * A notification is used rather than opening the panel directly because
 * opening a side panel requires a user gesture, which does not exist during
 * install. The notification creates one: clicking it counts, and so does its
 * button, both of which then open the panel through the existing path.
 */
const ONBOARDING_NOTIFICATION_ID = 'dsh-onboarding'
const ONBOARDING_SEEN_KEY = 'dshOnboardingSeen'

function notifyFirstRun(): void {
  const zh = getUiLocale() === 'zh'
  const menu = zh ? '拼图' : 'puzzle-piece'
  void Promise.resolve(chrome.notifications.create(ONBOARDING_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: zh ? 'dsh 浏览器扩展已安装' : 'dsh Browser Extension is installed',
    message: zh
      ? `它没在工具栏上：点地址栏右边的${menu}图标，把这一项固定，以后就好找了。点这条消息可以直接打开侧边栏。`
      : `It is not on the toolbar yet: open the ${menu} menu beside the address bar and pin it, so you can find it later. Click this message to open the side panel now.`,
    buttons: [{ title: zh ? '打开侧边栏' : 'Open the side panel' }],
    requireInteraction: true,
  })).catch(() => {
    // Notifications unavailable or silenced. Opening here is best-effort and may
    // be refused for want of a gesture; it costs nothing to try.
    openControlPanel()
  })
}

/** Show the first-run hint once, and never on an update. */
async function announceFirstRun(reason: string): Promise<void> {
  if (reason !== 'install') return
  try {
    const seen = await chrome.storage.local.get(ONBOARDING_SEEN_KEY)
    if (seen[ONBOARDING_SEEN_KEY] === true) return
    await chrome.storage.local.set({ [ONBOARDING_SEEN_KEY]: true })
  } catch {
    // Storage unavailable: still show it. A second hint is a smaller problem
    // than a user who never finds the extension.
  }
  notifyFirstRun()
}

chrome.runtime.onInstalled.addListener((details) => {
  void announceFirstRun(details.reason)
})

/** Wall-clock time of the last automatic panel open, for the cooldown below. */
let lastAutoOpenAt = 0

/**
 * How long an automatic open is suppressed after one.
 *
 * A model that runs ten browser calls in a row must not fight the user ten
 * times: one panel, one open, and then it stays where they put it.
 */
const AUTO_OPEN_COOLDOWN_MS = 60_000

/**
 * Bring the panel forward because the model is about to touch the browser.
 *
 * Gated on {@link Settings.autoOpenPanel}, rate-limited, and deliberately not
 * awaited: opening a panel is a convenience, and a browser that refuses (no
 * focused window, a panel already open, a policy block) must never fail the tool
 * call that triggered it. Unlike the approval path this runs without a user
 * gesture, so every failure is swallowed rather than surfaced.
 */
function autoOpenPanel(): void {
  // Gated on the app's policy as well as the user's own switch: raising the
  // panel is part of "the model is about to show you something", so it must not
  // survive the desktop app turning that off.
  if (!settings.autoOpenPanel || !pagesMayBeOpened()) return
  const now = Date.now()
  if (now - lastAutoOpenAt < AUTO_OPEN_COOLDOWN_MS) return
  lastAutoOpenAt = now
  void chrome.windows.getLastFocused()
    .then((focused) => { openControlPanel(focused.id) })
    .catch(() => { openControlPanel() })
}

// ---- Bridge discovery and connection ----

async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) {
        continue
      }
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) {
        return body.wsUrl
      }
    } catch {
      // Nothing serving the bridge on this port: try the next one.
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

/**
 * Retry discovery a few times, close together, before handing back to the alarm.
 *
 * Boot races the desktop app's own startup: dsh may still be binding its port
 * when the worker first looks, and a 30-second gap there is a visible stall.
 * Three attempts inside a few seconds covers a normal launch; after that the
 * keepalive's slower cadence takes over, so a genuinely absent app is not polled
 * in a loop.
 */
const DISCOVERY_RETRY_MS = [1_000, 3_000, 8_000]
let discoveryRetries = 0
let discoveryTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Cancel any queued discovery retry.
 *
 * Exposed because a pending timer outlives the code that created it: the retry
 * holds the module graph alive, so anything that tears the worker down — a test
 * unmounting, an extension unload — has to be able to drop it. Without this the
 * timer fires into a stale module and dials a socket nobody asked for.
 */
export function cancelPendingWork(): void {
  clearDiscoveryRetry()
  discoveryRetries = 0
  // Clearing the timer does not stop the dialing. Two other paths open sockets after
  // the teardown that was supposed to end them: a client that is reconnecting dials
  // again on its next backoff, and a startBridge already in flight creates a fresh
  // client once its await resolves. The revision bump is what abandons that start;
  // stopping the client is what ends the reconnect loop. A test then sees only the
  // socket it asked for, and an unload stops genuinely meaning no more sockets.
  bridgeStartRevision += 1
  bridge?.stop()
  bridge = null
}

function scheduleDiscoveryRetry(): void {
  if (discoveryRetries >= DISCOVERY_RETRY_MS.length) return
  const delay = DISCOVERY_RETRY_MS[discoveryRetries]
  discoveryRetries += 1
  if (discoveryTimer !== undefined) clearTimeout(discoveryTimer)
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined
    void startBridge()
  }, delay)
}

/** Drop a queued boot retry: a target was found, or a newer start superseded it. */
function clearDiscoveryRetry(): void {
  if (discoveryTimer === undefined) return
  clearTimeout(discoveryTimer)
  discoveryTimer = undefined
}

/** (Re)start the bridge with the current settings; empty address means auto-discover. */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision) ?? ''
  }
  // Discovery is asynchronous: settings may have changed while it was in flight.
  if (revision !== bridgeStartRevision) { return }
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastState()
    // Nothing is serving the bridge right now. Waiting for the keepalive would
    // leave the panel dead for up to 30s after the desktop app starts, which is
    // exactly the window a user hits when they launch dsh and then look at the
    // panel. Back off instead, and let a later alarm take over if these miss.
    scheduleDiscoveryRetry()
    return
  }
  // A target was found, so the burst of boot retries has done its job. Clearing
  // here also stops a queued retry from dialling a second socket after this one.
  discoveryRetries = 0
  clearDiscoveryRetry()
  // A manually entered address usually carries only the host; the bridge path is
  // a protocol constant, so fill it in rather than failing on the root path.
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // An invalid URL is handed to the WebSocket constructor to report.
  }
  if (bridge === null) {
    bridge = new BridgeClient({
      onStateChange: (state) => {
        // Deliberately not traced: this fires on every transition, and a
        // reconnecting client cycles through them repeatedly. Each trace costs a
        // read-modify-write of the whole log — real I/O on a hot path, for a fact
        // the panel already displays. The trace keeps the connection *decisions*
        // (discovery, probe, dial), which are the ones a diagnosis needs.
        if (state !== 'connected') {
          cancelAllToolCalls()
          // A gateway call cannot outlive the socket that carried it: settle
          // every pending RPC now instead of leaving the page waiting 30s.
          rpc?.fail(state === 'stopped'
            ? 'The dsh bridge was stopped before the gateway answered.'
            : 'The dsh bridge connection dropped before the gateway answered.')
          // "Trust this site for this session" means this connection's session,
          // not this popup's lifetime: the strip closes whenever the user looks
          // away, so the grant has to outlive a port. It still dies with the
          // socket, and the control strip can always take it back.
          if (state === 'stopped') sessionTrustedActionOrigins.clear()
          // A "restart dsh" notice described the connection that produced it; this
          // one has ended, so the claim is no longer known to hold.
          followConnectionChanged()
          // A relay round trip in flight cannot be answered by a socket that is gone.
          // Settle it with the reason instead of letting it wait out its timeout.
          visionCoordinator?.relayLost('bridge-closed')
          // An approval the user can no longer answer must not stay open. Losing the
          // connection closes the control strip, so the decision has nowhere to come
          // from; dropping it is honest, and a reconnect re-asks.
          approvals.cancelAll()
          // Nothing can be mirrored over a socket that is gone, and the timer would
          // only fail every ten seconds. The mode itself is remembered, so a
          // reconnection resumes it below in `onHelloOk`.
          stopWorkspaceRefresh()
        }
        broadcastState()
      },
      onFrame: (frame) => { routeFrame(frame) },
      onHelloOk: (negotiated, negotiatedPolicy) => {
        caps = negotiated
        bridgePolicy = negotiatedPolicy
        // Resume 「工作区内」 after a reconnect or a worker restart. The mode is in
        // settings, so without this a reconnect would leave the panel showing the
        // setting while mirroring nothing — the same "silently empty" state the mode
        // exists to remove. Also the first chance to read the workspace path, which is
        // what `workspaceSessions` needs to find the right group.
        if (settings.sessionScope === 'workspace') {
          // The whole group once, so the transcript a user was reading is back after a
          // reconnect; the refresh below narrows it to what is actually live.
          void startWorkspaceMirror({ onlyActive: false }).then(() => { startWorkspaceRefresh() }, () => {})
        }
        broadcastState()
      },
      // The user's Auto connect switch is the reconnect policy, not just the
      // first-connect policy: without this, a dropped socket would be dialled
      // again immediately after the strip reported the bridge as stopped.
    }, probeBridge, () => true, rediscoverBridgeUrl)
    rpc = createRpc(bridge)
  }
  bridge.start(url, settings.token)
}

/**
 * Re-resolve an auto-discovered bridge address after it stops answering.
 *
 * Only used when no address was set by hand: a typed address is a decision, and
 * silently dialling a different port would contradict it. Returning undefined
 * leaves the retry loop exactly as it was.
 */
async function rediscoverBridgeUrl(): Promise<string | undefined> {
  if (settings.bridgeUrl !== '') return undefined
  const found = await discoverBridge()
  if (found === undefined || found === '') return undefined
  try {
    const parsed = new URL(found)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    return parsed.toString()
  } catch {
    return undefined
  }
}

function routeFrame(frame: ServerFrame): void {
  // Recognition results are correlated by request id and belong to the vision
  // pipeline; anything it does not claim falls through to the tool paths.
  if (vision().handleFrame(frame)) return
  if (frame.t === 'tool.call') routeToolCall(frame)
  else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
  else if (frame.t === 'event') routeBridgeEvent(frame.frame)
}

/** One bridge-owned push event, already projected by the dsh Host adapter. */
type BridgeEventFrame = Extract<ServerFrame, { t: 'event' }>['frame']

/**
 * Forward one bridge event frame to the control page.
 *
 * Only the session this worker drives is relayed: a second dsh window may share
 * the bridge, and its conversation must not paint into this page. Nothing is
 * cached or replayed — the page renders the live stream, and a page that opens
 * mid-turn repaints from the worker's timeline instead of from a replayed log.
 */
function routeBridgeEvent(frame: BridgeEventFrame): void {
  // Every conversation the panel is currently showing. One in the ordinary modes, the
  // whole mirrored set under 「工作区内」 — which is why this is a set and not an id: a
  // frame from any of them belongs on screen.
  const active = control.activeSessionIds()
  if (frame.method === 'session/assistant-stream') {
    const event = assistantStreamEvent(frame.payload, active)
    if (event === null) return
    // Rows created while applying this event belong to the conversation it names.
    control.attributeTo(event.sessionId)
    control.applyStream(event)
    postToControl({ type: 'session.stream', event, sessionLabel: control.labelFor(event.sessionId) ?? null })
    return
  }
  if (frame.method !== 'session/event') return
  const message = sessionEventMessage(frame.payload, active)
  if (message === null) return
  control.attributeTo(message.sessionId)
  control.applyEvent(message.event)
  postToControl({
    type: 'session.event',
    sessionId: message.sessionId,
    event: message.event,
    sessionLabel: control.labelFor(message.sessionId) ?? null,
  })
}

function currentBudget(): ContentBudget | undefined {
  return caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
}

function broadcastState(): void {
  if (controlPorts.size === 0) return
  postToControl({ type: 'state', state: controlState() })
  syncBadge()
}

// ---- Controlled tab ----

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '' }
}

function observeActiveSummary(summary: AffinityTab): void {
  if (!affinity.observeActive(summary)) return
  persistTabAffinity()
  broadcastState()
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const [tab] = await chrome.tabs.query(query)
    if (signal?.aborted === true) return undefined
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    const summary = summarizeTab(tab)
    if (summary !== null) observeActiveSummary(summary)
    return tab
  } catch {
    return undefined
  }
}

type StoredAffinity =
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true }
  | { lost: true }

function storedAffinity(): StoredAffinity | null {
  const state = affinity.snapshot()
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null ? { keptActiveTabId: state.active.tabId } : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
    }
  }
  return state.status === 'lost' ? { lost: true } : null
}

let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const keptActiveTabId = (candidate as { keptActiveTabId?: unknown } | undefined)?.keptActiveTabId
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      record = { lost: true }
    }
    lastPersistedAffinity = record === null ? undefined : JSON.stringify(record)
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record !== null && 'controlledTabId' in record) {
    try {
      const tab = await chrome.tabs.get(record.controlledTabId)
      const summary = summarizeTab(tab)
      if (summary === null) affinity.restoreLost()
      else affinity.restoreControlled(summary)
    } catch {
      affinity.restoreLost()
    }
  } else if (record?.lost === true) {
    affinity.restoreLost()
  }

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) affinity.restorePinned()
  // The switch preference is a setting, so it wins over the remembered pin: the
  // mode is what the user asked for, the pin is only what they once answered.
  affinity.setSwitchMode(settings.tabSwitch)
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = affinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      affinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastState()
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. Open the dsh browser control strip and choose whether to keep the previous page or follow the current one.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Open the dsh browser control strip and bind the current page before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = affinity.resolveTarget()
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      // First browser call before any user choice: bind the tab the user is on.
      const active = await syncActiveTab()
      const summary = active === undefined ? null : summarizeTab(active)
      if (summary === null) return affinityFailure('missing')
      if (affinity.bindInitial(summary)) {
        persistTabAffinity()
        broadcastState()
      }
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (affinity.observeTab(summary)) broadcastState()
      const current = affinity.resolveTarget()
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      if (affinity.removeTab(resolution.tab.tabId)) {
        persistTabAffinity()
        broadcastState()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/** Pick a window for browser_open_tab without requiring an already-controlled page. */
async function resolveOpenTabWindow(): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = affinity.resolveTarget()
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch {
    // No focused window: fall back to the last-focused window's active tab.
  }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(tab: chrome.tabs.Tab, active: boolean): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  bindOpenedTabAffinity(affinity, summary, { active })
  persistTabAffinity()
  broadcastState()
  return true
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(summary: AffinityTab, mode: 'active' | 'controlled'): void {
  const previous = affinity.snapshot().controlled?.tabId
  if (mode === 'active') affinity.rebindActive(summary)
  else affinity.rebindControlled(summary)
  if (previous !== undefined && previous !== summary.tabId) resetTabSnapshot(previous)
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastState()
}

/**
 * Move browser control to the tab the user is looking at.
 *
 * The deadline owns the outcome: once the caller's signal aborts, a query that
 * resolves late must not move the binding. Moving it would make a request the
 * user already saw fail change the controlled tab behind their back.
 */
async function rebindToActiveTab(signal: AbortSignal): Promise<void> {
  await affinityReady
  if (signal.aborted) throw rebindCancelled()
  const tab = await syncActiveTab(undefined, signal)
  if (signal.aborted) throw rebindCancelled()
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new Error(getUiLocale() === 'zh'
      ? '无法确定当前标签页，原绑定保持不变'
      : 'The current tab could not be determined; the existing binding was left unchanged')
  }
  commitTabAffinityRebind(summary, 'active')
}

function rebindCancelled(): Error {
  return new Error(getUiLocale() === 'zh' ? '标签页绑定已超时' : 'Tab binding timed out')
}

// ---- Approval ----

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of controlPorts) {
    try {
      port.postMessage({ type: 'approval.request', request } satisfies ControlMessage)
      delivered = true
    } catch {
      // The view closed between the check and the send.
    }
  }
  return delivered
}

/**
 * Offer one pending decision to the user's desktop.
 *
 * A closed popup means the request would otherwise be invisible, so the
 * notification is deliberately NOT gated on the "system notifications" setting:
 * that setting chooses between a notification and silent in-strip delivery, and
 * silencing both would leave a fail-closed tool call with no way to proceed.
 */
function notifyApproval(request: ApprovalRequest): void {
  if (controlPorts.size > 0) return
  const zh = getUiLocale() === 'zh'
  const minutes = Math.round(APPROVAL_TIMEOUT_MS / 60_000)
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: zh ? 'dsh 浏览器扩展等待确认' : 'dsh Browser Extension awaits approval',
    message: zh
      ? `${request.summary} —— 点击打开侧边栏，并在 ${minutes} 分钟内允许或拒绝。`
      : `${request.summary} — click to open the side panel and allow or deny within ${minutes} minutes.`,
    requireInteraction: true,
  })).catch(() => {
    // No notification permission or a silenced channel: the toolbar badge still
    // marks the pending request, so open the panel directly instead.
    openControlPanel()
  })
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: (request) => { notifyApproval(request) },
  clearNotification: clearApprovalNotification,
  resolved: () => {
    syncBadge()
    broadcastState()
  },
})

/** Authorize one tool call, recording the outcome in the activity list. */
async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  entryId: string,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (unrestrictedAccessEnabled()) return 'approved'
  if (actionCoveredByTrustedOrigins(prompt, sessionTrustedActionOrigins, settings.trustedActionOrigins)) {
    return 'approved'
  }
  recordActivity({
    id: entryId,
    kind: 'tool',
    name: prompt.action,
    summary: prompt.summary,
    origin: prompt.origins[0] ?? null,
    state: 'running',
  })
  const result: ApprovalRequestResult = await approvals.request(prompt, signal)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retained for wire compatibility with older control strips; permanent trust
  // is managed explicitly in the strip's advanced section.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

function unrestrictedAccessEnabled(): boolean {
  return settings.unrestrictedBrowserAccess
}

// ---- Gateway sessions ----

/**
 * The only gateway methods this worker calls.
 *
 * The desktop dsh app owns the conversation, so the worker needs exactly these
 * four: create its one session, queue a prompt, cancel the running turn, and —
 * for a caller that wants a durable read instead of the live stream — fetch
 * history once. The control page renders live events and re-prompts rather than
 * replaying a transcript the worker deliberately never caches.
 */
const sessionRpc = {
  create: (): Promise<unknown> => gatewayRpc('session.create', {}),
  prompt: (sessionId: string, text: string, clientTimeZone: string | undefined): Promise<unknown> =>
    gatewayRpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }),
  cancel: (sessionId: string): Promise<unknown> => gatewayRpc('session.cancel', { sessionId }),
  history: (sessionId: string): Promise<unknown> => gatewayRpc('session.history', { sessionId }),
  follow: (sessionId: string): Promise<unknown> => gatewayRpc('session.follow', { sessionId }),
  /**
   * Declare which conversations are still being watched, releasing the rest.
   *
   * The keep-list is the whole request: the worker's mirror is the authority, so a
   * bridge that missed an earlier change still converges on the same set.
   */
  retainFollows: (keep: readonly string[]): Promise<unknown> => gatewayRpc('session.unfollow', { keep }),
}

/**
 * Ask the bridge to start streaming one conversation's events to this worker.
 *
 * The only other thing that opens that stream is sending a prompt, which is why a
 * panel always saw its own conversations and never a conversation the desktop app
 * drives: every event is dropped unless its session matches the panel's binding, and
 * binding alone never started the stream.
 *
 * Best-effort on purpose. A transport that predates `session.follow` answers with
 * an error; the panel is still correctly bound in that case, it simply will not
 * update live, and that is not worth failing the user's conversation switch over.
 *
 * The failure is remembered in `followErrorRef` and shown in the panel, because
 * "bound but not updating" and "nothing to show" look identical otherwise, and the
 * usual cause has a one-step fix the user cannot guess: restart the desktop app so
 * it loads a bridge that knows this method.
 */
let followErrorRef: string | null = null
/**
 * Which follow request is allowed to write `followErrorRef`.
 *
 * Two quick picks issue two follows, and they can settle out of order: a slow
 * failure for the conversation the user already left would otherwise overwrite the
 * news that the one they are looking at follows fine. Only the newest request may
 * write, in either direction — a stale success must not clear a real error either.
 */
let followRevision = 0

async function startFollowingSession(sessionId: string): Promise<void> {
  const revision = ++followRevision
  const settleHint = (next: string | null): void => {
    if (revision !== followRevision) return
    if (followErrorRef === next) return
    followErrorRef = next
    try {
      broadcastState()
    } catch {
      // The worker is shutting down; there is no panel left to tell.
    }
  }
  try {
    // Checked rather than assumed: `gatewayRpc` throws when the bridge is gone, and a
    // fire-and-forget call that rejects after the worker is torn down surfaces as an
    // unhandled rejection — a noisy console and a test failure for something that is,
    // by design, allowed to fail. A follow that cannot be attempted is not reported
    // as a failure either: "not connected" already has its own notice, and blaming
    // the bridge version for it would send the user to the wrong fix.
    if (rpc === null || bridge === null || !bridge.connected) return
    await sessionRpc.follow(sessionId)
    settleHint(null)
  } catch (error: unknown) {
    // Swallowed on purpose: following is best-effort, and the branch below turns the
    // one failure the user can act on into a sentence the panel shows.
    const detail = error instanceof Error ? error.message : String(error)
    settleHint(/unavailable|not-found/iu.test(detail)
      ? (getUiLocale() === 'zh'
          ? '桌面端还没加载新版桥接，面板无法跟随对话。重启 dsh 桌面端后重试。'
          : 'The desktop app has not loaded the new bridge, so the panel cannot follow a conversation. Restart dsh and try again.')
      : detail)
  }
}

/**
 * Forget a standing "cannot follow" notice when the connection itself changes.
 *
 * The notice names the bridge version as the cause, which is only a statement about
 * the connection that produced it: once the socket drops, reconnects, or is replaced,
 * that claim is no longer known to be true, and repeating it would point the user at
 * a restart that may have already happened. A follow that is still broken puts the
 * notice back on its own.
 */
function followConnectionChanged(): void {
  followRevision += 1
  if (followErrorRef === null) return
  followErrorRef = null
  try {
    broadcastState()
  } catch {
    // No panel to tell.
  }
}

/**
 * One gateway RPC, refusing early with a clear message when the bridge cannot
 * carry it. The caller of a prompt must never see a 30-second socket timeout
 * when the real problem is that the desktop app is not connected.
 */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

/** In-flight `session.create`, so two quick prompts cannot create two sessions. */
let sessionCreation: Promise<string> | null = null

/**
 * Bumped whenever the panel's target conversation changes.
 *
 * A `session.create` in flight when the user picks a different conversation must
 * not adopt its result: the reply arrives after the choice was made, and letting
 * it through would silently drag the panel back to the session the user just
 * left — and the next prompt would land in a conversation they did not choose.
 */
let sessionGeneration = 0

/**
 * The dsh session this worker drives.
 *
 * Two modes, and the target is always chosen rather than inferred:
 *
 * - `fresh` (default) lazily creates the panel's own session on first use, so a
 *   page that only runs typed browser commands never needs the desktop app.
 * - `pinned` continues a conversation the user named in settings, which is how
 *   the panel can ask about a page inside context that already exists.
 *
 * The desktop publishes no "session I am viewing" signal, so there is nothing to
 * guess from: recent-activity inference would quietly deliver a prompt into the
 * wrong conversation, which is worse than asking the user once.
 */
/**
 * The conversation the panel's "start a new one" mode is currently using.
 *
 * Kept in `storage.local` rather than only in this worker's memory because the
 * worker does not live as long as the user assumes it does. Chrome stops an idle
 * MV3 service worker — which happens as soon as the side panel closes — and a
 * session held only in memory is then gone. The user's next message opened a
 * different conversation, and their browser history fragmented into one session
 * per idle timeout, each of which they had to find on their own.
 *
 * The desktop persists sessions to disk, so an id remains valid across a browser
 * restart, a dsh restart, and both. That is what makes restoring it meaningful.
 */
const FRESH_SESSION_KEY = 'dshFreshSessionId'

/** Remember the session the "new conversation" mode is bound to. */
function rememberFreshSession(sessionId: string | null): void {
  const write = sessionId === null
    ? chrome.storage.local.remove(FRESH_SESSION_KEY)
    : chrome.storage.local.set({ [FRESH_SESSION_KEY]: sessionId })
  // Storage is a durability aid, not a precondition: a failure here must not
  // stop the prompt the user is waiting on.
  void Promise.resolve(write).catch(() => {})
}

/**
 * The remembered session, if the desktop still has it.
 *
 * A stored id can outlive its session — the user may have deleted that
 * conversation from the desktop. Adopting a dead id would send the next prompt
 * into nowhere and report a gateway error the user cannot act on, so the id is
 * checked against the desktop's own list first. An unreadable list means an
 * older desktop or a transient failure, and in both cases starting a new
 * conversation is better than refusing to send.
 *
 * @returns the id to continue, or null to create a new conversation.
 */
async function restoredFreshSession(): Promise<string | null> {
  let stored: unknown
  try {
    const read = await chrome.storage.local.get(FRESH_SESSION_KEY)
    stored = read[FRESH_SESSION_KEY]
  } catch {
    return null
  }
  if (typeof stored !== 'string' || stored === '') return null
  try {
    const sessions = await listSessions()
    if (!sessions.some((session) => session.sessionId === stored)) {
      rememberFreshSession(null)
      return null
    }
  } catch {
    return null
  }
  return stored
}

function ensureSession(): Promise<string> {
  const existing = control.id
  if (existing !== null) return Promise.resolve(existing)
  if (settings.sessionScope === 'pinned' && settings.pinnedSessionId !== null) {
    const pinned = settings.pinnedSessionId
    control.adopt(pinned)
    return Promise.resolve(pinned)
  }
  if (sessionCreation === null) {
    const generation = sessionGeneration
    // Continuing the remembered conversation is tried first, so "new
    // conversation" means "new conversation, then the same one until you ask
    // for another" rather than "a new one every time the worker is recycled".
    const attempt = restoredFreshSession()
      .then((restored) => {
        if (restored !== null) {
          if (generation === sessionGeneration) control.adopt(restored)
          return restored
        }
        return sessionRpc.create().then((created) => {
          const sessionId = typeof created === 'object' && created !== null
            ? (created as { sessionId?: unknown }).sessionId
            : undefined
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new Error(getUiLocale() === 'zh'
              ? 'dsh 未返回会话 id'
              : 'The dsh gateway created a session without an id.')
          }
          // Only a create that is still current may write the binding. Writing it
          // unconditionally would let a superseded create resurrect itself after
          // the user switched scope, so the next panel prompt would land in the
          // conversation they just left.
          if (generation === sessionGeneration) {
            rememberFreshSession(sessionId)
            control.adopt(sessionId)
          }
          return sessionId
        })
      })
    sessionCreation = attempt
    const clear = (): void => { if (sessionCreation === attempt) sessionCreation = null }
    void attempt.then(clear, clear)
  }
  return sessionCreation
}

/** The browser's IANA time zone, so the desktop renders times in the user's zone. */
function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : undefined
  } catch {
    return undefined
  }
}

/**
 * Forward one typed instruction to the desktop model.
 *
 * The text is tagged with {@link BROWSER_PANEL_MARKER} so the model can tell a
 * real instruction from page content that claims to be one. The marker is applied
 * here, on the only path that can submit a prompt, rather than being left to the
 * model to infer.
 *
 * @param text - the instruction exactly as the user submitted it.
 * @returns the session the prompt was queued on.
 */
async function promptSession(text: string): Promise<string> {
  const request = control.beginPrompt(text)
  try {
    const sessionId = await ensureSession()
    // The binding is re-checked after the await, because `ensureSession` can spend a
    // round trip creating or restoring a conversation and the user may have picked a
    // different one in the meantime. The generation check inside `ensureSession` only
    // stops the *adoption* — the id it resolves to is still returned, so without this
    // the prompt lands in the conversation they just left while the row is drawn in
    // the one they chose. Refusing is the honest answer: their next message goes to
    // where the panel is actually pointing.
    if (control.id !== sessionId) {
      throw new Error(getUiLocale() === 'zh'
        ? '你切换了对话，这条消息没有发出。再发一次就会发到当前选中的对话。'
        : 'You switched conversations, so this message was not sent. Send it again to reach the one now selected.')
    }
    // The transcript row keeps the raw text so the panel shows what was typed;
    // the marker is what the model receives.
    await sessionRpc.prompt(sessionId, `${BROWSER_PANEL_MARKER} ${text}`, browserTimeZone())
    // A prompt already opens the follower on the bridge, so this is belt and
    // braces — and it runs after the prompt so it can never sit between the
    // caller and the prompt's own result.
    void startFollowingSession(sessionId)
    control.admitPrompt(request)
    return sessionId
  } catch (error: unknown) {
    // The request row is optimistic: a prompt that never reached the desktop
    // must not stay in the run as if it had been submitted.
    control.rejectPrompt(request)
    throw error
  }
}

/** A plain object, for narrowing values that crossed a process boundary. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the desktop's recent conversations for the panel's picker.
 * Only the fields the picker shows are kept, and every one is validated: this
 * crosses the bridge from another process, so a shape change must degrade to a
 * shorter list rather than to a crash or a bogus session id.
 *
 * **Sub-agent conversations are dropped.** Every delegated sub-agent is a Session of
 * its own, titled with its own instructions, so the list arrived full of entries
 * called `You are a senior code…` and `You are auditing…` — three identical-looking
 * rows per audit round, none of which the user can meaningfully continue from the
 * panel. The desktop tags them `origin: 'subagent'` with a `parentSessionId`, and the
 * list is about conversations the user holds, not about the machinery behind them.
 *
 * @returns conversations worth choosing from, running first then newest first.
 */
async function listSessions(): Promise<SessionSummary[]> {
  const listed = await gatewayRpc('session.list', {})
  const items = isPlainObject(listed) && Array.isArray(listed.items) ? listed.items : []
  const sessions: SessionSummary[] = []
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.sessionId !== 'string' || item.sessionId === '') continue
    // A sub-agent's Session is not a conversation the user can talk to. Matched on
    // either field: `origin` is the direct statement and `parentSessionId` the
    // structural one, and a build that publishes only one of them must still filter.
    if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
    // `title` is not a top-level field: it lives in `projections.values.title`, so
    // reading `item.title` found nothing and every conversation in the picker was
    // labelled "Untitled" — which is why near-identical titles were not the only
    // problem there. Both spellings are accepted, because a flat one is the obvious
    // shape for a future build to publish.
    sessions.push({
      sessionId: item.sessionId,
      title: sessionTitleOf(item),
      preview: firstPromptOf(item.projections),
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      running: item.running === true,
    })
  }
  // A conversation with a turn in progress comes first, then newest first.
  //
  // The desktop publishes no "session I am currently showing" field, so `running` is
  // the closest thing: the conversation whose turn is executing is nearly always the
  // one on screen, and after dropping the sub-agents the remaining list is short
  // enough that newest-first is a usable order on its own.
  sessions.sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1
    return right.updatedAt - left.updatedAt
  })
  return sessions
}

/**
 * The conversations 「工作区内」 should mirror: where the panel's browser conversations live.
 *
 * The bridge names the directory it groups them under in `hello.ok`, so this asks for
 * the workspace whose `path` is that directory rather than guessing from the title —
 * a user may have renamed the group, and a path is what the desktop keeps stable.
 *
 * @returns id → label, empty when the grouping is off or nothing is in it yet.
 */
async function workspaceSessions(options: { onlyActive: boolean }): Promise<Map<string, string>> {
  const path = bridgePolicy?.sessionWorkspacePath
  const mirror = new Map<string, string>()
  if (path === undefined || path === '') return mirror
  const listed = await gatewayRpc('workspace.list', {})
  const items = isPlainObject(listed) && Array.isArray(listed.items) ? listed.items : []
  const wanted = items.find((item) => isPlainObject(item) && item.path === path)
  if (!isPlainObject(wanted) || !Array.isArray(wanted.sessionIds)) return mirror
  const title = typeof wanted.title === 'string' && wanted.title !== '' ? wanted.title : path
  const memberIds = new Set<string>()
  for (const id of wanted.sessionIds) {
    if (typeof id !== 'string' || id === '') continue
    memberIds.add(id)
  }
  if (memberIds.size === 0) return mirror

  if (!options.onlyActive) {
    // Entering the mode: mirror the whole group once, so a conversation that has been
    // driven from the desktop side is on screen even though its work predates this
    // connection. Followed streams deliver the snapshot, which is what makes the
    // existing transcript appear rather than only what happens next.
    for (const id of memberIds) mirror.set(id, title)
    return mirror
  }

  // Steady state: only the conversations that are actually producing something.
  for (const id of sessionsWorthFollowing(memberIds, await listSessions(), Date.now())) {
    mirror.set(id, title)
  }
  return mirror
}

/** A conversation whose last event is older than this is no longer worth following. */
export const RECENT_ACTIVITY_MS = 5 * 60_000

/**
 * Which of a group's conversations are worth following right now.
 *
 * This is what keeps 「工作区内」 cheap. Following every member of a workspace costs one
 * server-side stream per member to watch the one or two that are live, and a group grows
 * without bound as conversations accumulate. Activity is answerable from `session.list`
 * metadata without asking any Session anything: `updatedAt` moves when a conversation
 * produces an event and stays put when it does not, and `running` marks a turn in
 * flight. So a conversation that starts working becomes recent and is followed on the
 * next tick, and one that goes quiet leaves the window and is dropped.
 *
 * Pure and exported so the decision can be tested directly, rather than through a timer
 * that has to be waited out.
 *
 * @param memberIds - every conversation in the group.
 * @param active - the desktop's session list, as the worker reads it.
 * @param now - current time, injected so the window is testable.
 * @returns the ids to follow, in the order `active` reports them (most recent first).
 */
export function sessionsWorthFollowing(
  memberIds: ReadonlySet<string>,
  active: readonly { sessionId: string; updatedAt: number; running: boolean }[],
  now: number,
): string[] {
  const cutoff = now - RECENT_ACTIVITY_MS
  const wanted: string[] = []
  for (const session of active) {
    if (!memberIds.has(session.sessionId)) continue
    if (!session.running && session.updatedAt < cutoff) continue
    wanted.push(session.sessionId)
  }
  return wanted
}

/**
 * How recent a conversation's last event must be for 「工作区内」 to keep following it.
 *
 * Long enough that a conversation being read or thought about is not dropped mid-use,
 * short enough that a group of twenty settles to the one or two that are live. The
 * comparison is against `updatedAt`, which only moves when a conversation produces an
 * event, so this really is "has anything happened here lately" rather than a guess.
 *
 * Declared with {@link sessionsWorthFollowing} above; this note is the rationale.
 */

/**
 * The newest mirrored conversation, or null when the group is empty.
 *
 * Used as the panel's binding under 「工作区内」: typing there starts the panel's own
 * conversation, but the transcript has to be *about* something, and the most recently
 * active conversation in the group is the one the user is looking at.
 *
 * @param mirror - the mirrored conversations.
 * @returns a session id, or null.
 */
function newestMirrored(mirror: ReadonlyMap<string, string>): string | null {
  // The map preserves insertion order and `workspace.list` reports most recent first,
  // so the first key is the newest. No timestamps are needed, which keeps this working
  // for a group whose order the desktop decides.
  return [...mirror.keys()][0] ?? null
}

/**
 * Start mirroring every conversation in the browser workspace.
 *
 * The follower has to be opened for each one: the bridge streams a conversation's
 * events only after someone asks, and the panel never prompts most of them. A failure
 * to open one is tolerated — the others still mirror, and `session.follow` on a
 * conversation that is already followed is cheap.
 *
 * @param options.onlyActive - true in the steady state, to follow just the live
 *   conversations; false on entry, to mirror the whole group once.
 * @returns the mirrored set, so the caller can publish it to the panel.
 */
/**
 * Conversations this worker has already asked the bridge to stream.
 *
 * Kept so a refresh tick asks only about what is new. The bridge's `session.follow` is
 * idempotent for a Session it is already reading, so repeating the request is not wrong
 * — but a tick that re-announces every mirrored conversation spends a round trip per
 * conversation per tick to change nothing.
 */
const followedSessions = new Set<string>()

async function startWorkspaceMirror(options: { onlyActive: boolean } = { onlyActive: true }): Promise<Map<string, string>> {
  const mirror = await workspaceSessions(options)
  control.setMirrored(mirror)
  for (const id of mirror.keys()) {
    if (followedSessions.has(id)) continue
    followedSessions.add(id)
    void startFollowingSession(id)
  }
  // Release the streams for conversations the mirror has let go, so a group of twenty
  // does not hold twenty server-side streams to watch the one or two that are live. The
  // remaining set is declared rather than the dropped one, so the bridge ends up with
  // exactly what this worker is showing even if it missed an earlier change.
  retainFollowedSessions(new Set(mirror.keys()))
  // Their rows belong to a mirror that is no longer showing them.
  control.retainSessions(new Set(mirror.keys()))
  const newest = newestMirrored(mirror)
  if (newest !== null) control.adopt(newest)
  return mirror
}

/**
 * Tell the bridge which conversations are still being watched.
 *
 * Posted without awaiting, and best-effort on purpose. Two reasons, both about the user
 * rather than about tidiness:
 *
 * - A bridge older than `session.unfollow` answers with an error, and that must not
 *   surface anywhere. An extension and a bridge upgrade separately — one from the
 *   store, one from npm — so the older pairing has to keep working, just without the
 *   release. Degrading to "streams are held a little longer" is correct; failing a
 *   refresh tick over it is not.
 * - It is bookkeeping. A tick that cannot post it has still updated the panel.
 *
 * @param keep - the Session ids still being mirrored.
 */
function retainFollowedSessions(keep: ReadonlySet<string>): void {
  let dropped = false
  for (const id of [...followedSessions]) {
    if (keep.has(id)) continue
    followedSessions.delete(id)
    dropped = true
  }
  // Nothing was released, so there is nothing to declare. This is the common case on a
  // refresh tick and it costs no round trip.
  if (!dropped) return
  void sessionRpc.retainFollows([...keep]).catch(() => {
    // An older bridge, or a socket that closed mid-flight. Either way the streams it
    // still holds end with the connection.
  })
}

/** Stop mirroring, dropping the extra conversations' rows and their follow bookkeeping. */
function stopWorkspaceMirror(): void {
  control.setMirrored(new Map())
  control.retainSessions(new Set())
  retainFollowedSessions(new Set())
  followedSessions.clear()
}

/**
 * A conversation's display name, from whichever field carries it.
 *
 * The desktop nests it at `projections.values.title`; a flat `title` is accepted too.
 * An untitled conversation legitimately has an empty string, which the picker renders
 * with a fallback label — the point is to tell that case apart from a title that was
 * simply looked for in the wrong place.
 *
 * @param item - one `session.list` entry.
 * @returns the title, or `''` when the entry carries none.
 */
function sessionTitleOf(item: Record<string, unknown>): string {
  if (typeof item.title === 'string') return item.title
  const projections = item.projections
  if (!isPlainObject(projections) || !isPlainObject(projections.values)) return ''
  const title = projections.values.title
  return typeof title === 'string' ? title : ''
}

/**
 * The opening prompt of a conversation, as one short line.
 *
 * Reaches through `projections.values.turnOutline`, which carries the first user
 * message of each turn and its response summary. Two titles can be near-identical
 * ("介绍哔哩哔哩罗肖尼视频" against "哔哩哔哩罗肖尼视频介绍") while the prompts behind them
 * differ plainly, so this is what makes the picker choosable. Every step is
 * defensive — the shape crosses a process boundary — and an unreadable one yields an
 * empty string rather than a wrong line.
 *
 * @param projections - one `session.list` item's `projections` value.
 * @returns the first prompt, whitespace-collapsed, or `''` when unavailable.
 */
function firstPromptOf(projections: unknown): string {
  if (!isPlainObject(projections)) return ''
  const values = projections.values
  if (!isPlainObject(values) || !Array.isArray(values.turnOutline)) return ''
  for (const turn of values.turnOutline) {
    if (!isPlainObject(turn) || typeof turn.prompt !== 'string') continue
    const prompt = turn.prompt.replace(/\s+/gu, ' ').trim()
    // Some turns carry an empty prompt (a continuation); keep looking for a real one.
    if (prompt === '') continue
    return prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt
  }
  return ''
}

/**
 * Point the panel at a conversation, or give it its own again.
 *
 * Switching away from a pinned session drops the current binding so the next
 * prompt creates a fresh one, and switching to a pinned session adopts it
 * immediately. Both directions also clear any half-finished `session.create`,
 * so a prompt in flight cannot resurrect the session the user just left.
 *
 * @param scope - `fresh` for the panel's own session, `pinned` to continue one.
 * @param sessionId - the conversation to continue; required when pinned.
 */
async function selectSessionScope(scope: SessionScope, sessionId: string | null): Promise<void> {
  // Invalidate any create still in flight before changing the target, so its
  // reply cannot adopt a session the user has just navigated away from.
  sessionGeneration += 1
  sessionCreation = null
  const previous = control.id
  // Work already under way survives the switch; work merely queued does not,
  // because it is about to run against the conversation being moved to.
  const keep = control.inFlightRowIds(activeToolCalls.keys())
  if (scope === 'workspace') {
    // Mirroring does not change where a prompt goes: the panel keeps its own
    // conversation so typing here cannot land in one of the mirrored ones by
    // accident. The rows of the conversations being mirrored are additive, so only
    // the ones that leave the group are dropped.
    publishedMirror = new Map()
    control.detach(keep)
    await persistSettings({ sessionScope: 'workspace', pinnedSessionId: null })
    // The whole group on entry, so a conversation the desktop drove earlier is visible
    // rather than only what happens from now on. The refresh below then follows just
    // the live ones, which is what keeps twenty idle conversations from costing twenty
    // server-side streams.
    await startWorkspaceMirror({ onlyActive: false })
    startWorkspaceRefresh()
    broadcastState()
    return
  }
  // Leaving workspace mode: stop mirroring before the single binding takes over, so
  // its rows are not retained by the mirror.
  stopWorkspaceRefresh()
  stopWorkspaceMirror()
  if (scope === 'pinned' && sessionId !== null) {
    // Continuing a different conversation than the one on screen must clear the
    // transcript: those rows belong to the session they came from.
    if (previous !== null && previous !== sessionId) control.detach(keep)
    control.adopt(sessionId)
  } else {
    // Choosing "start a new one" has to actually start one. Without forgetting
    // the remembered conversation here, the next prompt would restore the very
    // session the user just asked to leave.
    rememberFreshSession(null)
    control.detach(keep)
  }
  await persistSettings({ sessionScope: scope, pinnedSessionId: scope === 'pinned' ? sessionId : null })
  broadcastState()
}

/**
 * How often 「工作区内」 re-reads its group, so a conversation that starts working is
 * picked up on its own.
 *
 * Ten seconds is a compromise the mode can live with: a tick is two metadata reads and
 * opens a follower only for the conversations that turned out to be live, so the cost of
 * being early is near zero, while the cost of being late is a delay before desktop-side
 * work appears. Assigned rather than declared `const` because a test that wants to
 * exercise the timer has to reach it, and exposing it as a user setting would be a knob
 * whose only useful value is the default.
 */
export let WORKSPACE_REFRESH_MS = 10_000

/** The refresh timer for 「工作区内」, and the group it last published. */
let workspaceTimer: ReturnType<typeof setInterval> | null = null
let publishedMirror = new Map<string, string>()

/** Keep the mirrored set current while the mode is on. */
function startWorkspaceRefresh(): void {
  stopWorkspaceRefresh()
  workspaceTimer = setInterval(() => {
    void startWorkspaceMirror().then(
      (mirror) => {
        // Only repaint when the group actually changed: the panel re-renders on every
        // state push, and a timer that pushed unconditionally would repaint the
        // conversation every ten seconds for no reason.
        if (sameMirror(mirror, publishedMirror)) return
        publishedMirror = new Map(mirror)
        broadcastState()
      },
      () => { /* A read that failed: the next tick tries again. */ },
    )
  }, WORKSPACE_REFRESH_MS)
  // Node and the worker both keep a process alive for a pending interval; this one is
  // bookkeeping and must never be the reason the worker stays up.
  const timer = workspaceTimer as unknown as { unref?: () => void }
  timer.unref?.()
}

/** Stop refreshing the mirrored set. */
function stopWorkspaceRefresh(): void {
  if (workspaceTimer !== null) clearInterval(workspaceTimer)
  workspaceTimer = null
  publishedMirror = new Map()
}

/**
 * Whether two mirrored sets name the same conversations.
 *
 * Order is part of it: the newest conversation decides the panel's binding, so a
 * reordering is a real change even when the membership is identical.
 *
 * @param left - one set.
 * @param right - the other.
 * @returns true when they are equivalent.
 */
function sameMirror(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  const leftKeys = [...left.keys()]
  const rightKeys = [...right.keys()]
  return leftKeys.every((id, index) => id === rightKeys[index])
}

/** Milliseconds to pause between `@open` steps, by pace. */
const OPEN_PACE_MS: Record<'fast' | 'normal' | 'slow', number> = {
  fast: 0,
  normal: 350,
  slow: 1_200,
}

/**
 * Open a URL in front of the user, then hand it to the tools.
 *
 * This is the `@open` directive's whole behaviour, and every step is done here
 * rather than by the model: open the tab, bring it to the front, wait for the
 * document, bind it as the controlled tab, and raise the panel. "So I can watch
 * it" is therefore a guarantee — the model cannot skip it, because it is not the
 * model doing it.
 *
 * @param url - the address to open; only http(s) is accepted.
 * @param pace - how long to pause between steps so a person can follow.
 * @param pin - whether the opened tab becomes the tab the tools act on.
 * @returns a short factual note for the panel to display.
 */
async function openInFrontOfUser(
  url: string,
  pace: 'fast' | 'normal' | 'slow',
  pin: boolean,
): Promise<{ url: string; tabId: number; pinned: boolean }> {
  // The desktop app owns this permission. `@open` is a user-initiated command,
  // but it still opens pages on the user's behalf, so a switch that did not stop
  // it would be a switch that does not work.
  if (!pagesMayBeOpened()) {
    throw new Error(getUiLocale() === 'zh'
      ? '「自动打开页面」已在桌面端关闭，因此 @open 不可用'
      : 'Opening pages is turned off in the desktop app, so @open is unavailable.')
  }
  const parsed = parseHttpUrl(url)
  if (parsed === undefined) {
    throw new Error(getUiLocale() === 'zh'
      ? `只能打开 http 或 https 网址，收到：${url}`
      : `Only http or https addresses can be opened; received: ${url}`)
  }
  const step = OPEN_PACE_MS[pace]
  const pause = async (): Promise<void> => {
    if (step > 0) await new Promise<void>((resolve) => { setTimeout(resolve, step) })
  }

  await settingsReady
  const windowId = await resolveOpenTabWindow()
    .then((resolved) => ('windowId' in resolved ? resolved.windowId : undefined))
    .catch(() => undefined)
  await pause()
  const created = await chrome.tabs.create({
    // Foreground on purpose: the user asked to see this happen.
    active: true,
    ...(windowId === undefined ? {} : { windowId }),
  })
  if (created.id === undefined) throw new Error('Chrome created a tab without an id.')
  const tabId = created.id

  await pause()
  // Wait for the document before binding, so the first snapshot the model takes
  // is of the real page rather than about:blank.
  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, new AbortController().signal)
  await chrome.tabs.update(tabId, { url: parsed.href })
  await navigationWait.ready

  if (pin) {
    await pause()
    const tab = await chrome.tabs.get(tabId)
    if (!bindOpenedTab(tab, true)) {
      // Bind by id even when metadata is unavailable: the user asked for this
      // tab, so failing to describe it must not silently retarget the tools.
      affinity.rebindControlled({ tabId, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? parsed.href })
      persistTabAffinity()
      broadcastState()
    }
  }

  await pause()
  // No gesture is available on a panel message, so this is best effort: the
  // panel is usually already open, and a refusal must not fail the directive.
  void chrome.windows.getLastFocused()
    .then((focused) => { openControlPanel(focused.id) })
    .catch(() => { openControlPanel() })

  return { url: parsed.href, tabId, pinned: pin }
}

/** Stop the running turn of the worker's session. */
async function cancelSession(): Promise<string> {  const sessionId = control.id
  if (sessionId === null) {
    throw new Error(getUiLocale() === 'zh'
      ? '当前没有可取消的 dsh 会话'
      : 'There is no dsh session to cancel yet.')
  }
  await sessionRpc.cancel(sessionId)
  control.cancelTurn()
  return sessionId
}

// ---- Tool dispatch ----

export function answerOutcome(answer: ToolAnswer): ActivityEntry['state'] {
  if (answer.ok) return 'done'
  if (answer.error?.code === 'bridge-closed') return 'cancelled'
  if (answer.error?.code === 'timeout') return 'failed'
  return 'failed'
}

/**
 * How much access one browser operation runs with.
 *
 * `unrestricted` skips every approval prompt. The bridge path grants it only
 * when the user enabled the global switch; a typed command always has it,
 * because typing the command is itself the user's gesture.
 */
type ToolAccessMode = 'prompt' | 'unrestricted'

/** One browser operation, whoever asked for it. */
interface ToolRun {
  call: ToolCall
  /** Withdraws the operation before it reaches the page. */
  controller: AbortController
  /** Origin of the request: a model step, or the user's own typed command. */
  kind: ActivityEntry['kind']
  access: ToolAccessMode
}

/**
 * Describe one image the snapshot numbered, and check the answer against the page.
 *
 * This is the only place recognition is started, and it starts on demand: one
 * request for the one image that was asked about. Recognition costs a request per
 * image and a page can hold dozens, so the rule is scheduling rather than brute
 * force — and an image whose answer is already cached costs nothing at all.
 *
 * @param call - the tool call, carrying the image index.
 * @param tab - the affinity-selected tab.
 * @param sharePageContent - the user's page-content policy.
 * @param signal - bridge lifetime.
 * @returns the tool answer: the description with its cross-check, or why not.
 */
async function describeImage(
  call: ToolCall,
  tab: Pick<chrome.tabs.Tab, 'id'>,
  sharePageContent: 'ask' | 'auto' | 'off',
  signal: AbortSignal,
): Promise<ToolAnswer> {
  // An image is page content and its bytes leave the machine, so the switch that
  // governs reading the page governs describing its images too.
  if (sharePageContent === 'off') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' },
    }
  }
  const visionService = vision()
  if (settings.visionTier === 'off') {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'Image recognition is off. Enable a tier in Settings > Image recognition to allow it.',
      },
    }
  }
  if (!visionService.canRecognize()) {
    // The desktop knows why it cannot recognize images and says so in the
    // handshake; without carrying it through, this is a dead end for the reader.
    const hint = bridgePolicy?.imageRecognitionHint
    return {
      ok: false,
      error: {
        code: 'content-unavailable',
        message: 'No vision model is configured for image recognition, so this image cannot be described.'
          + (typeof hint === 'string' && hint !== '' ? ` ${hint}.` : ''),
      },
    }
  }
  // Nothing is coerced here, on purpose. `Number(null)` is 0 and `Number('')` is 0,
  // so accepting anything number-ish would turn `index: null` into "describe the
  // first image" — quietly describing the wrong picture. The tool-dispatch path
  // already refuses a non-integer index, and this path answers the same tool.
  const index = call.args.index
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    return {
      ok: false,
      error: { code: 'bad-args', message: 'index must be the non-negative number browser_snapshot listed for the image.' },
    }
  }
  if (tab.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  // Element indices are a per-frame namespace, so the frame the snapshot showed
  // the image under is part of addressing it, not an optional refinement. An
  // unusable value is refused rather than defaulted, because defaulting describes
  // whatever frame 0 happens to hold instead of the one the model meant.
  const rawFrame = call.args.frame
  const frameId = rawFrame === undefined ? 0 : rawFrame
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId < 0) {
    return {
      ok: false,
      error: { code: 'bad-args', message: 'frame must be a non-negative integer returned by browser_snapshot, or omitted.' },
    }
  }
  const resolved = await requestImageTarget(tab.id, index, frameId, signal)
  if (!resolved.ok) return resolved
  const image = resolved.target

  // Bytes from the extension first, because only it carries the user's login
  // state; the URL is the fallback for what its own fetch cannot reach. The cache is
  // consulted by identity before any of that, so asking again about an image that is
  // already described does not download it — a cost that appeared the moment the
  // manifest stopped refusing every real host.
  const alreadyAnswered = visionService.descriptionOf(image.identity) !== undefined
  const chosen = await chooseImageSource(image.src, alreadyAnswered)
  const source = chosen.source
  if (source === undefined) {
    return {
      ok: true,
      result: {
        text: `Image [${String(index)}] has no address and no readable bytes, so it cannot be described.`,
      },
    }
  }

  const outcome = await visionService.describe(
    { identity: image.identity, alt: image.alt, near: image.near, heading: image.heading, kind: image.kind },
    source,
    signal,
    settings.visionTier,
  )
  const byteFailure = chosen.byteFailure
  return { ok: true, result: { text: describeOutcomeText(index, outcome, byteFailure) } }
}

/**
 * Run one browser operation against the affinity-selected tab.
 *
 * This is the single dispatch path: a bridge `tool.call` frame and a typed
 * command differ only in the {@link ToolRun} they build, so tab affinity, frame
 * validation, protected-page refusal, and every guard inside `dispatchToolCall`
 * apply to both, and neither can drift from the other.
 */
async function executeToolCall(run: ToolRun): Promise<ToolAnswer> {
  const { call, controller, access } = run
  const unrestricted = access === 'unrestricted'
  control.addStep(call.id, call.name, activitySummary(call, { ok: true }))
  if (run.kind === 'command') {
    // A typed command never waits for an approval, so it is running the moment
    // it is dispatched. A model call reaches `running` through its first
    // activity record instead, which for a gated call is written as the
    // approval prompt opens.
    control.startStep(call.id)
  }
  const authorize = (prompt: ApprovalPrompt): Promise<ApprovalAuthorization> => {
    if (unrestricted) return Promise.resolve('approved')
    return authorizeToolCall(prompt, controller.signal, call.id)
  }
  const budget = currentBudget()
  const sharePageContent = unrestricted ? 'auto' : settings.sharePageContent
  const tabManagement: TabManagementContext = {
    unrestrictedAccess: unrestricted,
    controlledTabId: affinity.snapshot().controlled?.tabId,
    followTab: async (tab) => {
      const summary = summarizeTab(tab)
      if (summary === null) throw new Error('the selected tab has no usable identifier')
      commitTabAffinityRebind(summary, 'controlled')
    },
  }

  if (isTabManagementTool(call.name)) {
    return dispatchToolCall(call, sharePageContent, budget, authorize, controller.signal, undefined, undefined, tabManagement, visionSink())
  }
  if (call.name === 'browser_open_tab') {
    const target = await resolveOpenTabWindow()
    if ('ok' in target) return target
    return dispatchOpenTab(
      call,
      target.windowId,
      sharePageContent,
      budget,
      authorize,
      controller.signal,
      (tab) => bindOpenedTab(tab, call.args.active !== false),
      (tabId) => affinity.allowsTarget(tabId),
      undefined,
      visionSink(),
    )
  }
  const target = await resolveToolTab()
  if ('ok' in target) return target
  // Image description is its own dispatch: it needs the resolved tab, the page
  // content policy and the vision pipeline, not a page action.
  if (call.name === 'browser_describe_image') {
    return await describeImage(call, target, sharePageContent, controller.signal)
  }
  return dispatchToolCall(
    call,
    sharePageContent,
    budget,
    authorize,
    controller.signal,
    target,
    () => target.id !== undefined && affinity.allowsTarget(target.id),
    { unrestrictedAccess: unrestricted },
    visionSink(),
  )
}

/** Route one tool.call frame to the user-approved controlled tab. */
function routeToolCall(call: ToolCall): void {
  const socket = bridge
  if (socket === null) return
  // The model is about to drive the browser, so put the panel where the user can
  // watch it happen. This is the one place that fires for every browser action,
  // including the ones that need no approval.
  autoOpenPanel()
  // A frame carrying an id already in the map replaces that entry, and the replaced
  // call's own `result`/`fail` then return early at the identity check below — so its
  // one-shot `settle()` would never fire and `cancelAllToolCalls()` could no longer
  // reach it either, because it is not the map's occupant any more. `settled` is what
  // a revocation barrier awaits, so an unsettled orphan hangs
  // `revokeUnrestrictedAccess()` forever and the user's "off" never reaches storage.
  // Settling here is safe: the promise is one-shot and the call is being abandoned.
  const superseded = activeToolCalls.get(call.id)
  if (superseded !== undefined) {
    superseded.controller.abort()
    superseded.settle()
  }
  const controller = new AbortController()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    unrestricted: unrestrictedAccessEnabled(),
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  const result = (answer: ToolAnswer, state: ActivityEntry['state']): void => {
    if (activeToolCalls.get(call.id) !== activeCall) return
    if (settleOnCompletion(activeCall)) activeToolCalls.delete(call.id)
    recordActivity({ id: call.id, kind: 'tool', name: call.name, summary: activitySummary(call, answer), origin: null, state })
    if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
      socket.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } })
      return
    }
    if (answer.ok) socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
    else socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
  }
  const fail = (error: unknown): void => {
    if (activeToolCalls.get(call.id) !== activeCall) return
    if (settleOnCompletion(activeCall)) activeToolCalls.delete(call.id)
    recordActivity({ id: call.id, kind: 'tool', name: call.name, summary: call.name, origin: null, state: 'failed' })
    socket.send({
      t: 'tool.result',
      id: call.id,
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  }

  void executeToolCall({
    call,
    controller,
    kind: 'tool',
    access: activeCall.unrestricted ? 'unrestricted' : 'prompt',
  }).then(
    (answer) => { result(answer, answerOutcome(answer)) },
    (error: unknown) => {
      if (controller.signal.aborted) {
        result({ ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }, 'cancelled')
        return
      }
      fail(error)
    },
  )
}

/**
 * Refuse a typed command before anything is dispatched.
 *
 * Two calls the desktop model makes under its own policy are hard guardrails
 * for a typed command: an unknown name has no call shape to validate, and
 * closing a tab destroys something the user may not have meant to name, so it
 * needs the explicit argument rather than an implied intent.
 */
function rejectTypedCommand(call: ToolCall): ToolAnswer | undefined {
  if (!BROWSER_TOOL_NAMES.includes(call.name)) {
    const name = call.name.length > 64 ? `${call.name.slice(0, 63)}…` : call.name
    return {
      ok: false,
      error: {
        code: 'bad-args',
        message: `Unknown browser command "${name}". Known commands: ${BROWSER_TOOL_NAMES.join(', ')}.`,
      },
    }
  }
  if (call.name === 'browser_close_tab' && call.args.confirm !== true) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'browser_close_tab needs an explicit confirmation: pass {"confirm": true} together with the tabId.',
      },
    }
  }
  return undefined
}

/**
 * Execute one `browser_*` command the user typed.
 *
 * The desktop app is not involved: the command runs through the same dispatch
 * path as a model call, but with the access the unrestricted switch would grant
 * so it never opens an approval prompt. Arguments are used exactly as typed.
 */
async function runTypedCommand(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const call: ToolCall = { id: crypto.randomUUID(), name, args }
  const controller = new AbortController()
  const rejection = rejectTypedCommand(call)
  const summary = activitySummary(call, { ok: true })
  // The pending row is what shows "you asked for this" before any work starts,
  // and it is also the row that mirrors the command's outcome onto the timeline.
  recordActivity({ id: call.id, kind: 'command', name: call.name, summary, origin: null, state: 'pending' })
  let answer: ToolAnswer
  if (rejection !== undefined) {
    answer = rejection
  } else {
    try {
      answer = await executeToolCall({ call, controller, kind: 'command', access: 'unrestricted' })
    } catch (error: unknown) {
      // A dispatch that threw still has a caller waiting and a row to settle;
      // its text is the same one the model would have been handed.
      answer = { ok: false, error: { code: 'internal', message: errorText(error) } }
    }
  }
  recordActivity({
    id: call.id,
    kind: 'command',
    name: call.name,
    summary: activitySummary(call, answer),
    origin: null,
    state: answerOutcome(answer),
  })
  return answer
}

function cancelToolCall(id: string): void {
  activeToolCalls.get(id)?.controller.abort()
}

/** Calls a settings write is waiting for before revoking unrestricted access. */
const revocationBarrier = new Set<ActiveToolCall>()

/**
 * Settle one call when its work is finished.
 *
 * Returns whether the call can leave the active map. During a revocation the
 * call stays mapped until the barrier has observed it, so a settings write can
 * never be persisted while an already-approved operation is still running.
 */
function settleOnCompletion(call: ActiveToolCall): boolean {
  call.settle()
  return !revocationBarrier.has(call)
}

/**
 * Abandon every in-flight tool call, because the bridge is gone.
 *
 * Each call is **settled** before the map is emptied, and that is not optional:
 * `settled` is what a revocation barrier awaits, so clearing the map without
 * resolving it would leave `revokeUnrestrictedAccess()` waiting forever and the
 * safety switch would never be persisted. (The settle functions are one-shot, so
 * a later `result()`/`fail()` for the same call is harmless.)
 */
function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    call.controller.abort()
    call.settle()
  }
  activeToolCalls.clear()
}

/**
 * Switch unrestricted browser control off, for real.
 *
 * The global switch is a safety boundary, so turning it off must not leave a
 * call that captured the grant still running against the page. Calls that have
 * not dispatched their page action are cancelled outright; an operation already
 * in flight cannot be withdrawn, so the settings write waits for it to settle
 * before it is persisted.
 */
async function revokeUnrestrictedAccess(): Promise<void> {
  const affected = [...activeToolCalls.values()].filter((call) => call.unrestricted)
  for (const call of affected) {
    revocationBarrier.add(call)
    call.controller.abort()
  }
  try {
    await Promise.allSettled(affected.map((call) => call.settled))
  } finally {
    for (const call of affected) {
      revocationBarrier.delete(call)
      for (const [id, candidate] of activeToolCalls) {
        if (candidate === call) activeToolCalls.delete(id)
      }
    }
  }
}

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  if ((message as { type?: unknown }).type !== 'DSH_CONTENT_READY') return
  // navigation.ts also listens for this frame-ready announcement; only this
  // listener answers it, telling a fresh document that it may accept actions.
  sendResponse({ ready: true })
})

// ---- Control strip ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTROL_PORT_NAME) return
  controlPorts.add(port)
  armBridgeKeepalive()
  void settingsReady.then(() => {
    // Opening a panel is the user saying they mean to use this browser, so it is
    // the right moment to take the bridge slot back from another profile that
    // holds it. It also covers every route into the panel — the toolbar icon,
    // the browser's keyboard shortcut, and an automatic open — where a toolbar
    // click listener would only cover one of them.
    reclaimBridgeIfReplaced()
    if (bridge !== null && bridge.state !== 'stopped') return
    void startBridge()
  })
  try {
    port.postMessage({ type: 'state', state: controlState() })
  } catch {
    // The view closed before its first render.
  }
  for (const request of approvals.pendingRequests()) clearApprovalNotification(request.id)
  syncBadge()
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const request = message as { type?: string }
    switch (request.type) {
      case 'state.request':
        void affinityReady.then(() => {
          try {
            port.postMessage({ type: 'state', state: controlState() })
          } catch {
            // The view closed.
          }
        })
        break
      case 'settings.update':
        void handleSettingsUpdate(port, message as { id?: unknown; settings?: unknown })
        break
      case 'approval.respond': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'session-trust.clear': {
        if (sessionTrustedActionOrigins.size === 0) break
        sessionTrustedActionOrigins.clear()
        broadcastState()
        break
      }
      case 'bridge.reclaim': {
        // The slot is claimed by dialling again, so this is the same entry point
        // every other reconnect uses — `startBridge` restarts the client, which
        // clears the replaced latch. A fresh start also makes this idempotent if
        // the user presses the button twice.
        void startBridge()
        break
      }
      case 'affinity.respond': {
        const decision = message as { revision?: unknown; decision?: unknown }
        if (typeof decision.revision !== 'number' || !isTabAffinityDecision(decision.decision)) break
        if (!affinity.decide(decision.decision, decision.revision)) break
        persistTabAffinity()
        // "Don't ask again" is a preference, not a per-switch answer: write the
        // equivalent mode to settings so it survives an MV3 worker restart, a
        // browser restart, and the next conversation. `follow` re-raises the
        // prompt by design, so only `keep` is promoted. The write is queued
        // behind any save already in flight, which is why it is fire-and-forget.
        if (decision.decision === 'keep-always' && settings.tabSwitch !== 'keep') {
          void persistSettings({ tabSwitch: 'keep' }, false).catch(() => {})
        }
        broadcastState()
        break
      }
      case 'affinity.rebind': {
        const rebind = message as { id?: unknown }
        if (typeof rebind.id !== 'string') break
        const requestId = rebind.id
        // The deadline owns the outcome: the timer both answers the strip and
        // aborts the query, so a slow tab lookup can never move the binding
        // after the user has already been told the attempt failed.
        const controller = new AbortController()
        let answered = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const answer = (result: ControlMessage): void => {
          if (answered) return
          answered = true
          if (timer !== undefined) clearTimeout(timer)
          try {
            port.postMessage(result)
          } catch { /* the view closed */ }
        }
        timer = setTimeout(() => {
          controller.abort()
          answer({ type: 'affinity.rebind.result', id: requestId, ok: false, error: 'timeout' })
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        void rebindToActiveTab(controller.signal).then(
          () => { answer({ type: 'affinity.rebind.result', id: requestId, ok: true }) },
          (error: unknown) => {
            answer({
              type: 'affinity.rebind.result',
              id: requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
        break
      }
      case 'session.create': {
        // The page may create its session ahead of the first prompt; the reply
        // id is optional because the id also arrives through `state.session`.
        const create = message as { id?: unknown }
        const requestId = typeof create.id === 'string' ? create.id : ''
        void ensureSession().then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.prompt': {
        const prompt = message as { id?: unknown; text?: unknown }
        if (typeof prompt.id !== 'string' || typeof prompt.text !== 'string') break
        const requestId = prompt.id
        const text = prompt.text.trim()
        if (text === '') {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: 'The prompt is empty.' })
          break
        }
        void promptSession(text).then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.cancel': {
        const cancel = message as { id?: unknown }
        if (typeof cancel.id !== 'string') break
        const requestId = cancel.id
        void cancelSession().then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'command.run': {
        const command = message as { id?: unknown; name?: unknown; args?: unknown }
        if (typeof command.id !== 'string' || typeof command.name !== 'string') break
        const requestId = command.id
        const args = typeof command.args === 'object' && command.args !== null && !Array.isArray(command.args)
          ? command.args as Record<string, unknown>
          : undefined
        if (args === undefined) {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: 'command.run requires an args object.' })
          break
        }
        void runTypedCommand(command.name, args).then(
          (answer) => {
            // The failure text is the same one the model would have been given,
            // so a typed command and a model call disagree about nothing.
            if (answer.ok) {
              replyToPort(port, { type: 'session.result', id: requestId, ok: true, result: answer.result })
              return
            }
            replyToPort(port, {
              type: 'session.result',
              id: requestId,
              ok: false,
              error: answer.error?.message ?? 'The browser command failed.',
            })
          },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.list': {
        const list = message as { id?: unknown }
        if (typeof list.id !== 'string') break
        const requestId = list.id
        void listSessions().then(
          (sessions) => { replyToPort(port, { type: 'session.list', id: requestId, ok: true, sessions }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.list', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.select': {
        const select = message as { id?: unknown; scope?: unknown; sessionId?: unknown; follow?: unknown }
        if (typeof select.id !== 'string') break
        const requestId = select.id
        const scope: SessionScope = select.scope === 'pinned'
          ? 'pinned'
          : select.scope === 'workspace' ? 'workspace' : 'fresh'
        const sessionId = typeof select.sessionId === 'string' && select.sessionId.trim() !== ''
          ? select.sessionId.trim()
          : null
        const follow = select.follow === true
        if (scope === 'pinned' && sessionId === null) {
          replyToPort(port, {
            type: 'session.result',
            id: requestId,
            ok: false,
            error: getUiLocale() === 'zh' ? '请先选择一个对话' : 'Choose a conversation first.',
          })
          break
        }
        void selectSessionScope(scope, sessionId)
          // Asked for after the binding moved, so the follower streams the
          // conversation the panel is now showing rather than the previous one.
          // Deliberately not awaited before the reply: the switch itself is a local
          // change that has already happened, and holding the acknowledgement behind a
          // round trip would make a slow bridge look like a picker that did nothing.
          // `startFollowingSession` never rejects.
          .then(() => {
            if (follow && sessionId !== null) void startFollowingSession(sessionId)
          })
          .then(
            () => { replyToPort(port, { type: 'session.result', id: requestId, ok: true }) },
            (error: unknown) => {
              replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
            },
          )
        break
      }
      case 'open.run': {
        const directive = message as { id?: unknown; url?: unknown; pace?: unknown; pin?: unknown }
        if (typeof directive.id !== 'string') break
        const requestId = directive.id
        if (typeof directive.url !== 'string') {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: '@open requires a URL.' })
          break
        }
        const pace = directive.pace === 'fast' || directive.pace === 'slow' ? directive.pace : 'normal'
        void openInFrontOfUser(directive.url, pace, directive.pin !== false).then(
          (result) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, result }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
    }
  })
  port.onDisconnect.addListener(() => {
    controlPorts.delete(port)
    if (controlPorts.size === 0) {
      // No visible view can answer now, so pending approvals become notifications.
      approvals.notifyPending()
    }
  })
})

async function handleSettingsUpdate(
  port: chrome.runtime.Port,
  message: { id?: unknown; settings?: unknown },
): Promise<void> {
  const requestId = typeof message.id === 'string' ? message.id : undefined
  const next = typeof message.settings === 'object' && message.settings !== null
    ? message.settings as Partial<Settings>
    : {}
  const reply = (result: ControlMessage): void => {
    try {
      port.postMessage(result)
    } catch {
      // The view closed before it could read the result.
    }
  }
  try {
    await settingsReady
    const previous = { bridgeUrl: settings.bridgeUrl, token: settings.token }
    const revokesUnrestricted = settings.unrestrictedBrowserAccess && next.unrestrictedBrowserAccess === false
    if (revokesUnrestricted) {
      // Revocation is a barrier, not a flag flip: stop every call that captured
      // the grant, then wait for one already dispatched to the page to settle
      // before the restrictive setting is written.
      //
      // The in-memory flag is cleared *first*, because the barrier can be waiting
      // on an approval for up to two minutes and `routeToolCall` stamps each new
      // call from that flag. Updating it only inside `persistSettings` (after the
      // await) would let a call arriving during the barrier still run unprompted —
      // which is precisely the window this barrier exists to close.
      settings.unrestrictedBrowserAccess = false
      await revokeUnrestrictedAccess()
    }
    await persistSettings(next)
    // A tab-switch preference takes effect at once: waiting for the next switch
    // would leave a handoff prompt on screen for a question the user just
    // answered in settings.
    if (affinity.setSwitchMode(settings.tabSwitch)) {
      persistTabAffinity()
      // Adopting the active tab changes the target, so re-evaluate it now.
      await syncActiveTab()
    }
    // Only a connection setting restarts the socket. Whether the extension
    // connects at all is not a choice: installing it is the choice, so there is
    // no switch to get out of step with.
    const connectionChanged = previous.bridgeUrl !== settings.bridgeUrl
      || previous.token !== settings.token
    if (connectionChanged) {
      armBridgeKeepalive()
      await startBridge()
    }
    broadcastState()
    if (requestId !== undefined) reply({ type: 'settings.result', id: requestId, ok: true })
  } catch (error: unknown) {
    if (requestId !== undefined) {
      reply({ type: 'settings.result', id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === ONBOARDING_NOTIFICATION_ID) {
    void Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {})
    openControlPanel()
    return
  }
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  clearApprovalNotification(notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length))
  // A notification click is an extension user gesture, which is what the
  // side-panel and sidebar openers require.
  openControlPanel()
})

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (notificationId === ONBOARDING_NOTIFICATION_ID) {
    void Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {})
    openControlPanel()
    return
  }
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  openControlPanel()
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (!focusedWindow.isCurrent(activationRevision)) return
      const summary = summarizeTab(tab)
      if (summary !== null) observeActiveSummary(summary)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!affinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && affinity.observeTab(summary)) broadcastState()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer the id synchronously so tool
    // resolution never observes the removed target.
    if (!affinity.replaceTab(removedTabId, addedTabId)) return
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastState()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && affinity.observeTab(summary)) broadcastState()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  // Drop the snapshot baseline unconditionally: it is keyed by tab id and would
  // otherwise keep one entry per tab ever snapshotted for the life of the worker.
  // Clearing it before the affinity check matters because the tab is gone whether
  // or not it was the controlled one.
  resetTabSnapshot(tabId)
  void affinityReady.then(() => {
    if (!affinity.removeTab(tabId)) return
    persistTabAffinity()
    broadcastState()
  })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (bridge !== null && bridge.state === 'reconnecting') return
  // A bridge that handed its slot to another browser stays stopped: reclaiming
  // it on a heartbeat would make two open profiles evict each other forever.
  // Reopening the control strip, saving the address, or restarting the browser
  // is the user's way back.
  if (bridge?.wasReplaced === true) return
  void settingsReady.then(() => {
    if (bridge === null || bridge.state === 'stopped') void startBridge()
  })
})

// ---- Boot ----


settingsReady = loadSettings()
  .then(() => {
    // Sessions, recent-session hints, and per-conversation tabs belonged to the
    // removed side panel; drop their leftovers instead of migrating them. The
    // image cache is here for a different reason: it lived in the session store
    // until it moved to `storage.local`, and the session copy is now dead weight
    // that nothing will ever read back.
    return Promise.resolve(chrome.storage.session.remove([
      LEGACY_RECENT_SESSION_STORAGE_KEY,
      'dshSessionContexts',
      IMAGE_CACHE_STORAGE_KEY,
    ])).catch(() => {})
  })
  .then(() => {
    affinityReady = restoreTabAffinity()
    return affinityReady
  })
  // A rejected affinity restore must not skip the step below. In one shared chain
  // the rejection would land on the trailing catch and leave the cache empty with
  // no trace of why — the failure and its own consequence would be inseparable.
  .catch(() => {})
  // Descriptions are restored alongside the session state, so a worker that was
  // stopped between two calls does not pay to describe the same image again.
  .then(() => restoreImageCache())
  .catch(() => {})

// The extension connects as soon as it loads, without any switch to turn on:
// installing it is the choice. Settings load first so a typed address is never
// raced by auto-discovery.
void settingsReady.then(() => {
  armBridgeKeepalive()
  void startBridge()
  syncBadge()
})

chrome.runtime.onInstalled.addListener(() => {
  void settingsReady.then(() => { armBridgeKeepalive() })
})
