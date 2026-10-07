/**
 * Live session view for the full-page control UI: the assistant's streamed text,
 * the execution timeline, and the turn/queue flags the page renders.
 *
 * The worker keeps exactly one dsh session per lifetime and holds nothing
 * durable: no transcript, no history, no frame buffer. The desktop dsh app owns
 * the conversation log, and a page that opens mid-turn repaints from the pushed
 * `ControlState`, so nothing here is persisted or replayed.
 *
 * @module
 */

import type { ActivityEntry, AssistantStreamEvent, ControlState, TimelineEntry } from '../settings.ts'

/** Rows kept in the timeline; the oldest are dropped once it is full. */
export const TIMELINE_LIMIT = 200

/**
 * Shortest gap between two streaming publishes.
 *
 * Each publish clones the assistant's whole text and posts it across the port, so at the
 * rate a fast model streams, doing it per delta is both wasteful and quadratic in the reply
 * length. 50 ms keeps the text visibly live (20 updates a second is smoother than reading)
 * while making the cross-process cost depend on elapsed time rather than on delta count.
 */
export const STREAM_NOTIFY_MS = 50

/** What the page's rendered view is told whenever the session view changed. */
export interface ControlSessionSinks {
  /** Called after a change the page should repaint; never called per stream delta. */
  changed(): void
}

let idSequence = 0

function newId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one `session/assistant-stream` push for the active session.
 *
 * The bridge payload is `{ sessionId, snapshotId?, frame }`; a `snapshot` frame
 * is an authoritative baseline and every other frame is a dense delta. The port
 * event mirrors that split: a snapshot keeps its `snapshotId` beside the frame
 * (`{ snapshotId?, frame }`), while a delta IS its frame. Frames for another
 * session are dropped: one worker follows one session, and a second dsh window
 * sharing the bridge must not paint into this page's conversation.
 * @param payload - raw bridge payload.
 * @param activeSessionId - the session this worker drives, if any.
 * @returns the port event to forward, or null when it is not this session's.
 */
export function assistantStreamEvent(payload: unknown, activeSessionIds: ReadonlySet<string>): AssistantStreamEvent | null {
  if (!isRecord(payload)) return null
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || !activeSessionIds.has(sessionId)) return null
  const frame = payload.frame
  if (!isRecord(frame)) return null
  if (frame.type !== 'snapshot') return { sessionId, kind: 'delta', payload: frame }
  const snapshotId = payload.snapshotId
  return {
    sessionId,
    kind: 'snapshot',
    payload: {
      ...(typeof snapshotId === 'string' && snapshotId !== '' ? { snapshotId } : {}),
      frame,
    },
  }
}

/** The stream frame inside one normalized assistant-stream event. */
function streamFrame(event: AssistantStreamEvent): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return undefined
  if (event.kind !== 'snapshot') return event.payload
  const frame = event.payload.frame
  return isRecord(frame) ? frame : undefined
}

/**
 * Normalize one `session/event` push for the active session.
 *
 * The event is forwarded raw: the page renders tool calls, messages, and turn
 * boundaries itself, so the worker only decides whether it belongs to the
 * session this worker is driving.
 * @param payload - raw bridge payload.
 * @param activeSessionId - the session this worker drives, if any.
 * @returns the port message to forward, or null when it is not this session's.
 */
export function sessionEventMessage(
  payload: unknown,
  activeSessionIds: ReadonlySet<string>,
): { sessionId: string; event: unknown } | null {
  if (!isRecord(payload)) return null
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || !activeSessionIds.has(sessionId)) return null
  const event = payload.event
  if (!isRecord(event)) return null
  return { sessionId, event }
}

/** Text of the `text` blocks in one content array, or undefined when there is none. */
function textFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim() === '') continue
    parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Authoritative assistant text of one durable `assistant/message` event. */
function assistantMessageText(event: Record<string, unknown>): string | undefined {
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return undefined
  const message = isRecord(data.message) ? data.message : undefined
  return textFromBlocks(message?.content ?? data.content)
}

/**
 * Text carried by an authoritative stream baseline.
 *
 * A baseline holds the attempt already in progress: `text-chunks` records carry
 * joined groups of deltas, and raw `chunk` records carry a single one.
 */
function baselineText(baseline: unknown): string {
  if (!isRecord(baseline)) return ''
  const attempt = baseline.activeAttempt
  if (!isRecord(attempt) || !Array.isArray(attempt.stream)) return ''
  const parts: string[] = []
  for (const record of attempt.stream) {
    if (!isRecord(record)) continue
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      for (const text of record.texts) {
        if (typeof text === 'string') parts.push(text)
      }
      continue
    }
    const chunk = record.type === 'chunk' && isRecord(record.chunk) ? record.chunk : undefined
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
  }
  return parts.join('')
}

/**
 * The session and timeline the control page renders.
 *
 * Rows are chronological (oldest first) and capped; model text updates ONE
 * assistant row per turn instead of appending a row per delta; and the
 * accumulated per-turn text is dropped at `turn/end`, so a long conversation
 * cannot grow the worker's memory.
 */
export class ControlSession {
  private readonly entries: TimelineEntry[] = []
  private sessionId: string | null = null
  private turn: 'idle' | 'running' = 'idle'
  private pendingPrompt = false
  /** Assistant text committed by durable messages in this turn. */
  private committedText: string[] = []
  /** Text streamed since the last commit or baseline. */
  private attemptText = ''
  private assistantRowId: string | null = null
  /** Pending coalesced streaming publish, or null when none is scheduled. */
  private streamNotifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sinks: ControlSessionSinks) {}

  /** The one session this worker talks to, or null before the first prompt. */
  get id(): string | null {
    return this.sessionId
  }

  /**
   * Every conversation whose events this worker forwards to the panel.
   *
   * One entry in the ordinary modes — the conversation the panel is bound to — plus
   * whatever 「工作区内」 mirrors. Always a set, so the event router does not have to
   * know which mode is in force.
   */
  activeSessionIds(): ReadonlySet<string> {
    const ids = new Set(this.mirrored.keys())
    if (this.sessionId !== null) ids.add(this.sessionId)
    return ids
  }

  /**
   * The extra conversations being mirrored, keyed by id, with the label to show.
   *
   * @param sessions - the conversations 「工作区内」 is mirroring; empty to stop.
   */
  setMirrored(sessions: ReadonlyMap<string, string>): void {
    this.mirrored = new Map(sessions)
  }

  /** The label for one mirrored conversation, for the panel's row headers. */
  labelFor(sessionId: string): string | undefined {
    return this.mirrored.get(sessionId)
  }

  /** The `ControlState.session` slice. */
  session(): ControlState['session'] {
    return { id: this.sessionId, turn: this.turn, pendingPrompt: this.pendingPrompt }
  }

  /** The `ControlState.timeline` slice, oldest row first. */
  timeline(): TimelineEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  /** Remember the session this worker drives; the page reports it in `state`. */
  adopt(id: string): void {
    if (this.sessionId === id) return
    this.sessionId = id
    this.sinks.changed()
  }

  /** Ids of the rows whose work has already begun. */
  inFlightRowIds(activeToolCallIds: Iterable<string>): Set<string> {
    const ids = new Set<string>(activeToolCallIds)
    for (const entry of this.entries) {
      // A submitted prompt is in flight; a queued tool step is not.
      if (entry.kind === 'request' && entry.state === 'pending') ids.add(entry.id)
    }
    return ids
  }

  /**
   * Forget every conversation except the ones named, keeping rows that belong to none.
   *
   * 「工作区内」 mirrors a set of conversations, and the set changes as the desktop
   * starts and archives work. This is the narrow version of {@link detach}: a
   * conversation that left the set loses its rows, while the others keep theirs —
   * which is what makes the mode readable at all, since clearing everything would
   * wipe the conversations the user is still watching.
   *
   * @param keep - sessions still being mirrored.
   */
  retainSessions(keep: ReadonlySet<string>): void {
    const dropped = this.entries.filter((entry) => entry.sessionId !== undefined && !keep.has(entry.sessionId))
    if (dropped.length === 0) return
    const kept = this.entries.filter((entry) => entry.sessionId === undefined || keep.has(entry.sessionId))
    this.entries.length = 0
    this.entries.push(...kept)
    // A row that vanishes while its conversation is gone must not leave the panel
    // claiming a turn is still running for it.
    if (dropped.some((entry) => entry.sessionId === this.sessionId)) {
      this.turn = 'idle'
      this.committedText = []
      this.attemptText = ''
      this.assistantRowId = null
    }
    this.sinks.changed()
  }

  /**
   * Which conversation the rows being created right now belong to.
   *
   * Set by the event router before it applies anything, and read by `push`, so that
   * 「工作区内」 can mirror several conversations at once without every row-producing
   * method having to carry a session id. It is `null` for the panel's own transcript,
   * where the binding is the only conversation there is.
   */
  private attributedSessionId: string | null = null

  /** Extra conversations 「工作区内」 is mirroring: id → label. Empty in every other mode. */
  private mirrored = new Map<string, string>()

  /**
   * Name the conversation the next rows belong to.
   *
   * @param sessionId - the conversation being applied, or null for the panel's own.
   */
  attributeTo(sessionId: string | null): void {
    this.attributedSessionId = sessionId
  }

  /**
   * Tag a row with the conversation it came from.
   *
   * @param entry - the row about to be appended.
   * @returns the row, with `sessionId` set when one is being attributed.
   */
  private attributed(entry: TimelineEntry): TimelineEntry {
    if (this.attributedSessionId === null) return entry
    return { ...entry, sessionId: this.attributedSessionId }
  }

  /**
   * Forget the session and everything shown for it.
   *
   * Used when the user points the panel at a different conversation, or back at
   * one of its own. The transcript belongs to the session it came from, so
   * keeping the rows would present one conversation's history as another's.
   *
   * `keepIds` names work that is genuinely in flight — a prompt already
   * submitted, a tool already dispatched. Those rows stay because their outcome
   * is still coming and erasing them would remove the only sign of it. A row
   * that is merely *queued* is dropped: it has not started, and it is about to
   * run against the conversation the user just moved to.
   *
   * @param keepIds - ids of rows whose work is already under way.
   */
  detach(keepIds: ReadonlySet<string> = new Set()): void {
    this.sessionId = null
    // A tool step row carries the id of the activity row it belongs to, not its
    // own, so matching on `id` alone silently dropped exactly the rows this
    // parameter exists to preserve — and the outcome arriving later then created
    // a fresh row instead of filling the one that was already on screen.
    const inFlight = this.entries.filter((entry) => keepIds.has(entry.callId ?? entry.id))
    this.entries.length = 0
    this.entries.push(...inFlight)
    this.turn = 'idle'
    this.committedText = []
    this.attemptText = ''
    this.assistantRowId = null
    // `pendingPrompt` describes the kept row above, not the binding that changed.
    if (inFlight.length === 0) this.pendingPrompt = false
    this.sinks.changed()
  }

  /**
   * Append the user's submitted request and mark the prompt queue busy.
   * @param text - the text the user submitted.
   * @returns the row id, so a rejected prompt can drop exactly this row.
   */
  beginPrompt(text: string): string {
    const entry: TimelineEntry = {
      id: newId('request'),
      kind: 'request',
      text,
      state: 'pending',
      at: Date.now(),
      // The conversation the next prompt goes to, which in workspace mode is the
      // panel's own session rather than any of the ones being mirrored.
      ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
    }
    this.push(entry)
    // Set before the gateway answers rather than after admission: the first
    // `turn/start` can arrive while the prompt reply is still in flight, and a
    // later admission must not resurrect a flag that turn already cleared.
    this.pendingPrompt = true
    this.sinks.changed()
    return entry.id
  }

  /** The gateway admitted the prompt: the desktop owns it from here. */
  admitPrompt(id: string): void {
    if (this.updateRow(id, { state: 'done' })) this.sinks.changed()
  }

  /** The prompt never reached the desktop: drop its row and clear the queue flag. */
  rejectPrompt(id: string): void {
    this.pendingPrompt = false
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index !== -1) this.entries.splice(index, 1)
    this.sinks.changed()
  }

  /** `turn/start`: the model is working; a queued prompt is no longer pending. */
  startTurn(): void {
    this.turn = 'running'
    this.pendingPrompt = false
    this.resetTurnText()
    this.sinks.changed()
  }

  /** `turn/end`: the turn is over, so its row is finished and its live text dropped. */
  endTurn(): void {
    this.turn = 'idle'
    this.pendingPrompt = false
    this.settleAssistantRow('done')
    this.resetTurnText()
    this.flushStreamNotify()
    this.sinks.changed()
  }

  /** The user stopped the turn: nothing is queued any more, so say so at once. */
  cancelTurn(): void {
    this.turn = 'idle'
    this.pendingPrompt = false
    this.settleAssistantRow('cancelled')
    for (const entry of this.entries) {
      if (entry.kind === 'request' && entry.state === 'pending') entry.state = 'cancelled'
    }
    this.flushStreamNotify()
    this.sinks.changed()
  }

  /**
   * Apply one assistant-stream push.
   *
   * Only the row's text changes: `session.stream` already carries every delta
   * to the live page, and re-pushing the whole timeline per token would flood
   * the port. The worker's copy still tracks the text so a page that opens
   * mid-turn repaints what has arrived so far.
   * @param event - the normalized stream event already forwarded to the page.
   */
  applyStream(event: AssistantStreamEvent): void {
    const frame = streamFrame(event)
    if (frame === undefined) return
    if (event.kind === 'snapshot') {
      // A baseline is authoritative for the attempt in progress: replace the
      // live suffix so a mid-turn opener never shows a half-accumulated prefix.
      this.attemptText = baselineText(frame.baseline)
      this.refreshAssistantRow()
      return
    }
    if (frame.type === 'start') {
      this.attemptText = ''
      this.refreshAssistantRow()
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!isRecord(chunk) || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
    this.attemptText += chunk.text
    this.refreshAssistantRow()
  }

  /**
   * Apply one durable session event to the turn flags and the assistant row.
   * @param event - the raw `session/event` payload event.
   */
  applyEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== 'string') return
    switch (event.type) {
      case 'turn/start':
        this.startTurn()
        return
      case 'turn/end':
        this.endTurn()
        return
      case 'assistant/message': {
        const text = assistantMessageText(event)
        if (text === undefined) return
        // The durable message repeats what the stream already showed. Commit it
        // as this step's authoritative text and stop showing the live suffix.
        if (this.committedText.at(-1) !== text) this.committedText.push(text)
        this.attemptText = ''
        // Drop any coalesced streaming publish: the authoritative row below supersedes it,
        // and leaving it pending would repaint the same text a moment later.
        this.flushStreamNotify()
        this.refreshAssistantRow(true)
        return
      }
      default:
        return
    }
  }

  /**
   * Add one tool or command run to the timeline.
   * @param callId - id shared with the matching `ActivityEntry`.
   * @param tool - tool name, such as `browser_click`.
   * @param text - safe display summary of the run.
   */
  addStep(callId: string, tool: string, text: string): void {
    const index = this.stepIndex(callId)
    if (index === -1) {
      this.push({
        id: newId('step'),
        kind: 'step',
        text,
        tool,
        state: 'pending',
        at: Date.now(),
        callId,
      })
      this.sinks.changed()
      return
    }
    const current = this.entries[index]!
    if (current.text === text && current.tool === tool) return
    this.entries[index] = { ...current, text, tool }
    this.sinks.changed()
  }

  /** The browser work actually began; a step still queued is now running. */
  startStep(callId: string): void {
    const index = this.stepIndex(callId)
    if (index === -1) return
    const current = this.entries[index]!
    if (current.state !== 'pending') return
    this.entries[index] = { ...current, state: 'running' }
    this.sinks.changed()
  }

  /** Mirror one activity transition onto its step row (creating it when needed). */
  applyActivity(entry: ActivityEntry): void {
    const index = this.stepIndex(entry.id)
    if (index === -1) {
      this.push({
        id: newId('step'),
        kind: 'step',
        text: entry.summary,
        tool: entry.name,
        state: entry.state,
        at: entry.at,
        callId: entry.id,
      })
      this.sinks.changed()
      return
    }
    const current = this.entries[index]!
    if (current.text === entry.summary && current.state === entry.state && current.tool === entry.name) return
    this.entries[index] = { ...current, text: entry.summary, tool: entry.name, state: entry.state }
    this.sinks.changed()
  }

  private resetTurnText(): void {
    this.committedText = []
    this.attemptText = ''
    this.assistantRowId = null
  }

  private assistantText(): string {
    return [...this.committedText, this.attemptText]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')
  }

  /**
   * Create or update the turn's single assistant row.
   *
   * Only the text changes on an existing row: its state belongs to the turn, so
   * a late durable message cannot resurrect a row that `turn/end` already
   * settled.
   * @param notify - force a repaint even when the row already exists.
   */
  private refreshAssistantRow(notify = false): void {
    const text = this.assistantText()
    if (text === '') return
    if (this.assistantRowId !== null) {
      const index = this.entries.findIndex((entry) => entry.id === this.assistantRowId)
      if (index !== -1) {
        const current = this.entries[index]!
        if (current.text === text) {
          if (notify) this.sinks.changed()
          return
        }
        this.entries[index] = { ...current, text }
        if (notify) this.sinks.changed()
        else this.scheduleStreamNotify()
        return
      }
      // The cap dropped the row; the next update starts a fresh one.
      this.assistantRowId = null
    }
    const entry: TimelineEntry = {
      id: newId('assistant'),
      kind: 'assistant',
      text,
      // Text that arrives outside a live turn (a durable message delivered
      // after `turn/end`) is already final.
      state: this.turn === 'running' ? 'running' : 'done',
      at: Date.now(),
    }
    this.assistantRowId = entry.id
    this.push(entry)
    if (notify) this.sinks.changed()
    else this.scheduleStreamNotify()
  }

  /**
   * Publish a streaming update at most once per {@link STREAM_NOTIFY_MS}.
   *
   * Each publish clones the whole assistant text and posts it across the port, and a reply
   * can produce hundreds of deltas per second, so notifying per delta made the cross-process
   * cost grow with the square of the reply length. Coalescing keeps the row in step while
   * making that cost linear. A plain timer rather than an animation frame: this runs in the
   * service worker, where a frame callback is not guaranteed to arrive.
   */
  private scheduleStreamNotify(): void {
    if (this.streamNotifyTimer !== null) return
    this.streamNotifyTimer = setTimeout(() => {
      this.streamNotifyTimer = null
      this.sinks.changed()
    }, STREAM_NOTIFY_MS)
  }

  /** Publish any coalesced streaming update right away; used when a turn settles. */
  private flushStreamNotify(): void {
    if (this.streamNotifyTimer === null) return
    clearTimeout(this.streamNotifyTimer)
    this.streamNotifyTimer = null
    this.sinks.changed()
  }

  /** Finish the turn's assistant row, when it has one and the cap kept it. */
  private settleAssistantRow(state: 'done' | 'cancelled'): void {
    if (this.assistantRowId === null) return
    const index = this.entries.findIndex((entry) => entry.id === this.assistantRowId)
    if (index === -1) return
    const current = this.entries[index]!
    if (current.state !== state) this.entries[index] = { ...current, state }
  }

  private stepIndex(callId: string): number {
    return this.entries.findIndex((entry) => entry.kind === 'step' && entry.callId === callId)
  }

  private updateRow(id: string, patch: Partial<TimelineEntry>): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    this.entries[index] = { ...this.entries[index]!, ...patch }
    return true
  }

  private push(entry: TimelineEntry): void {
    this.entries.push(this.attributed(entry))
    if (this.entries.length > TIMELINE_LIMIT) {
      this.entries.splice(0, this.entries.length - TIMELINE_LIMIT)
    }
  }
}
