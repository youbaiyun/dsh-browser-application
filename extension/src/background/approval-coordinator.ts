import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../security/approval.ts'

export type ApprovalRequestResult =
  | { status: 'decision'; decision: ApprovalDecision }
  | { status: 'unavailable' | 'timed-out' | 'cancelled' }

interface PendingApproval {
  request: ApprovalRequest
  resolve: (result: ApprovalRequestResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface ApprovalCoordinatorCallbacks {
  /** Offer the request to every open control strip; true when one accepted it. */
  deliver: (request: ApprovalRequest) => boolean
  /** Fall back to an OS notification when no control strip is open. */
  notify: (request: ApprovalRequest) => void
  clearNotification: (id: string) => void
  resolved: (id: string) => void
}

/**
 * Time allowed for a user to decide.
 *
 * The control strip is a popup, so an approval usually arrives while it is
 * closed: the user has to notice the notification or the toolbar badge, open the
 * strip, and read the summary. Two minutes is the smallest window that leaves
 * room for that without letting a stale request sit around indefinitely.
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/**
 * Own pending approvals independently of any view's lifetime.
 *
 * The control strip is a short-lived popup, so a request decides nothing about
 * who is looking: it is offered to whatever views exist, kept in `pending`, and
 * replayed to the next one that opens.
 */
export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly callbacks: ApprovalCoordinatorCallbacks,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
  ) {}

  request(prompt: ApprovalPrompt, signal: AbortSignal, sessionId?: string): Promise<ApprovalRequestResult> {
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' })
    const request: ApprovalRequest = {
      ...prompt,
      id: crypto.randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    return new Promise((resolve) => {
      const onAbort = (): void => { this.settle(request.id, { status: 'cancelled' }) }
      const resolveWithCleanup = (result: ApprovalRequestResult): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const timer = setTimeout(() => { this.settle(request.id, { status: 'timed-out' }) }, this.timeoutMs)
      this.pending.set(request.id, { request, resolve: resolveWithCleanup, timer })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        this.settle(request.id, { status: 'cancelled' })
        return
      }
      if (!this.callbacks.deliver(request)) this.callbacks.notify(request)
    })
  }

  respond(id: string, decision: ApprovalDecision): void {
    this.settle(id, { status: 'decision', decision })
  }

  /** Every request still waiting for a decision, oldest first. */
  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => ({ ...request, origins: [...request.origins] }))
  }

  /** Drop one caller's pending request without claiming the user decided it. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { status: 'cancelled' })
    }
  }

  /** Notify for requests that lost their final visible control strip. */
  notifyPending(): void {
    for (const { request } of this.pending.values()) {
      this.callbacks.notify(request)
    }
  }

  private settle(id: string, result: ApprovalRequestResult): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
    this.callbacks.clearNotification(id)
    this.callbacks.resolved(id)
  }
}
