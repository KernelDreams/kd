/**
 * Зонды `examples/botchat` — перенос rz/test/botchat.test.ts (rz-merge §3.5).
 *
 * Зонд писался прогоном и ловил два молчаливых дефекта: тело блока недостижимо
 * из `${}` (наружу тёк `[object Object]`) и нерезолвленный плейсхолдер уезжает
 * литералом. Теперь это проверки: один потребитель, два источника — плоский
 * json и mdd с телами блоков — обязаны дать одни и те же поля.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { ScriptResult } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const probe = (name: string) => path.join(HERE, 'examples', 'botchat', name)

async function run(file: string): Promise<string> {
  const r = await execute({ script: file, args: {}, cwd: path.dirname(file), env: {} })
  return (r.result as ScriptResult).output ?? ''
}

/** Строка трассы: `  <поле>  <длина>  <начало>` → длина и начало. */
function traced(output: string, name: string): { len: number; head: string } {
  const line = output.split('\n').find((l) => l.trim().startsWith(name + ' '))
  expect(line, `в выводе нет поля "${name}":\n${output}`).toBeTruthy()
  const rest = line!.trim().slice(name.length).trimStart()
  const sp = rest.indexOf(' ')
  return { len: Number(rest.slice(0, sp)), head: rest.slice(sp).trim() }
}

/** Значение строки вида `метка : значение`. */
function field(output: string, label: string): string {
  const line = output.split('\n').find((l) => l.startsWith(label))
  expect(line, `в выводе нет строки "${label}":\n${output}`).toBeTruthy()
  return line!.slice(line!.indexOf(':') + 1).trim()
}

const FIELDS = ['name', 'persona', 'scenario', 'greeting', 'system'] as const

describe('examples/botchat — источник не виден потребителю (§4.1)', () => {
  it('mdd даёт те же поля, что json', async () => {
    const fromJson = await run(probe('from-json.mdz'))
    const fromMdd = await run(probe('from-mdd.mdz'))

    for (const out of [fromJson, fromMdd]) {
      expect(out).not.toMatch(/\[object Object\]/)
      expect(out).not.toMatch(/\$\{/) // ноль нерезолвленных плейсхолдеров
    }

    for (const name of FIELDS) {
      const j = traced(fromJson, name)
      const m = traced(fromMdd, name)
      expect(m.len, `поле "${name}": длина mdd ≠ json`).toBe(j.len)
      expect(m.head, `поле "${name}": начало mdd ≠ json`).toBe(j.head)
    }
  })

  it('поля непустые и осмысленные', async () => {
    const out = await run(probe('from-mdd.mdz'))
    expect(traced(out, 'name').head).toBe('Carly & Rob')
    expect(traced(out, 'persona').len).toBeGreaterThan(100)
    expect(traced(out, 'scenario').len).toBeGreaterThan(100)
    expect(traced(out, 'greeting').len).toBeGreaterThan(100)
    // пустое поле остаётся пустым: `{}` сломал бы паритет с плоским источником
    expect(traced(out, 'system').len).toBe(0)
  })
})

describe('examples/botchat — граница дерево/текст (§4.2–§4.4)', () => {
  it('целое значение — дерево, оно же в строке — тело блока', async () => {
    const out = await run(probe('text-cast.mdz'))
    expect(field(out, 'whole — дерево')).toBe('true')
    expect(field(out, 'адресация внутрь')).toBe('ru')
    expect(field(out, 'whole — текст')).toMatch(/^# Carly/)
    expect(field(out, 'в строке')).toMatch(/^персона — # Carly/)
  })

  it('звено с атрибутами без тела → json5-дамп, и String() = интерполяции', async () => {
    const out = await run(probe('text-cast.mdz'))
    const dump = field(out, 'дамп через ${}')
    expect(dump).not.toMatch(/\[object Object\]/)
    expect(dump).toMatch(/^дамп — \{.+\}$/)
    expect(dump).toMatch(/lang: 'ru'/)
    expect(field(out, 'дамп совпал')).toBe('true')
  })

  it('пустое звено — пустая строка, не [object Object] и не дамп', async () => {
    const out = await run(probe('text-cast.mdz'))
    expect(field(out, 'пустое поле')).toBe('[]')
  })
})
