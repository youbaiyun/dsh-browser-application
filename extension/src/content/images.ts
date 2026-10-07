/**
 * Image inventory: which images a page has, where they are, and whether their
 * text alternatives already describe them.
 *
 * The snapshot is text, so an image is otherwise invisible to the model — not
 * "hard to read", simply absent: `innerText`/`textContent` never include `alt`,
 * and the interactive selector does not match `img`. This module makes each
 * image a numbered, clickable, textually-annotated entry instead.
 *
 * Two consequences are deliberate:
 *
 * - Elements are returned so the caller can put them in the same id registry as
 *   interactive elements. That is what makes `[i12]` clickable without any
 *   coordinate math — the model addresses an image the same way it addresses a
 *   button, and positioning never depends on a model's pixel estimates.
 * - `textDescribed` records that the DOM already answers "what is this?" (alt,
 *   `aria-label`, `title`, `<figcaption>`, `<svg><text>`). Those images are
 *   still listed, because knowing one exists is useful, but they must not be
 *   sent for recognition: the answer is already in the text, and a model call
 *   would only add cost and a chance to contradict it.
 *
 * @module
 */

import { isVisible, truncate } from './extract.ts'

/** How an image was found, which decides how it can be read later. */
export type ImageKind = 'img' | 'background' | 'svg' | 'poster'

/** One image found on the page. */
export interface ImageCandidate {
  /** The element that carries the image (the click target). */
  element: Element
  kind: ImageKind
  /** Best known absolute URL, or '' when the image has no fetchable address. */
  src: string
  /** Rendered (or intrinsic) size in CSS pixels; 0 when unmeasurable. */
  width: number
  height: number
  /** alt / aria-label / title text, when present. */
  label: string
  /** Short nearby text (caption or adjacent copy) for context. */
  near: string
  /** Nearest heading above the image: the section it belongs to. */
  heading: string
  /** True when DOM text already describes this image. */
  textDescribed: boolean
  /**
   * True when the browser tried to load this image and got nothing usable.
   *
   * A failed image is worth reporting even though there is nothing to recognize:
   * the page visibly shows a broken or alt-text box, and a model that is told
   * "an image was here and did not load" stops inventing one. What is not
   * reported is a failed image with no alt text — a bare broken box describes
   * nothing and would only add noise on ad-heavy pages.
   */
  failed: boolean
}

/** Below this, an image is a spacer, icon or sprite fragment. */
const MIN_IMAGE_SIDE = 32

/**
 * The identity of one image: its absolute URL, or a placeholder for images that
 * have no address.
 *
 * Defined once because two sides must agree on it exactly — the snapshot, which
 * reports identities so the background can look up a description, and the
 * describe action, which asks for one. Two copies of this rule would drift into
 * a cache that never hits.
 *
 * @param src - absolute URL, or '' when the image has none.
 * @param index - the image's inventory index.
 * @returns the identity.
 */
export function imageIdentity(src: string, index: number): string {
  return src !== '' ? src : `el:${String(index)}`
}

/**
 * How many elements to style-check while looking for background images.
 *
 * A background image is only discoverable by reading computed style, which
 * forces layout for every candidate. Element count is therefore the wrong
 * bound on a huge page: the scan stops at a fixed number of elements instead of
 * scaling with the document.
 */
const BACKGROUND_SCAN_LIMIT = 1500

/** Background images kept per snapshot (they are the most speculative kind). */
const MAX_BACKGROUND_IMAGES = 20

/** Characters of surrounding text kept per image. */
const MAX_NEAR_CHARS = 60

/** The element's own text, trimmed, for `near` and for "has copyable text". */
function ownText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Short text that tells the model what an image is about.
 *
 * A caption is the author's own description, so it wins; otherwise the nearest
 * ancestor's text is used. Only visible text is considered: hidden captions
 * would describe an image the user cannot see.
 *
 * @param el - the image element.
 * @returns up to {@link MAX_NEAR_CHARS} characters, or ''.
 */
function nearbyText(el: Element): string {
  const figure = el.closest('figure')
  const caption = figure?.querySelector('figcaption')
  if (caption !== undefined && caption !== null && isVisible(caption)) {
    const text = truncate(ownText(caption), MAX_NEAR_CHARS).text
    if (text !== '') return text
  }
  let node: Element | null = el.parentElement
  for (let depth = 0; node !== null && depth < 3; depth += 1) {
    const text = truncate(ownText(node), MAX_NEAR_CHARS).text
    if (text !== '') return text
    node = node.parentElement
  }
  return ''
}

/** Size in CSS pixels, preferring intrinsic dimensions for `<img>`. */
function sizeOf(el: Element): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  return { width, height }
}

/** Attributes that already carry a text alternative. */
function labelOf(el: Element): string {
  for (const name of ['alt', 'aria-label', 'title']) {
    const value = el.getAttribute(name)
    if (value !== null && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * The first `url(...)` of a computed `background-image`, if any.
 *
 * @param el - element to inspect.
 * @returns the raw URL, or '' for gradients and `none`.
 */
function backgroundUrlOf(el: Element): string {
  const value = getComputedStyle(el).backgroundImage
  if (value === '' || value === 'none') return ''
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value)
  return match === null ? '' : match[2]
}

/**
 * Whether DOM text already answers what this image is.
 *
 * @param kind - how the image was found.
 * @param el - the image element.
 * @returns true when recognition would add nothing.
 */
function isTextDescribed(kind: ImageKind, el: Element): boolean {
  if (labelOf(el) !== '') return true
  if (kind === 'svg') return el.querySelector('text') !== null
  if (kind === 'img') {
    const figure = el.closest('figure')
    return figure !== null && figure.querySelector('figcaption') !== null
  }
  return false
}

/** Absolute URL for a possibly relative attribute value. */
function absoluteUrl(value: string): string {
  if (value === '') return ''
  try {
    return new URL(value, document.baseURI).href
  } catch {
    return ''
  }
}

/**
 * The nearest heading that precedes an element, in document order.
 *
 * This is the section an image sits under, which is the cheapest disambiguator
 * a page offers: "30%" means something different under "本季度营收" than under
 * "退款率". Document order rather than the ancestor chain, because headings are
 * commonly siblings of the section wrapper rather than its first child.
 *
 * @param el - the image element.
 * @param headings - the page's headings, in document order.
 * @returns the heading text, bounded, or '' when the image precedes every heading.
 */
function headingOf(el: Element, headings: readonly Element[]): string {
  let found = ''
  for (const heading of headings) {
    // FOLLOWING means `el` comes after `heading`; the list is ordered, so the
    // last one that still precedes `el` is the nearest.
    if ((heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) break
    found = ownText(heading)
  }
  return truncate(found, MAX_NEAR_CHARS).text
}

/** Headings under a root, in document order. */
function headingsOf(root: Document | Element): Element[] {
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
}

/**
 * Whether the browser finished trying to load this image and produced no pixels.
 *
 * `complete` is required as well as a zero intrinsic size: before the browser has
 * tried, both are zero, and calling that "failed" would mark every image on a
 * page that is still loading. A non-browser DOM (the test environment) never sets
 * `complete`, so its images are never reported as failed.
 *
 * @param el - the image element.
 * @returns true when the load is finished and yielded nothing.
 */
function failedToLoad(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'img') return false
  const image = el as HTMLImageElement
  return image.complete === true && image.naturalWidth === 0
}

/** The candidate, or null when the element is unusable or too small. */
function candidate(
  kind: ImageKind,
  el: Element,
  src: string,
  headings: readonly Element[],
): ImageCandidate | null {
  if (!isVisible(el)) return null
  const { width, height } = sizeOf(el)
  const label = labelOf(el)
  const failed = failedToLoad(el)
  // The size floor drops spacers, icons and sprite fragments. A failed image is
  // not one of those: its box collapses to the broken-image size, so the floor
  // would hide a picture the author named. It is kept when it has a name, and
  // only then.
  const tooSmall = width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE
  if (tooSmall && !(failed && label !== '')) return null
  return {
    element: el,
    kind,
    src,
    width,
    height,
    label,
    near: nearbyText(el),
    heading: headingOf(el, headings),
    textDescribed: isTextDescribed(kind, el),
    failed,
  }
}

/**
 * Every image worth reporting, in document order.
 *
 * @param root - document (or region) to scan.
 * @returns the candidates, deduplicated by element.
 */
export function collectImages(root: Document | Element): ImageCandidate[] {
  const found: ImageCandidate[] = []
  const seen = new Set<Element>()
  const headings = headingsOf(root)

  const push = (value: ImageCandidate | null): void => {
    if (value === null || seen.has(value.element)) return
    seen.add(value.element)
    found.push(value)
  }

  for (const el of root.querySelectorAll('img')) {
    // `currentSrc` is the candidate the browser actually chose from `srcset`;
    // `src` is only the fallback and may be a smaller variant.
    const src = absoluteUrl((el as HTMLImageElement).currentSrc || el.getAttribute('src') || '')
    push(candidate('img', el, src, headings))
  }

  for (const el of root.querySelectorAll('video[poster]')) {
    push(candidate('poster', el, absoluteUrl(el.getAttribute('poster') ?? ''), headings))
  }

  for (const el of root.querySelectorAll('svg')) {
    // A nested `<svg>` inside another one is part of its parent's rendering.
    if (el.parentElement?.closest('svg') !== null && el.parentElement?.closest('svg') !== undefined) continue
    push(candidate('svg', el, '', headings))
  }

  let scanned = 0
  let backgrounds = 0
  for (const el of root.querySelectorAll('*')) {
    if (scanned >= BACKGROUND_SCAN_LIMIT || backgrounds >= MAX_BACKGROUND_IMAGES) break
    scanned += 1
    if (seen.has(el)) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'img' || tag === 'svg' || tag === 'video' || tag === 'script' || tag === 'style') continue
    const url = backgroundUrlOf(el)
    if (url === '') continue
    const value = candidate('background', el, absoluteUrl(url), headings)
    if (value === null) continue
    backgrounds += 1
    push(value)
  }

  return found
}
