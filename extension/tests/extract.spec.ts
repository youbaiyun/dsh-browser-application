// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { accessibleName, collectInteractive, isVisible, mainText, truncate } from '../src/content/extract.ts'

describe('truncate', () => {
  it('cuts over-budget text and reports the cut count', () => {
    expect(truncate('abc', 5)).toEqual({ text: 'abc', truncated: 0 })
    const result = truncate('abcdefgh', 4)
    expect(result.text).toBe('abcd…')
    expect(result.truncated).toBe(4)
  })
})

describe('isVisible', () => {
  it('treats display:none and visibility:hidden as hidden', () => {
    const hidden = document.createElement('button')
    hidden.style.display = 'none'
    document.body.appendChild(hidden)
    expect(isVisible(hidden)).toBe(false)

    const invisible = document.createElement('button')
    invisible.style.visibility = 'hidden'
    document.body.appendChild(invisible)
    expect(isVisible(invisible)).toBe(false)

    const visible = document.createElement('button')
    visible.textContent = 'ok'
    document.body.appendChild(visible)
    expect(isVisible(visible)).toBe(true)
  })
})

describe('accessibleName', () => {
  it('prefers aria-label over everything else', () => {
    const button = document.createElement('button')
    button.setAttribute('aria-label', '关闭')
    button.textContent = 'X'
    expect(accessibleName(button)).toBe('关闭')
  })

  it('resolves label[for] for inputs', () => {
    const input = document.createElement('input')
    input.id = 'email'
    const label = document.createElement('label')
    label.htmlFor = 'email'
    label.textContent = '邮箱地址'
    document.body.append(label, input)
    expect(accessibleName(input)).toBe('邮箱地址')
  })

  it('resolves a wrapping label for form controls', () => {
    document.body.innerHTML = '<label><input type="checkbox">邮件通知</label>'
    expect(accessibleName(document.querySelector('input')!)).toBe('邮件通知')
  })

  it('falls back to own text then tag name', () => {
    const button = document.createElement('button')
    button.textContent = '  提交  '
    expect(accessibleName(button)).toBe('提交')
    const span = document.createElement('span')
    expect(accessibleName(span)).toBe('span')
  })
})

describe('collectInteractive', () => {
  it('collects interactive elements in document order, skipping hidden ones', () => {
    document.body.innerHTML = `
      <a href="/a">A</a>
      <button style="display:none">Hidden</button>
      <input type="text" />
      <button>B</button>
    `
    const elements = collectInteractive(document)
    expect(elements.map((el) => el.tagName.toLowerCase())).toEqual(['a', 'input', 'button'])
  })
})

describe('mainText', () => {
  it('prefers article content over the rest of the page', () => {
    document.body.innerHTML = `
      <nav>导航垃圾文字重复重复重复</nav>
      <article><h1>标题</h1><p>第一段正文内容。</p><p>第二段正文内容。</p></article>
    `
    const text = mainText(document)
    expect(text).toContain('第一段正文内容')
    expect(text).not.toContain('导航垃圾')
  })

  it('falls back to body text without an article', () => {
    document.body.innerHTML = '<div>只有一段话的页面。</div>'
    expect(mainText(document)).toContain('只有一段话的页面')
  })

  it('keeps all article cards inside the main landmark', () => {
    document.body.innerHTML = `
      <nav>导航垃圾文字</nav>
      <main>
        <article>Delta 收纳盒</article>
        <article>Cedar 收纳盒</article>
      </main>
    `
    const text = mainText(document)
    expect(text).toContain('Delta 收纳盒')
    expect(text).toContain('Cedar 收纳盒')
    expect(text).not.toContain('导航垃圾')
  })
})
