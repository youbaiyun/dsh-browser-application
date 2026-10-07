/**
 * Tracks Chrome's last-focused window without letting stale asynchronous
 * tab results overwrite newer focus or activation events.
 *
 * @module
 */

export class FocusedWindowTracker {
  private windowId: number | null = null
  private revision = 0

  /** Start a query and invalidate any older query or activation metadata. */
  beginQuery(): number {
    this.revision += 1
    return this.revision
  }

  /** Record an authoritative focus event and invalidate in-flight queries. */
  markFocused(windowId: number): void {
    this.windowId = windowId
    this.revision += 1
  }

  /** Accept a query only if no newer query, focus, or activation won the race. */
  commitQuery(windowId: number, revision: number): boolean {
    if (revision !== this.revision) return false
    this.windowId = windowId
    return true
  }

  /** Accept an activation from the focused window and invalidate stale work. */
  acceptActivation(windowId: number): number | null {
    if (this.windowId !== windowId) return null
    this.revision += 1
    return this.revision
  }

  /** Whether an async result still belongs to the latest accepted event. */
  isCurrent(revision: number): boolean {
    return this.revision === revision
  }
}
