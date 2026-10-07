/**
 * The task list a turn is working through.
 *
 * The model is asked to open a turn by writing the checklist it is about to
 * execute, and to re-emit it with boxes ticked as it goes. That gives the person
 * watching three things a tool log cannot: what the *whole* job is, which part is
 * being done right now, and whether the job finished.
 *
 * The format is a plain markdown checklist, which is the one shape a model
 * produces reliably and a reader recognises instantly:
 *
 * ```text
 * - [ ] List the tabs that are open
 * - [>] Open bilibili in a new tab
 * - [x] Read the page
 * - [!] Download the video (failed: needs a login)
 * ```
 *
 * Parsing is deliberately forgiving: the boxes are the contract, everything
 * around them (a heading, bullets, numbering, an intro sentence) is tolerated.
 * This module is pure so the contract can be pinned by test rather than by
 * hoping the model complies.
 *
 * @module
 */

/** Where one task stands. */
export type PlanTaskStatus = 'pending' | 'active' | 'done' | 'failed'

/** One line of the checklist. */
export interface PlanTask {
  /** Stable within a plan: assigned by position, so a re-emitted list matches up. */
  id: number
  /** The task as the model wrote it, with the box removed. */
  text: string
  status: PlanTaskStatus
}

/** A whole checklist, plus what it was derived from. */
export interface Plan {
  tasks: PlanTask[]
  /** Whether every task reached a terminal state. */
  complete: boolean
  /** The task in progress, when exactly one is marked `active`. */
  activeId: number | null
}

const BOX = /^\s*(?:[-*+]|\d+[.)])?\s*\[([ xX>!])\]\s*(.+?)\s*$/u
const LABELLED = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u

/** Status for one box character. */
function statusOf(box: string): PlanTaskStatus {
  switch (box) {
    case ' ':
      return 'pending'
    case '>':
      return 'active'
    case '!':
      return 'failed'
    default:
      return 'done'
  }
}

/**
 * Read the checklist out of one assistant message.
 *
 * Two shapes count, in order of trust:
 *
 * 1. **Boxed items** — `- [ ]`, `- [x]`, `- [>]`, `- [!]`. The model states both
 *    the task and its state, so a progress update is just the list written again.
 * 2. **A bare list with no boxes at all** — numbers or bullets under a heading
 *    that mentions a plan or tasks. Every item is pending. This exists because a
 *    model that lists its plan without boxes should still produce a visible task
 *    list rather than nothing.
 *
 * @param text - the assistant text for one message.
 * @returns the plan, or null when the text carries no checklist.
 */
export function parsePlan(text: string): Plan | null {
  const lines = text.split('\n')
  const tasks: PlanTask[] = []
  let sawBox = false
  for (const line of lines) {
    const boxed = BOX.exec(line)
    if (boxed !== null) {
      const [, box, body] = boxed
      // A checkbox is a real task, but a nested sub-list of checkboxes is a
      // question, not a plan — one level keeps the list readable.
      const task = (body ?? '').trim()
      if (task !== '') {
        sawBox = true
        tasks.push({ id: tasks.length, text: task, status: statusOf(box ?? ' ') })
      }
    }
  }

  if (!sawBox) {
    const loose = looseList(lines)
    if (loose === null) return null
    tasks.push(...loose.map((task, index) => ({ id: index, text: task, status: 'pending' as const })))
  }

  if (tasks.length === 0) return null
  const active = tasks.filter((task) => task.status === 'active')
  return {
    tasks,
    complete: tasks.every((task) => task.status === 'done' || task.status === 'failed'),
    activeId: active.length === 1 ? active[0]!.id : null,
  }
}

/**
 * A plan written without boxes.
 *
 * Only accepted under a heading that announces a plan or a task list, so an
 * ordinary bulleted answer is not mistaken for one.
 */
function looseList(lines: readonly string[]): string[] | null {
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s|\*\*.+\*\*\s*$/u.test(line))
  if (headingIndex === -1) return null
  const headings = lines.slice(0, headingIndex + 1).join(' ')
  if (!/计划|任务|步骤|清单|plan|task|step|checklist/iu.test(headings)) return null
  const items: string[] = []
  for (const line of lines.slice(headingIndex + 1)) {
    const labelled = LABELLED.exec(line)
    if (labelled !== null) {
      const body = (labelled[1] ?? '').trim()
      if (body !== '') items.push(body)
      continue
    }
    // The list ends at the first line that is not part of it, so prose after the
    // plan is not swallowed into the task list.
    if (line.trim() === '') continue
    if (items.length > 0) break
  }
  return items.length >= 2 ? items : null
}

/**
 * Render a plan back into the checklist text.
 *
 * Used to show the list in the panel and, in tests, to prove that a plan survives
 * a round trip. Ticks are `x`, a failure `!`, and the task in progress `>`.
 *
 * @param plan - the plan to render.
 * @returns markdown lines, one per task.
 */
export function renderPlan(plan: Plan): string {
  return plan.tasks
    .map((task) => `- [${task.status === 'done' ? 'x' : task.status === 'failed' ? '!' : task.status === 'active' ? '>' : ' '}] ${task.text}`)
    .join('\n')
}

/**
 * How many tasks are in each state, for a one-line progress summary.
 *
 * @param plan - the plan to count.
 * @returns per-status totals plus how many tasks exist.
 */
export function planProgress(plan: Plan): { done: number; failed: number; active: number; pending: number; total: number } {
  const count = (status: PlanTaskStatus): number => plan.tasks.filter((task) => task.status === status).length
  return {
    done: count('done'),
    failed: count('failed'),
    active: count('active'),
    pending: count('pending'),
    total: plan.tasks.length,
  }
}
