/**
 * Local cross-modal check: does the page's own text agree with what the model
 * says the image shows?
 *
 * The model never sees this comparison and cannot influence it, which is the
 * whole point. A vision model asked "what is this?" answers fluently whether or
 * not it read the image, and its language prior can override weak visual
 * evidence; the page's text is independent testimony that costs nothing to
 * consult. Where the two disagree, the answer is suspect and must not drive an
 * action.
 *
 * What this can and cannot catch:
 *
 * - It *proves* a conflict in one case: a percentage that contradicts a percentage
 *   the page states, because a number carries its own unit and the two either agree
 *   or one of them is wrong.
 * - It *flags*, but does not prove, topical distance: a description that mentions
 *   none of what the page says about the image. That is reported as `uncertain`
 *   with a note, never as a conflict. Word overlap cannot tell "the description
 *   disagrees" from "the description is short and the title is marketing copy" —
 *   a title like "微缩创意五口之家三孩三胎家庭过积木桥" is mostly words no honest
 *   120-character description would repeat, while "五个人偶站在积木拱桥上" agrees
 *   with it. Calling that a conflict cries wolf, and a warning that fires on
 *   agreement is a warning that gets ignored when it matters.
 * - It cannot catch a plausible-but-wrong answer that happens to agree with the
 *   page's words, and it says nothing at all about images the page does not
 *   describe. Those stay `uncertain`, which the caller must treat as "ask the
 *   user", never as "fine".
 *
 * Thresholds are starting values, not calibrated ones: they need real
 * description/page pairs to tune, and the counts reported here are what that
 * tuning would consume.
 *
 * @module
 */

/** What the page said about the image, before the model was asked. */
export interface CompareContext {
  /**
   * Author-provided text (`alt`, `aria-label`, `title`).
   *
   * Every field is optional because a page only sometimes supplies each one: an
   * image with no caption and no heading is ordinary, and a caller assembling
   * this from the DOM should not have to invent empty strings to satisfy a type.
   */
  alt?: string | undefined
  /** Text printed beside the image. */
  near?: string | undefined
  /** Nearest heading: the section the image belongs to. */
  heading?: string | undefined
}

/** One disagreement between the page's text and the description. */
export interface CompareConflict {
  rule: 'percentage' | 'theme'
  detail: string
}

/** The comparison's outcome, and how much it had to go on. */
export interface CompareResult {
  /** `conflict` forbids automatic execution; `uncertain` asks the user. */
  verdict: 'consistent' | 'uncertain' | 'conflict'
  conflicts: CompareConflict[]
  /**
   * Set when the description mentions little of what the page says about the
   * image.
   *
   * A note, not a conflict: it records topical distance, which is evidence of a
   * possible problem, not proof of one.
   */
  note?: string
  /**
   * `none` means the page said nothing about this image, so nothing was checked;
   * `skipped` means the chosen tier does not check at all. Both are reported
   * rather than being folded into `consistent`, which would claim a verification
   * that never ran.
   */
  basis: 'text' | 'none' | 'skipped'
  /** Share of the page's significant tokens that appear in the description. */
  overlap: number
}

/** Containment below this means the description mentions little of the page's text. */
const MENTIONS_BELOW = 0.2

/** Containment at or above this reads as agreement. */
const CONSISTENT_AT = 0.45

/** Relative difference at which two percentages contradict each other. */
const PERCENT_TOLERANCE = 0.1

/** Words too common to carry subject matter in either direction. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have',
  'image', 'photo', 'picture', 'screenshot', 'chart', 'graph', 'icon', 'logo', 'background',
  '图片', '图像', '照片', '截图', '图标', '背景', '一个', '这个', '那个', '以及', '显示', '上面',
])

/** Latin words and CJK bigrams: cheap, dependency-free, language-agnostic enough. */
function tokensOf(text: string | undefined): Set<string> {
  const tokens = new Set<string>()
  if (text === undefined || text === '') return tokens
  const lowered = text.toLowerCase()
  for (const word of lowered.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    tokens.add(word)
  }
  // CJK has no spaces, so single characters are too common and whole runs are
  // too specific; adjacent pairs are the usual compromise.
  const cjk = lowered.replace(/[^\u3400-\u9fff]+/gu, ' ')
  for (const run of cjk.split(/\s+/)) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOP_WORDS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

/** Percentage values, as numbers, in the order they appear. */
function percentagesOf(text: string | undefined): number[] {
  const found: number[] = []
  if (text === undefined || text === '') return found
  const pattern = /(\d+(?:\.\d+)?)\s*(?:%|％|percent)/gi
  let match = pattern.exec(text)
  while (match !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value)) found.push(value)
    match = pattern.exec(text)
  }
  return found
}

/**
 * Compare a description against the page's own text.
 *
 * @param desc - the model's one-line description.
 * @param context - author text, nearby text and heading for this image.
 * @param pageText - the page's visible text, for numbers stated elsewhere.
 * @returns the verdict, the conflicts found, and the overlap that produced them.
 */
export function compareDescription(
  desc: string,
  context: CompareContext,
  pageText = '',
): CompareResult {
  const conflicts: CompareConflict[] = []
  const description = tokensOf(desc)
  const own = [...tokensOf(context.alt), ...tokensOf(context.near), ...tokensOf(context.heading)]

  // The description loop: how much of what the page said about this image the
  // answer actually mentions. Containment in this direction, not Jaccard: a
  // verbose answer that covers the caption is fine, while an answer about
  // something else shares nothing.
  let overlap = 0
  let note: string | undefined
  if (own.length > 0) {
    const hits = own.filter((token) => description.has(token)).length
    overlap = hits / own.length
    if (overlap < MENTIONS_BELOW) {
      const missing = own.filter((token) => !description.has(token)).slice(0, 4).join(', ')
      note = `the description does not mention what the page says about this image (${missing})`
    }
  }

  // A percentage the page states is a comparable quantity, because it carries
  // its unit: the answer's percentage either agrees with it or one of the two is
  // wrong.
  //
  // The image's own text is consulted first and the page at large only as a
  // fallback. A page-wide scan is what the design calls for, but a page full of
  // percentages (a dashboard, a price list) will contradict almost any answer by
  // coincidence, and a conflict here costs a user confirmation. Reading the
  // caption first keeps the signal attached to the number the author tied to
  // this image.
  const described = percentagesOf(desc)
  const ownPercentages = percentagesOf([context.alt, context.near, context.heading]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' '))
  const stated = ownPercentages.length > 0 ? ownPercentages : percentagesOf(pageText)
  if (described.length > 0 && stated.length > 0) {
    for (const value of described) {
      const nearest = stated.reduce(
        (best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
        stated[0] ?? value,
      )
      const scale = Math.max(Math.abs(value), Math.abs(nearest), 1)
      if (Math.abs(nearest - value) / scale > PERCENT_TOLERANCE) {
        conflicts.push({
          rule: 'percentage',
          detail: `description says ${String(value)}% but the page states ${String(nearest)}%`,
        })
      }
    }
  }

  // Only a stated number can prove a disagreement; everything else is a note.
  if (conflicts.length > 0) return { verdict: 'conflict', conflicts, basis: 'text', overlap }
  if (own.length === 0) {
    // Nothing in the DOM describes this image, so there was nothing to check.
    // Reporting `consistent` would claim a verification that never happened.
    return { verdict: 'uncertain', conflicts: [], basis: 'none', overlap: 0 }
  }
  return {
    verdict: overlap >= CONSISTENT_AT ? 'consistent' : 'uncertain',
    conflicts: [],
    basis: 'text',
    overlap,
    ...note === undefined ? {} : { note },
  }
}
