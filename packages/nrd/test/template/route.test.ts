import { describe, it, expect, afterEach } from 'vitest'
import { resolveRoute, registerSite, registeredSites } from '../../src/template/index.js'
import { exampleSite } from './example-site.js'

describe('resolveRoute — site-плагин', () => {
  const sites = [exampleSite]

  it('shorthand alice/first-page → template + params', () => {
    const r = resolveRoute('alice/first-page', sites)
    expect(r).not.toBeNull()
    expect(r!.template).toBe('example/page')
    expect(r!.params.resource).toBe('pages')
    expect(r!.params.path).toBe('alice/first-page')
    // defaultAccount → profile
    expect(r!.params.profile).toBe('alice-example')
    expect(r!.site).toBe('example')
  })

  it('полный URL → params', () => {
    const r = resolveRoute('https://www.example.com/pages/alice/first-page', sites)
    expect(r!.template).toBe('example/page')
    expect(r!.params.resource).toBe('pages')
    expect(r!.params.path).toBe('alice/first-page')
  })

  it('books/ shorthand → другой шаблон', () => {
    const r = resolveRoute('books/some/book', sites)
    expect(r!.template).toBe('example/book')
    expect(r!.params.resource).toBe('books')
  })

  it('не URL и не shorthand → null (прямое имя шаблона)', () => {
    expect(resolveRoute('single-word', sites)).toBeNull()
  })

  it('URL без подходящего сайта → ошибка', () => {
    expect(() => resolveRoute('https://unknown.test/x', sites)).toThrow(/site-плагина/)
  })
})

describe('registerSite — реестр site-плагинов', () => {
  let off: (() => void) | undefined
  afterEach(() => off?.())

  it('ядро без зарегистрированных сайтов пустое', () => {
    expect(registeredSites().some((s) => s.name === 'example')).toBe(false)
  })

  it('регистрация видна в registeredSites, отмена убирает', () => {
    off = registerSite(exampleSite)
    expect(registeredSites()).toContain(exampleSite)
    expect(resolveRoute('https://example.com/pages/a/b', registeredSites())!.template).toBe('example/page')
    off()
    off = undefined
    expect(registeredSites()).not.toContain(exampleSite)
  })

  it('повтор с тем же name заменяет прежний', () => {
    off = registerSite(exampleSite)
    const again = { ...exampleSite }
    const off2 = registerSite(again)
    expect(registeredSites().filter((s) => s.name === 'example')).toEqual([again])
    off2()
  })
})
