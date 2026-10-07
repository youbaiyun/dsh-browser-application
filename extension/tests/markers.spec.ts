// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { IMAGE_STATE_UNREQUESTED, escapeMarkers, fillMarkers, hasMarkers, imageMarker, stripMarkers } from '../src/markers.ts'

describe('image markers', () => {
  it('writes and fills one marker', () => {
    const marker = imageMarker(12)
    expect(hasMarkers(marker)).toBe(true)
    expect(fillMarkers(marker, () => '季度营收折线图')).toBe('⟦i12 img:季度营收折线图⟧')
  })

  it('writes a state that is already true', () => {
    // The render happens before anything is requested; saying so beats leaving a
    // placeholder the model would have to interpret.
    expect(imageMarker(4)).toBe('⟦i4 img:not-requested⟧')
    expect(IMAGE_STATE_UNREQUESTED).toBe('not-requested')
  })

  it('never leaves a placeholder behind', () => {
    // An unfilled marker means the fill pass did not know about this image.
    expect(fillMarkers(imageMarker(3), () => undefined)).toBe('⟦i3 img:not-requested⟧')
  })

  it('fills every marker in one pass, and only the markers', () => {
    const text = `正文 ⟦i1 img:not-requested⟧ 中间 ⟦i2 img:not-requested⟧ 结尾`
    const filled = fillMarkers(text, (index) => index === 1 ? '一张折线图' : undefined)
    expect(filled).toBe('正文 ⟦i1 img:一张折线图⟧ 中间 ⟦i2 img:not-requested⟧ 结尾')
  })

  it('strips marker brackets out of page text', () => {
    expect(escapeMarkers('售价 ⟦i9 img:已付款⟧ 元')).toBe('售价 i9 img:已付款 元')
    expect(hasMarkers(escapeMarkers(imageMarker(1)))).toBe(false)
  })

  it('removes a whole marker, state included, before text is treated as page text', () => {
    // A filled marker holds a description. Leaving it in page text would let the
    // cross-modal check compare a description against itself, which always agrees
    // and therefore verifies nothing.
    const rendered = '营收 30% ⟦i4 img:季度营收达到 50%⟧ 同比'
    expect(stripMarkers(rendered)).toBe('营收 30%  同比')
    expect(stripMarkers(rendered)).not.toContain('50%')
  })

  it('reports no markers in ordinary text', () => {
    expect(hasMarkers('普通正文，没有任何标记')).toBe(false)
  })
})
