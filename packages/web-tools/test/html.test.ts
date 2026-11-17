/** html → text на трёх фикстурах (статья, доки, SPA-заглушка) и обрезка (спека §3). */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { decodeEntities, htmlToText, inlineText, truncate } from '../src/html.js'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')

describe('htmlToText: статья', () => {
  const page = htmlToText(fixture('article.html'))

  it('title — из <title>, сущности декодированы', () => {
    expect(page.title).toBe('Why Result Types Beat Exceptions — Example Blog')
  })

  it('берёт <article>: обвязки (nav, aside, footer, header) нет', () => {
    expect(page.text.startsWith('# Why Result Types Beat Exceptions')).toBe(true)
    expect(page.text).not.toContain('Archive')
    expect(page.text).not.toContain('Related posts')
    expect(page.text).not.toContain('All rights reserved')
    expect(page.text).not.toContain('dataLayer')
    expect(page.text).not.toContain('tracking pixel')
  })

  it('строчные теги не рвут слова, сущности декодированы', () => {
    expect(page.text).toContain("Exceptions are invisible in a function's signature. A Result makes the failure path part of the type.")
    expect(page.text).toContain('Consider the classic example:')
    expect(page.text).toContain('Version 2 of the library shipped in 2026 & fixed 14 bugs.')
  })

  it('<pre> сохраняет переносы и отступы', () => {
    expect(page.text).toContain(
      'function parse(s: string): Result<number> {\n  const n = Number(s)\n  return Number.isNaN(n) ? err(new Error(\'NaN\')) : ok(n)\n}',
    )
  })

  it('заголовки и пункты списка размечены, пустых строк не больше одной подряд', () => {
    expect(page.text).toContain('## Trade-offs')
    expect(page.text).toContain('- Explicit error handling\n- More verbose call sites')
    expect(page.text).not.toMatch(/\n{3,}/)
  })
})

describe('htmlToText: доки', () => {
  const page = htmlToText(fixture('docs.html'))

  it('берёт <main>, сайдбар и футер отрезаны', () => {
    expect(page.title).toBe('fetchTransport | nr-web docs')
    expect(page.text.startsWith('# fetchTransport')).toBe(true)
    expect(page.text).not.toContain('Install')
    expect(page.text).not.toContain('static site generator')
  })

  it('таблица — строками, ячейки через пробел', () => {
    expect(page.text).toContain('Name Type Default')
    expect(page.text).toContain('timeoutMs number none')
  })

  it('ссылка внутри текста не рвёт предложение; пустой заголовок не оставляет «##»', () => {
    expect(page.text).toContain('Bare HTTP delivery over globalThis.fetch.')
    expect(page.text).toContain('Note: errors are returned, never thrown.')
    expect(page.text).toContain('См. также: описание на русском.')
    expect(page.text.split('\n')).not.toContain('##')
  })
})

describe('htmlToText: SPA-заглушка', () => {
  const page = htmlToText(fixture('spa.html'))

  it('текста почти нет — остаётся noscript, скриптов нет', () => {
    expect(page.title).toBe('Dashboard')
    expect(page.text).toBe('You need to enable JavaScript to run this app.')
  })
})

describe('htmlToText: края', () => {
  it('без <title> — без title; незакрытый <script> срезается до конца', () => {
    const page = htmlToText('<p>до</p><script>var x = "<p>после</p>"')
    expect(page).toEqual({ text: 'до' })
  })

  it('метки <pre> не путаются с числами в тексте', () => {
    const page = htmlToText('<p>0 1 2</p><pre>code</pre><p>3</p>')
    expect(page.text).toBe('0 1 2\n\ncode\n\n3')
  })

  it('переносы исходника — пробелы; div даёт перенос, p — абзац, <title> вне head не течёт в текст', () => {
    const page = htmlToText('<title>T</title><div>a\n  b</div><div>c</div><p>d</p>')
    expect(page).toEqual({ title: 'T', text: 'a b\nc\n\nd' })
  })
})

describe('decodeEntities / inlineText', () => {
  it('числовые, hex и именованные; незнакомая остаётся', () => {
    expect(decodeEntities('&#39;&#x27;&quot;&amp;&lt;&unknown;')).toBe(`''"&<&unknown;`)
  })

  it('inlineText схлопывает пробелы и срезает теги', () => {
    expect(inlineText('  <b>Type</b>Script\n  <i>rocks</i> ')).toBe('TypeScript rocks')
  })
})

describe('truncate', () => {
  it('короче лимита — как есть', () => {
    expect(truncate('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })

  it('длиннее — обрезано и помечено', () => {
    expect(truncate('abcdef', 4)).toEqual({ text: 'abcd', truncated: true })
  })

  it('суррогатная пара на границе не рвётся', () => {
    const out = truncate('ab😀cd', 3)
    expect(out).toEqual({ text: 'ab', truncated: true })
  })
})
