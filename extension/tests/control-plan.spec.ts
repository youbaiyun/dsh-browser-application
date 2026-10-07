// @vitest-environment jsdom

/**
 * The task list the panel shows for a turn.
 *
 * Two behaviours matter and both are easy to get wrong: which version of the
 * checklist wins while the model is still streaming it, and that the list the
 * user reads matches the checklist the model wrote.
 */

import { describe, expect, it } from 'vitest'
import { parsePlan } from '@dsh-browser/protocol'

import { preferPlan } from '../control/main.ts'

const plan = (text: string) => parsePlan(text)

describe('preferPlan', () => {
  it('keeps the longer list while a shorter re-emission streams in', () => {
    // The model rewrites the whole checklist; the first frames of that rewrite
    // carry only its opening lines. "Newest wins" would visibly truncate the list
    // on every progress update.
    const complete = plan('- [ ] one\n- [ ] two\n- [ ] three')
    const partial = plan('- [ ] one')
    expect(preferPlan(complete, partial)?.tasks).toHaveLength(3)
    expect(preferPlan(partial, complete)?.tasks).toHaveLength(3)
  })

  it('takes the newer copy when both are the same length, because it carries progress', () => {
    const before = plan('- [ ] one\n- [ ] two')
    const after = plan('- [x] one\n- [>] two')
    const chosen = preferPlan(before, after)
    expect(chosen?.tasks.map((task) => task.status)).toEqual(['done', 'active'])
    // …and never regresses a finished task back to pending.
    expect(preferPlan(after, before)?.tasks.map((task) => task.status)).toEqual(['done', 'active'])
  })

  it('ignores a message with no checklist and survives having nothing yet', () => {
    const only = plan('- [ ] one\n- [ ] two')
    expect(preferPlan(only, null)).toBe(only)
    expect(preferPlan(null, null)).toBeNull()
    expect(preferPlan(only, plan('just prose'))).toBe(only)
  })
})
