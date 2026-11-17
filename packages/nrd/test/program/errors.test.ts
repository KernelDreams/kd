// Громкие ошибки — перенос rz/test/errors.test.ts (rz-merge §3.3).
// Молчаливый фолбэк в любом из трёх мест = невидимо искалеченный прогон.
import { describe, it, expect } from 'vitest'
import { buildContext, parseMode } from '../../src/context/index.js'
import { objectContext, parseDocument } from '../../src/core/index.js'
import { detectKind } from '../../src/node/program.js'
import { readDecls, findDecl } from '../../src/program/registry.js'
import { fnSource } from '../../src/program/fn.js'
import { templateBody, templateParse } from '../../src/program/template.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'

const cfg = (...lines: string[]) => lines.join('\n')
const caps = nodeProgramCaps(process.cwd())
const decl = (text: string, kind: 'fn' | 'template', id: string) => {
  const doc = parseDocument(text, { sigil: '$' })
  return findDecl(readDecls(doc.doc.root, objectContext({})), kind, id)!
}

describe('1. неизвестный nr.parse — бросает', () => {
  it('parseMode роняет на незнакомом кодеке (было: молча text)', () => {
    expect(() => parseMode('ccv3')).toThrow(/неизвестный \$nr-parse/)
  })

  it('отсутствующее и пустое значение — легальный text', () => {
    expect(parseMode(undefined)).toBe('text')
    expect(parseMode(null)).toBe('text')
    expect(parseMode('')).toBe('text')
    expect(parseMode('MDZ')).toBe('mdz')
  })

  it('source с неизвестным $nr-parse роняет сборку', async () => {
    await expect(
      buildContext(cfg('## $source c', '$nr-type: inline', '$nr-parse: ccv3', '', 'тело')),
    ).rejects.toThrow(/неизвестный \$nr-parse: "ccv3"/)
  })

  it('template с неизвестным nr.parse роняет рендер', () => {
    expect(() => templateParse('toon', 'p')).toThrow(/неизвестный nr\.parse/)
  })
})

describe('2. неизвестный nr.type — бросает', () => {
  it('source-плагин не найден', async () => {
    await expect(buildContext(cfg('## $source c', '$nr-type: ccv3', '$path: ./x'))).rejects.toThrow(
      /source-плагин "ccv3" не найден/,
    )
  })

  it('source без типа вообще', async () => {
    await expect(buildContext(cfg('## $source c', '$path: ./x'))).rejects.toThrow(/без \$nr-type/)
  })

  it('fn с неизвестным nr.type', () => {
    expect(() =>
      fnSource(decl(cfg('## $fn f', "$nr: {type: 'http'}", 'код'), 'fn', 'f'), caps),
    ).toThrow(/неизвестный nr\.type "http" у fn "f"/)
  })

  it('template с неизвестным nr.type', () => {
    expect(() =>
      templateBody(
        decl(cfg('## $template t', "$nr: {type: 'http'}", 'тело'), 'template', 't'),
        caps,
      ),
    ).toThrow(/неизвестный nr\.type "http" у template "t"/)
  })

  it('fn с неизвестным nr.lang', () => {
    expect(() =>
      fnSource(decl(cfg('## $fn f', "$nr: {lang: 'python'}", 'код'), 'fn', 'f'), caps),
    ).toThrow(/неизвестный nr\.lang "python"/)
  })
})

describe('3. неизвестный тип файла в detect — бросает', () => {
  it('расширение вне таблицы входов', () => {
    expect(() => detectKind('/tmp/card.json')).toThrow(/неизвестный тип файла/)
  })

  it('файл без расширения', () => {
    expect(() => detectKind('/tmp/Makefile')).toThrow(/неизвестный тип файла/)
  })
})

describe('прочие громкие места', () => {
  it('fn (nr.type: file) без nr.src', () => {
    expect(() => fnSource(decl(cfg('## $fn f', "$nr: {type: 'file'}"), 'fn', 'f'), caps)).toThrow(
      /требует nr\.src/,
    )
  })

  it('пустое тело fn', () => {
    expect(() => fnSource(decl(cfg('## $fn f'), 'fn', 'f'), caps)).toThrow(/пуст/)
  })

  it('пустое тело template', () => {
    expect(() => templateBody(decl(cfg('## $template t'), 'template', 't'), caps)).toThrow(/пуст/)
  })
})
