import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/markdown.js'

describe('markdown-минимум', () => {
  it('абзацы, переносы, жирный, курсив, код', () => {
    expect(renderMarkdown('a\nb\n\n**c** *d* `e<f>`')).toBe('<p>a<br>b</p><p><strong>c</strong> <em>d</em> <code>e&lt;f&gt;</code></p>')
  })
  it('блок кода — экранирован, язык атрибутом', () => {
    expect(renderMarkdown('```ts\nconst a = <b>\n```')).toBe('<pre><code data-lang="ts">const a = &lt;b&gt;</code></pre>')
  })
  it('списки и заголовки', () => {
    expect(renderMarkdown('# T\n- a\n- b\n\n1. x\n2. y')).toBe('<h3>T</h3><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>')
  })
  it('ссылки: http(s) — да, javascript: — нет; голый URL', () => {
    expect(renderMarkdown('[ok](https://a.b/c?x=1&y=2)')).toBe('<p><a href="https://a.b/c?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">ok</a></p>')
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('<a')
    expect(renderMarkdown('см. https://x.y/z')).toContain('<a href="https://x.y/z"')
  })
  it('HTML не проходит', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })
})
