// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedImageIdentities, rememberImageIdentities } from '../src/background/tools.ts'

/**
 * The background's memory of what each image number pointed at.
 *
 * It exists so a describe call that arrives after the page re-rendered can still
 * name the picture. The rules worth pinning are the ones a wrong map would break
 * silently: frames are separate namespaces, and one long-lived frame must not
 * grow a number per image forever.
 */
describe('remembered image identities', () => {
  beforeEach(() => {
    rememberedImageIdentities.clear()
  })

  it('remembers what a number pointed at', () => {
    rememberImageIdentities(7, 0, [{ index: 3, identity: 'https://example.com/a.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(3)).toBe('https://example.com/a.png')
  })

  it('keeps the same number in two frames apart', () => {
    // Element indices are a per-frame namespace, so a tab-wide map would hand one
    // frame's address to the other.
    rememberImageIdentities(7, 0, [{ index: 3, identity: 'https://example.com/a.png' }])
    rememberImageIdentities(7, 4, [{ index: 3, identity: 'https://example.com/b.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(3)).toBe('https://example.com/a.png')
    expect(rememberedImageIdentities.get('7:4')?.get(3)).toBe('https://example.com/b.png')
  })

  it('keeps the same number in two tabs apart', () => {
    rememberImageIdentities(7, 0, [{ index: 1, identity: 'https://example.com/a.png' }])
    rememberImageIdentities(8, 0, [{ index: 1, identity: 'https://example.com/b.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(1)).toBe('https://example.com/a.png')
    expect(rememberedImageIdentities.get('8:0')?.get(1)).toBe('https://example.com/b.png')
  })

  it('learns nothing from a snapshot that numbered no images', () => {
    rememberImageIdentities(9, 0, [])
    expect(rememberedImageIdentities.has('9:0')).toBe(false)
  })

  it('stays bounded on a frame that has numbered thousands of images', () => {
    for (let index = 0; index < 700; index += 1) {
      rememberImageIdentities(11, 0, [{ index, identity: `https://example.com/${String(index)}.png` }])
    }
    const byNumber = rememberedImageIdentities.get('11:0')!
    expect(byNumber.size).toBeLessThanOrEqual(500)
    // The newest is what a live page is about to be asked about; the oldest goes.
    expect(byNumber.get(699)).toBe('https://example.com/699.png')
    expect(byNumber.has(0)).toBe(false)
  })

  it('bounds how many frames it remembers, since closed tabs never report back', () => {
    // The bound on one frame's numbers says nothing about the number of frames:
    // every tab and iframe ever snapshotted adds a key that nothing removes.
    for (let tab = 1; tab <= 200; tab += 1) {
      rememberImageIdentities(tab, 0, [{ index: 0, identity: `https://example.com/${String(tab)}.png` }])
    }
    expect(rememberedImageIdentities.size).toBe(64)
    expect(rememberedImageIdentities.has('200:0')).toBe(true)
    expect(rememberedImageIdentities.has('1:0')).toBe(false)
  })

  it('drops the frame that went longest without a snapshot, not the one opened first', () => {
    // A long-lived tab that keeps being snapshotted is exactly the one a describe
    // call is about to reference, so it must survive a flood of newer frames.
    rememberImageIdentities(1, 0, [{ index: 0, identity: 'https://example.com/keep.png' }])
    for (let tab = 2; tab <= 200; tab += 1) {
      rememberImageIdentities(tab, 0, [{ index: 0, identity: `https://example.com/${String(tab)}.png` }])
      rememberImageIdentities(1, 0, [{ index: 0, identity: 'https://example.com/keep.png' }])
    }
    expect(rememberedImageIdentities.size).toBeLessThanOrEqual(64)
    expect(rememberedImageIdentities.get('1:0')?.get(0)).toBe('https://example.com/keep.png')
  })
})
