/**
 * Per-session memo of image recognition results, keyed by image identity.
 *
 * The reason to cache is consistency before cost. Recognition is not
 * deterministic: the same image asked twice yields two different sentences, so a
 * page showing one logo in thirty rows would produce thirty mutually
 * contradictory descriptions of it. Keying on identity makes the answer a
 * property of the image rather than of how many times it was encountered.
 *
 * Failures are remembered too, with a different rule per kind: a `blob:` URL or
 * an over-budget body cannot start working later in the same session, while a
 * network error can. Retrying the first kind burns a request per snapshot for
 * nothing; retrying the second is exactly what recovery looks like.
 *
 * @module
 */

/**
 * One remembered answer, and which transport produced it.
 *
 * The shape is also what persistence stores, so it stays plain data.
 */
export interface CachedDescription {
  desc: string
  /** `desktop` or `direct`: kept so a cached answer can still attribute cost. */
  via: 'desktop' | 'direct' | ''
}

/** Everything worth carrying across a service-worker restart. */
export interface CacheSnapshot {
  descriptions: [string, CachedDescription][]
  failureCounts: [string, number][]
  permanentFailures: [string, string][]
}

/** Called after every mutation, so a host can persist the cache. */
export type CacheListener = (cache: ImageCache) => void

/** A malformed stored snapshot is discarded rather than half-restored. */
function readStringMap(value: unknown, guard: (entry: unknown) => boolean): [string, string][] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is [string, string] => (
    Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && typeof entry[1] === 'string' && guard(entry[1])
  ))
}

/** Bounded store of descriptions and failure counts. */
export class ImageCache {
  private readonly descriptions = new Map<string, CachedDescription>()
  private readonly failureCounts = new Map<string, number>()
  /**
   * Identities that cannot be read this session, with the reason.
   *
   * The reason is kept, not just the fact: the text the model reads says why an
   * image is unavailable, and "unavailable" with no cause is a fact it can do
   * nothing with.
   */
  private readonly permanentFailures = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxAttempts: number
  private readonly onChanged: CacheListener | undefined

  /**
   * @param maxEntries - descriptions kept before the oldest is evicted.
   * @param maxAttempts - transient failures tolerated per identity.
   * @param onChanged - notified after every mutation, for persistence.
   */
  constructor(maxEntries = 200, maxAttempts = 2, onChanged?: CacheListener) {
    this.maxEntries = maxEntries
    this.maxAttempts = maxAttempts
    this.onChanged = onChanged
  }

  /**
   * Drop the oldest entries of a map that has no natural bound of its own.
   *
   * `descriptions` is bounded where it is written, but the two failure maps only
   * shrink when the same identity later succeeds. A profile that meets many unique
   * failures — `blob:` URLs, images whose load failed, bodies over the byte budget
   * — would otherwise keep one entry per identity forever, and every one of them
   * is part of the payload written to disk on each change.
   *
   * @param entries - the failure map to bound, mutated in place.
   */
  private evictOldest(entries: Map<string, unknown>): void {
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  /**
   * The cache as plain data, for a host that survives longer than this object.
   *
   * A service worker is not a place to keep state: Chrome may stop it between two
   * tool calls, and a browser restart certainly ends it. Without this, the only
   * lever that measurably shortens a recognition — asking twice about the same
   * image — would work only while the worker happened to be alive.
   */
  snapshot(): CacheSnapshot {
    return {
      descriptions: [...this.descriptions],
      failureCounts: [...this.failureCounts],
      permanentFailures: [...this.permanentFailures],
    }
  }

  /**
   * Restore a snapshot, ignoring anything that does not match the shape.
   *
   * Storage is shared with other code and survives upgrades, so a snapshot can be
   * stale or foreign. A partially believable restore would be worse than none.
   *
   * @param value - whatever the host stored.
   * @returns true when something was restored.
   */
  restore(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Partial<CacheSnapshot>
    const descriptions = Array.isArray(record.descriptions)
      ? record.descriptions.filter((entry): entry is [string, CachedDescription] => (
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && typeof entry[1] === 'object' && entry[1] !== null
        && typeof (entry[1] as CachedDescription).desc === 'string'
        && typeof (entry[1] as CachedDescription).via === 'string'
      ))
      : []
    const counts = Array.isArray(record.failureCounts)
      ? record.failureCounts.filter((entry): entry is [string, number] => (
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && typeof entry[1] === 'number' && Number.isFinite(entry[1])
      ))
      : []
    const permanent = readStringMap(record.permanentFailures, (code) => code !== '')
    if (descriptions.length === 0 && counts.length === 0 && permanent.length === 0) return false
    for (const [identity, entry] of descriptions.slice(-this.maxEntries)) {
      this.descriptions.set(identity, entry)
    }
    for (const [identity, count] of counts) this.failureCounts.set(identity, count)
    for (const [identity, code] of permanent) this.permanentFailures.set(identity, code)
    // A snapshot written before the bound existed can exceed it, so the bound is
    // applied on the way in as well as on the way out.
    this.evictOldest(this.failureCounts)
    this.evictOldest(this.permanentFailures)
    return true
  }

  /**
   * Remembered description for an image.
   * @param identity - image identity (the protocol's `identity`).
   * @returns the entry, or undefined when not yet recognised.
   */
  get(identity: string): CachedDescription | undefined {
    return this.descriptions.get(identity)
  }

  /**
   * Record a successful recognition.
   *
   * Eviction is insertion-ordered rather than least-recently-used: reads are far
   * more frequent than writes here, and reordering on every read would cost more
   * than the occasional re-recognition it saves.
   *
   * @param identity - image identity.
   * @param desc - one-line description.
   * @param via - transport that produced it.
   */
  set(identity: string, desc: string, via: 'desktop' | 'direct' | '' = ''): void {
    this.descriptions.delete(identity)
    this.descriptions.set(identity, { desc, via })
    this.permanentFailures.delete(identity)
    this.failureCounts.delete(identity)
    while (this.descriptions.size > this.maxEntries) {
      const oldest = this.descriptions.keys().next()
      if (oldest.done === true) break
      this.descriptions.delete(oldest.value)
    }
    this.onChanged?.(this)
  }

  /**
   * Record a failed recognition.
   * @param identity - image identity.
   * @param permanent - true when retrying cannot succeed this session.
   * @param code - why it failed, for the text the model reads.
   */
  noteFailure(identity: string, permanent: boolean, code = 'unavailable'): void {
    if (permanent) {
      this.permanentFailures.set(identity, code)
      this.evictOldest(this.permanentFailures)
      this.onChanged?.(this)
      return
    }
    this.failureCounts.set(identity, (this.failureCounts.get(identity) ?? 0) + 1)
    this.evictOldest(this.failureCounts)
    this.onChanged?.(this)
  }

  /**
   * Why an image cannot be read, when that is settled.
   * @param identity - image identity.
   * @returns the failure code, or undefined when it is not permanently failed.
   */
  failureOf(identity: string): string | undefined {
    return this.permanentFailures.get(identity)
  }

  /**
   * Whether a recognition attempt is worth making.
   * @param identity - image identity.
   * @returns false when the image already has an answer, or cannot be answered.
   */
  shouldAttempt(identity: string): boolean {
    if (this.descriptions.has(identity)) return false
    if (this.permanentFailures.has(identity)) return false
    return (this.failureCounts.get(identity) ?? 0) < this.maxAttempts
  }

  /** Number of remembered descriptions. */
  get size(): number {
    return this.descriptions.size
  }

  /**
   * Counts for the panel and for diagnostics.
   * @returns described and permanently-unavailable counts.
   */
  stats(): { described: number; unavailable: number; retrying: number } {
    return {
      described: this.descriptions.size,
      unavailable: this.permanentFailures.size,
      retrying: this.failureCounts.size,
    }
  }

  /** Drop everything (new page, new user decision). */
  clear(): void {
    this.descriptions.clear()
    this.failureCounts.clear()
    this.permanentFailures.clear()
    this.onChanged?.(this)
  }
}
