/**
 * Markdown rendering for the model's replies.
 *
 * The assistant answers in Markdown — lists, tables, fenced code — so the panel
 * has to render it or a reply reads as raw punctuation. That means inserting
 * HTML, which is exactly where a page-supplied string could turn into script,
 * so every byte goes through DOMPurify with a narrow allowlist first.
 *
 * The configuration mirrors what the desktop client allows: links, inline
 * formatting, and code, with no images (a remote image would leak the fact that
 * the panel is open), no embedded frames, and no event handlers.
 *
 * @module
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'ul',
]

const ALLOWED_ATTR = ['align', 'class', 'href', 'start', 'title']

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  // Only http(s) links: a `javascript:` or `data:` href must never survive.
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'input', 'style', 'script'],
}

marked.setOptions({ gfm: true, breaks: true })

/**
 * Close an unfinished fenced code block.
 *
 * While a reply streams, the tail can be a half-written ``` fence, which would
 * otherwise swallow the rest of the transcript into one code block until the
 * closing fence arrives.
 */
export function stabilizeStreamingMarkdown(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/**
 * Rendered replies, keyed by source text.
 *
 * A tool step arriving, an approval appearing, a row expanding — each of those rebuilds the
 * transcript, and the rebuild re-rendered Markdown for every reply already on screen. That
 * made a small update cost a parse of the whole conversation. The mapping is pure (same
 * source, same HTML), so a cache removes the repeat work entirely.
 *
 * Bounded so a day-long session cannot grow it without limit, but the bound has to clear the
 * transcript it serves: the worker keeps `TIMELINE_LIMIT` (200) rows, so a long conversation
 * can hold ~100 assistant replies. A cache smaller than that misses for half of them on every
 * rebuild, which is most of the cost it was added to remove.
 *
 * Eviction is least-recently-used, not first-in-first-out: a hit re-inserts, so the replies
 * currently on screen stay warm and only the ones scrolled out of the timeline age out.
 */
const CACHE_LIMIT = 200
const rendered = new Map<string, string>()

/**
 * Render one Markdown string to sanitized HTML, reusing a previous result when the source
 * has not changed since.
 *
 * @param text - markdown source, possibly truncated mid-stream.
 * @returns HTML that is safe to assign to `innerHTML`.
 */
export function renderMarkdown(text: string): string {
  const cached = rendered.get(text)
  if (cached !== undefined) {
    // A `Map` iterates in insertion order, so re-inserting on a hit is what makes this an
    // LRU: the entries a rebuild keeps asking for move to the end and stay, and only the
    // text that has left the screen ages out.
    rendered.delete(text)
    rendered.set(text, cached)
    return cached
  }

  const source = stabilizeStreamingMarkdown(text)
  const html = marked.parse(source, { async: false }) as string
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string
  // `target` and `rel` cannot be expressed in the allowlist above, so they are
  // applied after sanitizing, when no attacker-controlled markup is left.
  const result = clean.replace(/<a href="/g, '<a rel="noreferrer noopener" target="_blank" href="')

  if (rendered.size >= CACHE_LIMIT) {
    const oldest = rendered.keys().next()
    if (!oldest.done) rendered.delete(oldest.value)
  }
  rendered.set(text, result)
  return result
}

/** Whether a string contains anything worth rendering as Markdown. */
export function hasMarkdownContent(text: string): boolean {
  return text.trim() !== ''
}
