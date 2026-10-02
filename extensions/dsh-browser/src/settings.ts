/**
 * Extension settings and the port contract between the background service and
 * the control strip.
 *
 * This module is the single source of truth for both ends, so a field can never
 * drift between what the worker persists and what the strip renders. It is
 * deliberately dependency-free: the service worker, the popup, and the
 * standalone control page all import it.
 *
 * @module
 */

import type { BridgeState } from './background/bridge.ts'
import { isTabSwitchMode, type TabAffinityState, type TabAffinityDecision, type TabSwitchMode } from './background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from './security/approval.ts'
import { normalizeTrustedOrigin } from './security/trusted-origins.ts'

/** Port name used by every control-strip view. */
export const CONTROL_PORT_NAME = 'dsh-control'

/** User settings persisted in `chrome.storage.local`. */
export interface Settings {
  /**
   * Bridge WebSocket address; empty means "auto-discover a local dsh".
   *
   * Not exposed in the panel: on the supported path the extension finds the
   * bridge itself. It stays in storage so the installed troubleshooting skill
   * can set it for the cases discovery cannot cover, and {@link token} is the
   * same kind of escape hatch.
   */
  bridgeUrl: string
  /** Bearer token; loopback Chrome connections need none, Firefox always does. */
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Allow every browser operation without an approval prompt. */
  unrestrictedBrowserAccess: boolean
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /**
   * Show an OS notification when no panel is open to display an approval.
   *
   * Not exposed in the panel: with auto-open on, the panel is almost always up
   * before an approval exists, so this only covers the case where the user
   * closed it. It stays settable through storage for anyone who wants it off.
   */
  approvalNotifications: boolean
  /**
   * Bring the panel forward as soon as the model starts working in the browser.
   *
   * The point is to watch the work happen — what it is looking for, what it is
   * downloading — instead of seeing a finished result with no idea how it got
   * there. It only fires when a browser tool is about to run, never on a chat
   * message, so an ordinary conversation does not steal the screen.
   */
  autoOpenPanel: boolean
  /**
   * What a manual tab switch means for the tools' target tab.
   *
   * `ask` raises the handoff prompt, `follow` moves with the user, and `keep`
   * stays on the bound tab. It is a setting rather than a per-switch prompt
   * because a question you have already answered is noise; answering with
   * "don't ask again" writes the answer here.
   */
  tabSwitch: TabSwitchMode
  /**
   * Which desktop conversation the panel's messages go to.
   *
   * `fresh` means "the panel's own conversation": one is started when there is
   * none to resume, and from then on the same one is reused. The id is kept in
   * extension storage, not only in memory, so it survives the background worker
   * being recycled — which Chrome does whenever the side panel has been idle, and
   * which is what used to fragment a user's browser history into one session per
   * timeout. Choosing "start a new conversation" clears the remembered id, so
   * that choice is honoured instead of being undone by the next prompt.
   *
   * `pinned` continues a conversation the user picked, which is how you ask the
   * model about a page *in the context you already built up*. Its id lives here,
   * in settings, because it is a deliberate choice rather than the panel's own
   * working session.
   *
   * The target is chosen, never guessed: the desktop exposes no "session I am
   * looking at" signal, so inferring it from recent activity would silently send
   * a message into the wrong conversation.
   */
  sessionScope: 'fresh' | 'pinned'
  /**
   * The session `pinned` mode writes to; null while nothing is chosen.
   *
   * `fresh` keeps its own id elsewhere — in extension storage, alongside a check
   * that the desktop still has it — because it is not a setting the user set.
   */
  pinnedSessionId: string | null
  /**
   * Comfort cap for the transcript and composer, in pixels.
   *
   * A side panel's width is owned by the browser: the user drags its edge, and
   * the browser remembers that width — no extension API can read, set, or lock
   * it. So this is not a panel size. It only stops a very wide panel from
   * producing mile-long lines, and any panel narrower than it is used in full.
   */
  readWidth: number
}

export const SETTINGS_DEFAULTS: Settings = {
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoOpenPanel: true,
  tabSwitch: 'ask',
  sessionScope: 'fresh',
  pinnedSessionId: null,
  readWidth: 640,
}

/** Storage key holding the persisted {@link Settings} object. */
export const SETTINGS_STORAGE_KEY = 'dshSettings'

/**
 * Marks text that entered a session from the extension's browser panel.
 *
 * The model reads untrusted page text through `browser_snapshot`, so on its own
 * it cannot tell a real user instruction from a sentence a web page planted.
 * Tagging every panel prompt with its origin gives it a rule it can apply
 * mechanically: text carrying this marker is the user, and anything else that
 * merely looks like an instruction is page content.
 *
 * Kept here, beside the settings, because both the worker that emits it and the
 * tests that assert on it need it — and this module has no runtime dependency, so
 * importing it does not drag the service worker in.
 */
export const BROWSER_PANEL_MARKER = '[用户·浏览器面板]'

/** One executed browser operation, kept for the control strip's short history. */
export interface ActivityEntry {
  /** Stable local id; also the bridge tool-call id while the call is live. */
  id: string
  /** Who asked for the operation: the model over the bridge, or the user's typed command. */
  kind: 'tool' | 'command'
  /** Tool name, such as `browser_click`. */
  name: string
  /** User-facing summary from the approval prompt, or the tool name. */
  summary: string
  /** Origin the operation was aimed at, when one could be derived. */
  origin: string | null
  state: 'running' | 'done' | 'failed' | 'denied' | 'cancelled' | 'pending'
  at: number
}

/** One assistant text delta or authoritative replacement for the active turn. */
export interface AssistantStreamEvent {
  sessionId: string
  /** 'snapshot' replaces everything; 'delta' is a single streamed frame. */
  kind: 'snapshot' | 'delta'
  /** Raw payload for the control page to interpret (snapshotId/frame or frame). */
  payload: unknown
}

/** One row of the execution timeline: a user request, a model step, or a tool run. */
export interface TimelineEntry {
  id: string
  /** 'request' = text the user typed; 'assistant' = model output; 'step' = a tool/command run. */
  kind: 'request' | 'assistant' | 'step'
  /** Display text: the typed request, assistant text, or the step summary. */
  text: string
  /** Only for kind 'step'. */
  tool?: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'cancelled'
  at: number
  /** Correlates a step with its tool-call id when one exists. */
  callId?: string
}

/** Everything the control strip renders from one message. */
export interface ControlState {
  /** Whether the persisted settings still allow connecting. */
  enabled: boolean
  bridge: BridgeState
  caps: { snapshotMaxChars: number; maxInteractiveItems: number } | null
  affinity: TabAffinityState
  /** Approvals still awaiting this user's decision, oldest first. */
  approvals: ApprovalRequest[]
  settings: Settings
  /** Origins trusted for the current bridge session only; lost on reconnect. */
  sessionTrustedOrigins: string[]
  /** Most recent browser operations, newest first. */
  activity: ActivityEntry[]
  /** The one dsh session this worker drives, and whether its turn is live. */
  session: { id: string | null; turn: 'idle' | 'running'; pendingPrompt: boolean }
  /** The run so far, oldest row first; capped, and kept in the worker rather than a page. */
  timeline: TimelineEntry[]
  /**
   * What the desktop app allows, as agreed in the handshake. Null before one.
   *
   * Sent to the panel so its own switches can reflect the authoritative setting
   * instead of quietly disagreeing with it: a toggle that looks on while the app
   * has it off is worse than no toggle.
   */
  policy: { openPagesForUser: boolean } | null
  /**
   * True when the bridge gave this browser's slot to another browser.
   *
   * Distinct from a plain disconnect: the extension deliberately stops retrying
   * here, so a panel that showed "reconnecting" would be lying, and one that
   * showed a generic failure would hide the only useful fact — another profile
   * took the connection.
   */
  replaced: boolean
}

/** Control strip → background. */
export type ControlRequest =
  | { type: 'state.request' }
  | { type: 'settings.update'; id: string; settings: Partial<Settings> }
  | { type: 'approval.respond'; id: string; decision: ApprovalDecision }
  | { type: 'affinity.respond'; revision: number; decision: TabAffinityDecision }
  | { type: 'affinity.rebind'; id: string }
  | { type: 'session-trust.clear' }
  /**
   * Ask for the bridge slot back after another browser took it.
   *
   * The only way out of the replaced state, so it has to be a user action: the
   * extension will not reclaim the slot on its own, or two open browsers would
   * evict each other forever.
   */
  | { type: 'bridge.reclaim' }
  /** Create the worker's one dsh session now instead of on the first prompt. */
  | { type: 'session.create'; id?: string }
  /** Forward one typed instruction to the desktop dsh model. */
  | { type: 'session.prompt'; id: string; text: string }
  /** Stop the running turn of the worker's session. */
  | { type: 'session.cancel'; id: string }
  /** Read the desktop's recent conversations, for the panel's session picker. */
  | { type: 'session.list'; id: string }
  /** Choose which conversation the panel's messages go to. */
  | { type: 'session.select'; id: string; scope: 'fresh' | 'pinned'; sessionId: string | null }
  /** Execute a `browser_*` command the user typed, without involving the desktop app. */
  | { type: 'command.run'; id: string; name: string; args: Record<string, unknown> }
  /**
   * Run an `@open` directive: open a URL in front of the user.
   *
   * The extension performs this itself — open, foreground, bind, show the panel —
   * so "so I can see it" does not depend on the model choosing to cooperate.
   */
  | { type: 'open.run'; id: string; url: string; pace: 'fast' | 'normal' | 'slow'; pin: boolean }

/** One desktop conversation, as much as the bridge discloses about it. */
export interface SessionSummary {
  sessionId: string
  /** Display name; the desktop leaves this empty for an untitled conversation. */
  title: string
  /** Epoch milliseconds of the last update, for ordering the picker. */
  updatedAt: number
  running: boolean
}


/** Background → control strip. */
export type ControlMessage =
  | { type: 'state'; state: ControlState }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'settings.result'; id: string; ok: true }
  | { type: 'settings.result'; id: string; ok: false; error: string }
  | { type: 'affinity.rebind.result'; id: string; ok: true }
  | { type: 'affinity.rebind.result'; id: string; ok: false; error: string }
  /** One assistant text delta or authoritative replacement for the active turn. */
  | { type: 'session.stream'; event: AssistantStreamEvent }
  /** One raw `session/event` for the page to render: tools, messages, turn boundaries. */
  | { type: 'session.event'; sessionId: string; event: unknown }
  /** Answer to one session/command request; exactly one result per accepted request. */
  | { type: 'session.result'; id: string; ok: true; sessionId?: string; result?: unknown }
  | { type: 'session.result'; id: string; ok: false; error: string }
  /** The desktop's recent conversations, newest first. */
  | { type: 'session.list'; id: string; ok: true; sessions: SessionSummary[] }
  | { type: 'session.list'; id: string; ok: false; error: string }

/** Normalize an untrusted settings candidate into a complete, valid object. */
export function normalizeSettings(candidate: Partial<Settings> | undefined): Settings {
  const source = candidate ?? {}
  const trusted = Array.isArray(source.trustedActionOrigins)
    ? [...new Set(source.trustedActionOrigins
        .map((entry) => (typeof entry === 'string' ? normalizeTrustedOrigin(entry) : undefined))
        .filter((entry): entry is string => entry !== undefined))].sort()
    : SETTINGS_DEFAULTS.trustedActionOrigins
  const sharePageContent = source.sharePageContent === 'auto' || source.sharePageContent === 'off'
    ? source.sharePageContent
    : source.sharePageContent === 'ask' ? 'ask' : SETTINGS_DEFAULTS.sharePageContent
  return {
    bridgeUrl: typeof source.bridgeUrl === 'string' ? source.bridgeUrl.trim() : SETTINGS_DEFAULTS.bridgeUrl,
    token: typeof source.token === 'string' ? source.token.trim() : SETTINGS_DEFAULTS.token,
    sharePageContent,
    unrestrictedBrowserAccess: source.unrestrictedBrowserAccess === true,
    trustedActionOrigins: trusted,
    approvalNotifications: source.approvalNotifications !== false,
    autoOpenPanel: source.autoOpenPanel !== false,
    tabSwitch: isTabSwitchMode(source.tabSwitch) ? source.tabSwitch : SETTINGS_DEFAULTS.tabSwitch,
    sessionScope: source.sessionScope === 'pinned' ? 'pinned' : 'fresh',
    // A pinned id is only meaningful when a session is actually named; an empty
    // or non-string value collapses to "nothing chosen" rather than sending the
    // next prompt to a session id built from junk.
    pinnedSessionId: typeof source.pinnedSessionId === 'string' && source.pinnedSessionId.trim() !== ''
      ? source.pinnedSessionId.trim()
      : null,
    readWidth: clampReadWidth(source.readWidth),
  }
}

/** Keep the reading cap inside a range that is still a line length, not a layout. */
export function clampReadWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SETTINGS_DEFAULTS.readWidth
  return Math.min(1200, Math.max(360, Math.round(value)))
}
