// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 12, maxForms: 5, maxChars: 6_000 }

/** Populate the id registry the way a snapshot would, then resolve one image. */
async function resolveImage(html: string): Promise<ReturnType<typeof runAction>> {
  document.body.innerHTML = html
  const ids = new ElementIds()
  buildSnapshot(ids, { budget: BUDGET }, null)
  const image = document.querySelector('img, svg, video')!
  const index = ids.indexOf(image)
  if (index === undefined) throw new Error('the fixture image was not inventoried')
  return await runAction('browser_describe_image', { index }, { ids, budget: BUDGET })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('browser_describe_image', () => {
  it('uses the same identity the snapshot reported, or the cache never hits', async () => {
    // The two sides compute this independently: the snapshot renders it into the
    // identity map, the describe action asks with it. A drift here is invisible —
    // the marker simply keeps saying "not-requested" — so it is asserted.
    document.body.innerHTML = `
      <h2>本季度营收</h2>
      <img id="chart" src="data:image/png;base64,${'A'.repeat(40)}" alt="季度营收" style="width:64px;height:64px">
    `
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const reported = view.images[0]?.identity
    expect(reported).toBeDefined()

    const index = ids.indexOf(document.getElementById('chart')!)!
    const result = await runAction('browser_describe_image', { index }, { ids, budget: BUDGET })
    expect(result.image?.identity).toBe(reported)
  })

  it('resolves an image to its identity and page context', async () => {
    const result = await resolveImage(`
      <h2>本季度营收</h2>
      <figure><img src="/chart.png" alt="季度营收"><figcaption>营收趋势</figcaption></figure>
    `)
    expect(result.image).toEqual({
      identity: 'http://localhost:3000/chart.png',
      alt: '季度营收',
      near: '营收趋势',
      heading: '本季度营收',
      kind: 'content',
      src: 'http://localhost:3000/chart.png',
    })
    expect(result.text).toContain('Image')
  })

  it('names an image that is itself the click target of a link', async () => {
    // The page's own structure says what kind of image this is, and that changes
    // how the answer should be read.
    const result = await resolveImage('<a href="/offer"><img src="/banner.png" alt="促销"></a>')
    expect(result.image?.kind).toBe('link')
  })

  it('falls back to the element index for an image with no address', async () => {
    const result = await resolveImage('<svg width="100" height="60"><circle r="10" /></svg>')
    expect(result.image?.src).toBe('')
    expect(result.image?.identity).toMatch(/^el:\d+$/)
  })

  it('reports an image whose label is missing rather than inventing one', async () => {
    const result = await resolveImage('<img src="/photo.jpg">')
    expect(result.image?.alt).toBe('')
    expect(result.image?.near).toBe('')
  })

  it('refuses an index that is not an image', async () => {
    document.body.innerHTML = '<button>提交</button><img src="/a.png">'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const button = ids.indexOf(document.querySelector('button')!)!
    await expect(runAction('browser_describe_image', { index: button }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('refuses a missing index before touching the page', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_describe_image', {}, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
  })

  it('refuses an index the page no longer has', async () => {
    document.body.innerHTML = '<img src="/a.png">'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    document.body.replaceChildren()
    await expect(runAction('browser_describe_image', { index: 999 }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('recovers the image by address after a re-render retires its index', async () => {
    // The registry is WeakMap-backed, so a re-render replaces the node the id
    // belonged to and the number the model remembers stops resolving. The picture
    // is still there, and the address the snapshot called its identity still
    // names it, so the call should survive the page repainting itself.
    document.body.innerHTML = '<img src="/chart.png" alt="图表" style="width:64px;height:64px">'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<section><img src="/chart.png" alt="图表" style="width:64px;height:64px"></section>'
    buildSnapshot(ids, { budget: BUDGET }, null)
    expect(ids.elementByIndex(staleIndex)).toBeUndefined()

    const result = await runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET })
    expect(result.image?.src).toBe('http://localhost:3000/chart.png')
    expect(result.text).toContain('recovered by address')
  })

  it('still prefers the live index over the remembered address', async () => {
    // The hint is a fallback, not an override: a number that resolves is honoured
    // even when the caller also passes an address that would match another image.
    document.body.innerHTML = '<img src="/a.png" style="width:64px"><img src="/b.png" style="width:64px">'
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const second = view.images[1]!

    const result = await runAction(
      'browser_describe_image',
      { index: second.index, identity: view.images[0]!.identity },
      { ids, budget: BUDGET },
    )
    expect(result.image?.src).toBe('http://localhost:3000/b.png')
    expect(result.text).not.toContain('recovered by address')
  })

  it('does not invent a recovery for an image that has no address', async () => {
    // An address-less image is identified by the number that went stale, so
    // "matching" it on that number would be guessing rather than recovering.
    document.body.innerHTML = '<svg width="100" height="60"><circle r="10" /></svg>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<div><svg width="100" height="60"><circle r="10" /></svg></div>'
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('names the numbers that still resolve when an index is gone', async () => {
    // Without the current numbers the only way forward is another full snapshot,
    // which is the cost an indexed path exists to avoid.
    document.body.innerHTML = `
      <img src="/a.png" style="width:64px;height:64px">
      <img src="/b.png" style="width:64px;height:64px">
    `
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const resolvable = ids.indexOf(document.querySelectorAll('img')[0]!)!

    await expect(runAction('browser_describe_image', { index: 999 }, { ids, budget: BUDGET }))
      .rejects.toThrow(new RegExp(`the page currently numbers images ${String(resolvable)}`))
  })

  it('says so plainly when the page numbers no images at all', async () => {
    document.body.innerHTML = '<button>提交</button>'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: 0 }, { ids, budget: BUDGET }))
      .rejects.toThrow(/the page currently numbers no images/)
  })

  it('refuses to recover when a remembered address matches more than one image', async () => {
    // A shared logo or placeholder appears on many tiles at once. Taking the first
    // match would attach that instance's alt/near/heading to an image whose answer
    // is not cached yet — a confident description of the wrong tile.
    const markup = `
      <figure><img src="/logo.png" alt="甲" style="width:64px;height:64px"><figcaption>第一处</figcaption></figure>
      <figure><img src="/logo.png" alt="乙" style="width:64px;height:64px"><figcaption>第二处</figcaption></figure>
    `
    document.body.innerHTML = markup
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = markup
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('recovers when a remembered address matches exactly one image', async () => {
    // The same re-render, but the address is unique: this is the case recovery is for.
    document.body.innerHTML = '<img src="/solo.png" alt="图" style="width:64px;height:64px">'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<section><img src="/solo.png" alt="图" style="width:64px;height:64px"></section>'
    buildSnapshot(ids, { budget: BUDGET }, null)

    const result = await runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET })
    expect(result.image?.src).toBe('http://localhost:3000/solo.png')
    expect(result.text).toContain('recovered by address')
  })
})
