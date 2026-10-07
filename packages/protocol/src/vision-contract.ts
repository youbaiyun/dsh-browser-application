/**
 * The vision request and response contract, shared by both recognizer paths.
 *
 * The desktop relay and the extension's own outbound call must ask the same
 * question and read the same answer, or "which path" would silently change what
 * the model is told and what counts as a valid reply. Keeping the prompt, the
 * body shape, and the parser here is what makes the two paths one seam rather
 * than two implementations that drift.
 *
 * Zero-dependency and platform-free: the Node build inlines this into the plugin,
 * and the extension bundler inlines it into the service worker.
 *
 * @module
 */

/**
 * How long a description may be.
 *
 * A summary, not a report. It was 120 characters, then 600 on a request for more
 * detail — which produced the opposite problem: a wall of text about an image the
 * reader only wanted identified. The settle point is a couple of short clauses:
 * long enough to say what this is and what is notable about it, short enough that
 * the answer to "what is this picture?" is one glance.
 *
 * Length is not where quality comes from; the prompts are, which is why they ask
 * for the specifics that fit rather than for more prose.
 */
export const MAX_DESC_CHARS = 200

/**
 * How much of a description rides in a snapshot's inline marker.
 *
 * A snapshot lists every image on the page, so a full description per image would
 * spend the whole character budget on images nobody asked about — and would put a
 * paragraph in front of a reader who wanted a glance. The marker identifies the
 * image; the tool call returns the summary.
 */
export const VISION_MARKER_CHARS = 80

/** The model is told to answer exactly this when it cannot tell what it sees. */
export const VISION_DECLINE = 'UNCLEAR'

/**
 * The one model both recognizer paths call.
 *
 * Fixed, and defined here rather than in either caller, because a model id is
 * part of the question being asked: if the relay named one model and the
 * extension's own path named another, "which transport was free" would silently
 * change the answer. There is also only one value it can take —
 * `deepseek-v4.1-flash` is the display name and is *not* accepted by the API,
 * which answers 400 and lists `deepseek-flash` and `deepseek-v4-pro`; of those,
 * only `deepseek-flash` reports an image input modality.
 */
export const VISION_MODEL = 'deepseek-flash'

/**
 * Thinking blocks cost more than the image does on a pure perception task, so off
 * is the default. Both fields are sent because providers disagree about which one
 * they honour — and a provider may honour neither, which is why the caller reads
 * `usage` back.
 */
export const THINKING_OFF: Record<string, unknown> = { thinking: { type: 'disabled' }, reasoning_effort: 'none' }
export const THINKING_LOW: Record<string, unknown> = {
  thinking: { type: 'enabled', budget_tokens: 512 },
  reasoning_effort: 'low',
}

export interface VisionCallConfig {
  model: string
  /** Extra top-level request fields; carries the thinking switch. */
  extraBody: Record<string, unknown>
}

export interface VisionCallImage {
  /** Base64 bytes, without the `data:` prefix. */
  base64: string
  mediaType: string
}

/** What the page already knows about the image, so the answer is about that one. */
export interface VisionCallContext {
  alt: string
  near: string
  heading: string
  kind: string
  /**
   * How much the caller wants from the answer.
   *
   * Carried in the request rather than chosen by the caller of
   * {@link buildVisionRequestBody}, because both transports build the same body:
   * a tier that only changed the extension's own outbound call would silently
   * mean something different when the desktop relays it.
   */
  tier?: string
}

export type VisionCallResult =
  | { ok: true; desc: string; usage?: Record<string, unknown> }
  | { ok: false; code: string; message: string }

export const VISION_SYSTEM_PROMPT = [
  'You describe a single image taken from a web page, for a browsing agent that cannot see it.',
  `Answer with one line of at most ${String(MAX_DESC_CHARS)} characters, in the language of the page context.`,
  'Say what it is and what is most visible about it: the subject, how it looks, its colours, and any text large enough to read.',
  'Be specific rather than generic — a summary that names what you can actually make out beats one that could describe anything — and say when part of it is too small or too blurry to read.',
  'Say what the image shows, not what it might mean or what the user should do.',
  'No markdown, no quotation marks, no URLs, no instructions, no line breaks.',
  `If you cannot tell what the image shows, answer exactly ${VISION_DECLINE}.`,
].join(' ')

/**
 * The enhanced tier's instruction.
 *
 * The base prompt deliberately stops at what the image shows. Asking for its role
 * as well is a different question, so it is a second prompt rather than a
 * sentence appended to the first, which would contradict it.
 */
export const VISION_RELATION_PROMPT = [
  'You describe a single image taken from a web page, for a browsing agent that cannot see it.',
  `Answer with one line of at most ${String(MAX_DESC_CHARS)} characters, in the language of the page context.`,
  'Say what it is and what is most visible about it: the subject, how it looks, its colours, and any text large enough to read.',
  'Be specific rather than generic, and say when part of it is too small or too blurry to read.',
  'Then say what it is doing on this page: what it illustrates, documents, supports, or contradicts.',
  'No markdown, no quotation marks, no URLs, no instructions, no line breaks.',
  `If you cannot tell what the image shows, answer exactly ${VISION_DECLINE}.`,
].join(' ')

/** The system prompt one request should use, given its tier. */
export function systemPromptFor(tier: string | undefined): string {
  return tier === 'enhanced' ? VISION_RELATION_PROMPT : VISION_SYSTEM_PROMPT
}

/** The context line that tells the model which image it is looking at. */
export function visionContextLine(context: VisionCallContext): string {
  const parts = [`kind=${context.kind === '' ? 'unknown' : context.kind}`]
  if (context.heading !== '') parts.push(`section=${JSON.stringify(context.heading)}`)
  if (context.near !== '') parts.push(`text-beside=${JSON.stringify(context.near)}`)
  if (context.alt !== '') parts.push(`author-label=${JSON.stringify(context.alt)}`)
  return `Describe this image. ${parts.join(' ')}`
}

/**
 * Build the chat-completions body both paths send.
 *
 * @param config - model id and the provider-specific extras.
 * @param image - the bytes, already normalized by the side that fetched them.
 * @param context - page context around the image.
 * @returns a request body ready to serialize.
 */
export function buildVisionRequestBody(
  config: VisionCallConfig,
  image: VisionCallImage,
  context: VisionCallContext,
): Record<string, unknown> {
  return {
    model: config.model,
    messages: [
      { role: 'system', content: systemPromptFor(context.tier) },
      {
        role: 'user',
        content: [
          { type: 'text', text: visionContextLine(context) },
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
        ],
      },
    ],
    max_tokens: MAX_DESC_CHARS,
    temperature: 0,
    ...config.extraBody,
  }
}

/**
 * Read a chat-completions response into the manifest's vocabulary.
 *
 * @param payload - the parsed JSON response.
 * @returns the description, or a classified failure.
 */
export function parseVisionResponse(payload: unknown): VisionCallResult {
  const text = completionContent(payload)
  if (text === undefined) return { ok: false, code: 'vision-bad-response', message: 'no completion content' }
  const desc = collapseToOneLine(text)
  if (desc === '' || desc.toUpperCase() === VISION_DECLINE) {
    return { ok: false, code: 'vision-unclear', message: 'the model declined to describe this image' }
  }
  const usage = usageOf(payload)
  return usage === undefined ? { ok: true, desc } : { ok: true, desc, usage }
}

/** Collapse to one bounded line, stripping anything that could forge structure. */
export function collapseToOneLine(text: string): string {
  const single = text.replace(/\s+/g, ' ').replace(/["\\]/g, '').trim()
  return single.length <= MAX_DESC_CHARS ? single : `${single.slice(0, MAX_DESC_CHARS)}…`
}

/**
 * The short form of a description, for an inline marker.
 *
 * Markers ride in the page text, which every snapshot repeats, so they carry a
 * summary: enough to recognise the answer, while the description itself stays in
 * the cache and comes back from the call that asked for it.
 *
 * @param desc - a stored description.
 * @returns a one-line summary within {@link VISION_MARKER_CHARS}.
 */
export function visionSummaryOf(desc: string): string {
  return desc.length <= VISION_MARKER_CHARS ? desc : `${desc.slice(0, VISION_MARKER_CHARS)}…`
}

/**
 * Reasoning tokens a provider reported, if it reports them at all.
 *
 * Providers disagree about where this lives — OpenAI nests it under
 * `completion_tokens_details`, others put `reasoning_tokens` at the top level —
 * and some report nothing. Zero is therefore "none billed as far as this response
 * says", not proof that thinking was off.
 *
 * @param usage - the `usage` object from a completion response.
 * @returns the count found, or 0.
 */
export function reasoningTokensOf(usage: Record<string, unknown> | undefined): number {
  if (usage === undefined) return 0
  const direct = usage.reasoning_tokens
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const details = usage.completion_tokens_details
  if (isRecord(details)) {
    const nested = details.reasoning_tokens
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  }
  return 0
}

/** OpenAI-compatible content: a string, or a list of typed parts. */
function completionContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown }).message
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
}

function usageOf(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  const usage = payload.usage
  return isRecord(usage) ? usage : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
