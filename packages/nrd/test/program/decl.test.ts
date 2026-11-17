// Реестр деклараций — перенос rz/test/decl.test.ts (rz-merge §3.3).
// Категория по имени, тип атрибутом; три записи `nr` эквивалентны.
import { describe, it, expect } from 'vitest'
import { buildContext, normalizeNrAttrs, nrKey } from '../../src/context/index.js'
import { objectContext, parseDocument } from '../../src/core/index.js'
import type { IContext, Value } from '../../src/core/index.js'
import { readDecls, findDecl, autoSteps, BLOCK_NAMES } from '../../src/program/registry.js'

const cfg = (...lines: string[]) => lines.join('\n')
const empty: IContext = objectContext({})

function decls(text: string) {
  const doc = parseDocument(text, { sigil: '$' })
  return readDecls(doc.doc.root, empty)
}

describe('normalizeNrAttrs — три записи одной декларации', () => {
  it('вложенная `nr: {…}` разворачивается в плоскую `nr-*`', () => {
    const out = normalizeNrAttrs({
      nr: { type: 'file', parse: 'mdz' },
      path: './x',
    } as Record<string, Value>)
    expect(out['nr-type']).toBe('file')
    expect(out['nr-parse']).toBe('mdz')
    expect(out['path']).toBe('./x')
    expect('nr' in out).toBe(false)
  })

  it('dotted `nr.X` — тот же путь', () => {
    const out = normalizeNrAttrs({ 'nr.type': 'env' } as Record<string, Value>)
    expect(out['nr-type']).toBe('env')
    expect('nr.type' in out).toBe(false)
  })

  it('плоская запись побеждает вложенную при конфликте', () => {
    const out = normalizeNrAttrs({
      nr: { type: 'file' },
      'nr-type': 'inline',
    } as Record<string, Value>)
    expect(out['nr-type']).toBe('inline')
  })

  it('вход не мутируется', () => {
    const input = { nr: { type: 'file' } } as Record<string, Value>
    normalizeNrAttrs(input)
    expect(input).toEqual({ nr: { type: 'file' } })
  })

  it('nrKey: канон `nr-X`, легаси `X` фолбэком', () => {
    expect(nrKey({ 'nr-input': 'a', input: 'b' } as Record<string, Value>, 'input')).toBe('a')
    expect(nrKey({ input: 'b' } as Record<string, Value>, 'input')).toBe('b')
    expect(nrKey({} as Record<string, Value>, 'input')).toBeUndefined()
  })
})

describe('биекция $nr-X ≡ $nr: {X} ≡ $nr.X (source-блоки)', () => {
  const flat = cfg('## $source c', '$nr-type: inline', '$nr-parse: mdz', '', '$model: gpt-4o')
  const nested = cfg('## $source c', "$nr: {type: 'inline', parse: 'mdz'}", '', '$model: gpt-4o')
  const dotted = cfg('## $source c', '$nr.type: inline', '$nr.parse: mdz', '', '$model: gpt-4o')
  const legacy = cfg('## $source c', '$type: inline', '$nr-parse: mdz', '', '$model: gpt-4o')

  it('все четыре записи дают одинаковый результат', async () => {
    for (const text of [flat, nested, dotted, legacy]) {
      const ctx = await buildContext(text)
      expect([ctx.get(['c', 'model']), ctx.get(['model'])]).toEqual(['gpt-4o', 'gpt-4o'])
    }
  })
})

describe('nr-input / nr-chain — канон, input / chain — легаси', () => {
  const upper = {
    name: 'upper',
    async transform(input: IContext) {
      const v = input.get(['v'])
      return objectContext({ v: String(v).toUpperCase() })
    },
  }

  const withInput = (key: string) =>
    cfg(
      '## $source a',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '',
      '$v: quiet',
      '',
      '## $transform t',
      '$nr-type: upper',
      `$${key}: a`,
    )

  it('$nr-input и $input указывают на то же звено', async () => {
    const canon = await buildContext(withInput('nr-input'), { transforms: { upper } })
    const legacy = await buildContext(withInput('input'), { transforms: { upper } })
    expect(canon.get(['a', 'v'])).toBe('QUIET')
    expect(legacy.get(['a', 'v'])).toBe('QUIET')
  })

  const withChain = (key: string) =>
    cfg(
      `$${key}: b, a`,
      '## $source a',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '',
      '$shared: from-a',
      '',
      '## $source b',
      '$nr-type: inline',
      '$nr-parse: mdz',
      '',
      '$shared: from-b',
    )

  it('$nr-chain и $chain одинаково меняют приоритет звеньев', async () => {
    const canon = await buildContext(withChain('nr-chain'))
    const legacy = await buildContext(withChain('chain'))
    expect(canon.get(['shared'])).toBe('from-b')
    expect(legacy.get(['shared'])).toBe('from-b')
  })

  it('вложенная форма в корне работает так же', async () => {
    const nested = await buildContext(
      cfg(
        "$nr: {chain: 'b, a'}",
        '## $source a',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '',
        '$shared: from-a',
        '',
        '## $source b',
        '$nr-type: inline',
        '$nr-parse: mdz',
        '',
        '$shared: from-b',
      ),
    )
    expect(nested.get(['shared'])).toBe('from-b')
  })
})

describe('реестр деклараций — категория по имени, тип атрибутом', () => {
  it('словарь имён сведён в таблицу', () => {
    expect(BLOCK_NAMES['action'].kind).toBe('fn')
    expect(BLOCK_NAMES['handler'].kind).toBe('fn')
    expect(BLOCK_NAMES['prompt'].kind).toBe('template')
    expect(BLOCK_NAMES['prompt'].parse).toBe('chat')
    expect(BLOCK_NAMES['tpl'].kind).toBe('template')
    expect(BLOCK_NAMES['card'].kind).toBe('data')
  })

  it('имена блоков раскладываются по категориям', () => {
    const d = decls(
      cfg(
        '## $action all',
        'code',
        '',
        '## $prompt extract',
        'tpl',
        '',
        '## $card bot',
        'персона',
        '',
        '## $source cfg',
        '$nr-type: inline',
      ),
    )
    expect(findDecl(d, 'fn', 'all')?.blockName).toBe('action')
    expect(findDecl(d, 'template', 'extract')?.parse).toBe('chat')
    expect(findDecl(d, 'data', 'bot')?.kind).toBe('data')
    expect(findDecl(d, 'source', 'cfg')?.type).toBe('inline')
  })

  it('явная nr.kind перебивает словарь имён', () => {
    const d = decls(cfg('## $bot helper', "$nr: {kind: 'fn', lang: 'js'}", 'код'))
    expect(d[0].kind).toBe('fn')
    expect(d[0].lang).toBe('js')
    expect(d[0].blockName).toBe('bot')
  })

  it('незнакомое имя без декларации — данные, не ошибка', () => {
    const d = decls(cfg('## $note x', 'текст'))
    expect(d[0].kind).toBe('data')
  })

  it('неизвестная nr.kind — громкая ошибка', () => {
    expect(() => decls(cfg('## $x y', '$nr-kind: codec'))).toThrow(/неизвестный nr\.kind/)
  })
})

describe('шаги блокнота: `step` и явный $nr-auto (rz-merge §2.4)', () => {
  it('`step` — fn с auto, в порядке документа', () => {
    const d = decls(
      cfg(
        '## $source cfg',
        '$nr-type: inline',
        '',
        '## $step one',
        'код 1',
        '',
        '## $step two',
        'код 2',
      ),
    )
    expect(autoSteps(d).map((s) => s.id)).toEqual(['one', 'two'])
    expect(findDecl(d, 'fn', 'one')?.kind).toBe('fn')
  })

  it('$nr-auto: true делает шагом любое fn-имя', () => {
    const d = decls(cfg('## $fn manual', 'код', '', '## $fn auto', '$nr-auto: true', 'код'))
    expect(autoSteps(d).map((s) => s.id)).toEqual(['auto'])
  })

  it('$nr-auto: false снимает авто со `step`', () => {
    const d = decls(cfg('## $step off', '$nr-auto: false', 'код'))
    expect(autoSteps(d)).toEqual([])
  })
})
