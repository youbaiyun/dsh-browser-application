// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compareDescription } from '../src/background/vision-compare.ts'

const EMPTY = { alt: '', near: '', heading: '' }

describe('compareDescription', () => {
  it('notes a description about a different subject without calling it a conflict', () => {
    const result = compareDescription('一只猫趴在草地上', {
      alt: '季度营收',
      near: '营收趋势',
      heading: '财务',
    })
    // Word overlap can show the description did not repeat the page's words. It
    // cannot show the two disagree, and a conflict here would cry wolf.
    expect(result.verdict).toBe('uncertain')
    expect(result.basis).toBe('text')
    expect(result.conflicts).toEqual([])
    expect(result.note).toContain('does not mention')
    expect(result.overlap).toBe(0)
  })

  it('does not call a short description of a long marketing title a conflict', () => {
    // A real pair: the page titles this image 微缩创意五口之家三孩三胎家庭过积木桥
    // and the description reads 五个微缩人偶站在绿色积木拱桥上. They agree — five
    // people, a block bridge — while most of the title is copy no honest
    // 120-character description would repeat. This was reported to the user as a
    // CONFLICT, which is exactly the false alarm that teaches people to ignore it.
    const result = compareDescription('五个微缩人偶站在绿色积木拱桥上', {
      alt: '微缩创意五口之家三孩三胎家庭过积木桥',
    })
    expect(result.verdict).not.toBe('conflict')
    expect(result.conflicts).toEqual([])
  })

  it('accepts a description that covers what the page says', () => {
    const result = compareDescription('季度营收趋势图，包含财务数据', {
      alt: '季度营收',
      near: '营收趋势',
      heading: '财务',
    })
    expect(result.verdict).toBe('consistent')
    expect(result.conflicts).toEqual([])
    expect(result.overlap).toBeGreaterThanOrEqual(0.45)
  })

  it('stays uncertain when the answer only partly matches', () => {
    const result = compareDescription('这里有一些营收数据', {
      alt: '季度营收',
      heading: '财务',
    })
    expect(result.verdict).toBe('uncertain')
    expect(result.conflicts).toEqual([])
    expect(result.overlap).toBeGreaterThanOrEqual(0.2)
    expect(result.overlap).toBeLessThan(0.45)
  })

  it('reports that nothing was checked when the page says nothing about the image', () => {
    // The honest case: no author text, no caption, no heading. Returning
    // "consistent" here would claim a verification that never ran.
    const result = compareDescription('一台笔记本电脑', EMPTY)
    expect(result).toEqual({ verdict: 'uncertain', conflicts: [], basis: 'none', overlap: 0 })
  })

  it('ignores words too common to carry subject matter', () => {
    const result = compareDescription('一张图片', { alt: '图片', near: '截图', heading: '' })
    expect(result.basis).toBe('none')
  })

  it('flags a percentage that contradicts the one tied to the image', () => {
    const result = compareDescription('销售额达到 50%', {
      alt: '本月销售额上涨 30%',
      near: '',
      heading: '',
    })
    expect(result.verdict).toBe('conflict')
    expect(result.conflicts).toEqual([
      { rule: 'percentage', detail: 'description says 50% but the page states 30%' },
    ])
  })

  it('accepts a percentage within tolerance', () => {
    const result = compareDescription('销售额达到 50%', {
      alt: '本月销售额上涨 52%',
      near: '',
      heading: '',
    })
    expect(result.conflicts).toEqual([])
  })

  it('falls back to page numbers only when the image has none of its own', () => {
    const contested = compareDescription('完成度 80%', EMPTY, '页面其他位置写着完成度 20%')
    expect(contested.conflicts[0]?.rule).toBe('percentage')
    // With a number tied to the image, the page at large is not consulted: a page
    // full of percentages would otherwise contradict almost any answer.
    const scoped = compareDescription('完成度 80%', { ...EMPTY, alt: '完成度 78%' }, '别处写着 20%')
    expect(scoped.conflicts).toEqual([])
  })

  it('matches CJK text through adjacent-character pairs', () => {
    const result = compareDescription('这张图展示的是商品主图与价格', {
      alt: '商品主图',
      near: '价格',
      heading: '',
    })
    expect(result.verdict).toBe('consistent')
  })
})
