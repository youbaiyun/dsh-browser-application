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
 * Render one Markdown string to sanitized HTML.
 *
 * @param text - markdown source, possibly truncated mid-stream.
 * @returns HTML that is safe to assign to `innerHTML`.
 */
export function renderMarkdown(text: string): string {
  const source = stabilizeStreamingMarkdown(text)
  const html = marked.parse(source, { async: false }) as string
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string
  // `target` and `rel` cannot be expressed in the allowlist above, so they are
  // applied after sanitizing, when no attacker-controlled markup is left.
  return clean.replace(/<a href="/g, '<a rel="noreferrer noopener" target="_blank" href="')
}

/** Whether a string contains anything worth rendering as Markdown. */
export function hasMarkdownContent(text: string): boolean {
  return text.trim() !== ''
}
