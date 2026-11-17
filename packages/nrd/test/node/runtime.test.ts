// nrd/node — smoke бывшего nr-runtime (nrd-merge §5).
//
// У nr-runtime не было ни одного теста: пакет ушёл в слияние с нулём покрытия,
// и репро от 07.09 (discoverFunctions не подхватывал `.mjs`) ловить было нечем.
// Минимум, который спека требует зафиксировать при переезде.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFunctions, builtinFunctions, buildRuntimeContext } from '../../src/node/index.js'

let root: string
let emptyGlobal: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nrd-runtime-'))
  // Пустая глобальная директория: иначе тест видел бы ~/.nrd/functions/ машины.
  emptyGlobal = join(root, 'no-global')

  const fns = join(root, '.nrd', 'functions')
  mkdirSync(fns, { recursive: true })
  writeFileSync(join(fns, 'shout.mjs'), 'export default (args) => String(args[0] ?? "").toUpperCase()\n')
  writeFileSync(join(fns, 'twice.js'), 'export default (args) => Number(args[0] ?? 0) * 2\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('discoverFunctions', () => {
  it('подхватывает .mjs из .nrd/functions/ (репро 07.09)', () => {
    const fns = discoverFunctions(root, emptyGlobal)
    expect(typeof fns.shout).toBe('function')
    expect(fns.shout(['мидленд'], undefined as never)).toBe('МИДЛЕНД')
  })

  it('подхватывает .js рядом с .mjs', () => {
    const fns = discoverFunctions(root, emptyGlobal)
    expect(fns.twice([21], undefined as never)).toBe(42)
  })

  it('мержит fs-builtins поверх найденного', () => {
    const fns = discoverFunctions(root, emptyGlobal)
    for (const name of Object.keys(builtinFunctions)) {
      expect(typeof fns[name]).toBe('function')
    }
  })

  it('директории без .nrd/functions/ не ломают поиск', () => {
    const bare = mkdtempSync(join(tmpdir(), 'nrd-bare-'))
    try {
      expect(() => discoverFunctions(bare, emptyGlobal)).not.toThrow()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('buildRuntimeContext', () => {
  it('собирает контекст из файла и даёт найденные функции в ${}', async () => {
    const doc = join(root, 'doc.mdz')
    writeFileSync(
      doc,
      ['## $source s', '$nr-type: inline', '$nr-parse: mdz', '', '$loud: ${shout("мидленд")}'].join('\n'),
    )
    const ctx = await buildRuntimeContext(doc, { globalFunctionsDir: emptyGlobal })
    expect(ctx.get(['s', 'loud'])).toBe('МИДЛЕНД')
  })

  it('разворачивает $[[include]] относительно baseDir документа', async () => {
    writeFileSync(join(root, 'part.md'), '$from-include: 1')
    const doc = join(root, 'inc.mdz')
    writeFileSync(
      doc,
      ['## $source s', '$nr-type: inline', '$nr-parse: mdz', '', '$[[./part.md]]'].join('\n'),
    )
    const ctx = await buildRuntimeContext(doc, { globalFunctionsDir: emptyGlobal })
    expect(ctx.get(['s', 'from-include'])).toBe(1)
  })
})
