// Node-адаптер CodeLoader (rz-merge §3.4).
//
// Главное свойство — импорты тела резолвятся ОТ baseDir, а не от системного
// temp: голый `@kerneldreams/nrd/chat` и относительный `./sib.ts` обязаны
// найтись так же, как если бы тело лежало файлом рядом с документом.
// (Импорт самого `@kerneldreams/nrd` проверяет runz: у него есть линк на
// пакет, у репы nrd самоссылки нет.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { nodeCodeLoader, TMP_PREFIX } from '../../src/node/code-loader.js'

const repo = process.cwd()
let outside: string

beforeAll(() => {
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-loader-'))
})

afterAll(() => {
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('nodeCodeLoader', () => {
  const loader = nodeCodeLoader(repo)

  it('грузит тело как модуль и отдаёт экспорты', async () => {
    const mod = await loader.load(
      ['export default (a: number) => a * 2', 'export const fn = () => 7'].join('\n'),
      { lang: 'ts', filename: 'double.ts' },
    )
    expect((mod.default as (n: number) => number)(21)).toBe(42)
    expect((mod.fn as () => number)()).toBe(7)
  })

  it('голый импорт студийного пакета резолвится от baseDir', async () => {
    const mod = await loader.load(
      [
        "import { parse } from '@kerneldreams/nrd/chat'",
        'export default (text: string) => parse(text).map((m) => m.role)',
      ].join('\n'),
    )
    const roles = (mod.default as (t: string) => string[])('%system\nа\n\n%user\nб\n')
    expect(roles).toEqual(['system', 'user'])
  })

  it('относительный импорт резолвится от baseDir', async () => {
    fs.writeFileSync(path.join(outside, 'sib.ts'), 'export const answer = 42\n', 'utf-8')
    const mod = await nodeCodeLoader(outside).load(
      ["import { answer } from './sib.ts'", 'export default () => answer'].join('\n'),
    )
    expect((mod.default as () => number)()).toBe(42)
  })

  it('временный файл удаляется после загрузки', async () => {
    await loader.load('export default () => 1')
    const left = fs.readdirSync(repo).filter((f) => f.startsWith(TMP_PREFIX))
    expect(left).toEqual([])
  })

  it('два разных тела под одним именем не склеиваются кэшем модулей', async () => {
    const a = await loader.load('export default () => "a"', { filename: 'same.ts' })
    const b = await loader.load('export default () => "b"', { filename: 'same.ts' })
    expect((a.default as () => string)()).toBe('a')
    expect((b.default as () => string)()).toBe('b')
  })

  it('битый синтаксис — громкая ошибка, не пустой модуль', async () => {
    await expect(loader.load('export default (((')).rejects.toThrow()
  })
})
