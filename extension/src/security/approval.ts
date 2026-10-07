/** Shared control-strip/background contract for browser action approval. */

export type ApprovalKind = 'read' | 'action'
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-origin'
/** Background authorization result; transport failures must not masquerade as a user decision. */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

/** A policy decision awaiting a user response. */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  origins: string[]
  /** True only when one stable origin can safely be added to the action allowlist. */
  canTrust: boolean
}

/**
 * Correlated request delivered to every open control strip.
 *
 * `sessionId` is echoed from the bridge so the record stays self-describing
 * when several dsh conversations drive the same browser, but the control strip
 * never has to resolve or restore that conversation: the desktop GUI owns it.
 */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** Agent session that requested the browser operation, when known. */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-origin'
}
