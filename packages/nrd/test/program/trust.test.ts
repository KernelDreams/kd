// Trust — перенос rz/test/trust.test.ts (rz-merge §3.3, грабли §5).
// Граница: entry-файл доверен (юзер запустил), данные — нет.
import { describe, it, expect } from 'vitest'
import { buildContext } from '../../src/context/index.js'
import { objectContext, parseDocument } from '../../src/core/index.js'
import { loadFn } from '../../src/program/fn.js'
import { templateBody } from '../../src/program/template.js'
import { requireCodeLoader, requireFs } from '../../src/program/capability.js'
import { nodeProgramCaps, syncFsStorage } from '../../src/node/capability-program.js'
import { findDecl, readDecls } from '../../src/program/registry.js'

const cfg = (...lines: string[]) => lines.join('\n')

const declOf = (text: string, kind: 'fn' | 'template', id: string) =>
  findDecl(
    readDecls(parseDocument(text, { sigil: '$' }).doc.root, objectContext({})),
    kind,
    id,
  )!

const fnDecl = declOf(
  cfg('## $fn hello', '```ts', 'export default async () => ({output: "hi"})', '```'),
  'fn',
  'hello',
)

describe('fn из недоверенного звена', () => {
  it('не исполняется — громкий отказ', async () => {
    await expect(loadFn(fnDecl, nodeProgramCaps(process.cwd(), false))).rejects.toThrow(
      /не исполняется в недоверенном звене/,
    )
  })

  it('доверенное звено исполняется', async () => {
    const loaded = await loadFn(fnDecl, nodeProgramCaps(process.cwd(), true))
    const result = (await loaded.run()) as { output: string }
    expect(result.output).toBe('hi')
  })
})

describe('capability недоверенному не выдаётся', () => {
  it('nodeProgramCaps(trusted: false) не несёт ни ФС, ни исполнителя, ни загрузчика кода', () => {
    const caps = nodeProgramCaps(process.cwd(), false)
    expect(caps.fs).toBeUndefined()
    expect(caps.storage).toBeUndefined()
    expect(caps.executor).toBeUndefined()
    expect(caps.codeLoader).toBeUndefined()
  })

  it('requireFs падает внятно, а не undefined-ом', () => {
    expect(() => requireFs(nodeProgramCaps(process.cwd(), false), 'helpers')).toThrow(
      /требует capability/,
    )
  })

  it('requireCodeLoader — «code loading not available on this host», не фолбэк', () => {
    expect(() =>
      requireCodeLoader({ baseDir: '.', trusted: true }, 'fn "x"'),
    ).toThrow(/code loading not available on this host/)
  })

  it('template из внешнего файла недоступен без ФС', () => {
    const decl = declOf(
      cfg('## $template t', "$nr: {type: 'file', src: './x.tpl'}"),
      'template',
      't',
    )
    expect(() => templateBody(decl, nodeProgramCaps(process.cwd(), false))).toThrow(
      /требует capability/,
    )
  })
})

describe('гейт источников сохраняется (модель сборки контекста)', () => {
  const withFile = cfg('## $source c', '$nr-type: file', '$path: ./x.md')

  it('strictUntrusted — ошибка на файловом источнике', async () => {
    await expect(
      buildContext(withFile, { trusted: false, strictUntrusted: true }),
    ).rejects.toThrow(/пропущен — trusted:false/)
  })

  it('по умолчанию — пропуск со стороны гейта, без данных в цепочке', async () => {
    const ctx = await buildContext(withFile, { trusted: false })
    expect(ctx.get(['c'])).toBeUndefined()
  })
})

describe('syncFsStorage — пути укоренены в baseDir', () => {
  it('read несуществующего — undefined, не исключение', () => {
    expect(syncFsStorage(process.cwd()).read('./нет-такого-файла.md')).toBeUndefined()
  })
})
