/**
 * The annotated main-content render: the page's text with a marker where each
 * image sits.
 *
 * A snapshot is rendered synchronously in the content script; a description
 * arrives seconds later from a model. The description therefore cannot be born
 * inside the text — so the text carries a marker at each image's position and the
 * background fills the markers before the text reaches the model. The format and
 * the fill pass live in `markers.ts`, because the background has to agree with
 * this file byte for byte.
 *
 * Rendering stays hybrid on purpose: only the branches that lead to an image are
 * walked, and every other subtree is read whole through `innerText`. Walking
 * everything would trade the browser's own text quality for positions the model
 * does not need at that granularity.
 *
 * @module
 */

import { elementText } from './extract.ts'
import { escapeMarkers, imageMarker } from '../markers.ts'

/**
 * Render an element's text with a marker at each image's position.
 *
 * With no images this is the plain render — the walk finds no branch to follow
 * and reads the root whole — so a page without images takes the code path it
 * always did. Whitespace is collapsed exactly as the plain read collapses it, so
 * the annotated text is the same text plus markers rather than a differently
 * shaped document.
 *
 * The stripping is unconditional, including when there is nothing to mark: a page
 * with no images is precisely where a forged marker would otherwise be the only
 * one in the prompt.
 *
 * @param root - the content root to render.
 * @param indexOf - image element to inventory index.
 * @returns the annotated text.
 */
export function annotatedText(root: Element, indexOf: ReadonlyMap<Element, number>): string {
  // The branches that must be walked: every ancestor of a marked element. Set
  // membership is what keeps the walk proportional to the images, not the DOM.
  const walked = new Set<Element>()
  for (const element of indexOf.keys()) {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) walked.add(parent)
  }

  const out: string[] = []
  render(root, walked, indexOf, out)
  return out.join('').replace(/\s+/g, ' ').trim()
}

function render(
  node: Node,
  walked: ReadonlySet<Element>,
  indexOf: ReadonlyMap<Element, number>,
  out: string[],
): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element
    const index = indexOf.get(element)
    if (index !== undefined) {
      out.push(imageMarker(index))
      return
    }
    if (!walked.has(element)) {
      // Read whole, and still strip: an unmarked subtree is page text like any
      // other, and a forged marker is exactly what this prevents.
      out.push(escapeMarkers(elementText(element)))
      return
    }
    for (const child of element.childNodes) render(child, walked, indexOf, out)
    return
  }
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(escapeMarkers((node as Text).data))
  }
}
