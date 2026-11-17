/**
 * Зонды `examples/` — перенос rz/test/examples.test.ts (rz-merge §3.5).
 *
 * Каждый зонд писался прогоном (не чтением) и ловил дефект резолва; теперь это
 * проверки вывода. Слои цепочки задаются явно (strong = CLI, weak = конфиги),
 * именно их разделение и чинило каскад (resolve-fix §1.1).
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { ScriptResult, Value } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const probe = (dir: string, name: string) => path.join(HERE, 'examples', dir, name)

interface RunOptions {
  /** «CLI-аргументы» — слой сильнее атрибутов документа. */
  cli?: Record<string, Value>
  /** Конфиг/окружение — слой слабее атрибутов документа. */
  weak?: Record<string, string>
}

async function run(file: string, o: RunOptions = {}): Promise<string> {
  const r = await execute({
    script: file,
    args: o.cli ?? {},
    cwd: path.dirname(file),
    // Слабый слой хоста — окружение: под неймспейсом `env.` оно в цепочке есть,
    // но голым ключом документ не перебивает.
    env: o.weak ?? {},
  })
  return (r.result as ScriptResult).output ?? ''
}

/** Значение строки вида `метка : значение` из вывода зонда. */
function field(output: string, label: string): string {
  const line = output.split('\n').find((l) => l.trimEnd().startsWith(label))
  expect(line, `в выводе нет строки "${label}":\n${output}`).toBeTruthy()
  return line!.slice(line!.indexOf(':') + 1).trim()
}

describe('examples/resolve — каскад (§1.1)', () => {
  const file = probe('resolve', 'chain.mdz')

  it('без аргументов — значение документа', async () => {
    expect(field(await run(file), 'marker из источника')).toBe('DOC-FILE')
  })

  it('CLI перебивает атрибут документа', async () => {
    const out = await run(file, { cli: { slug: 'from-cli' } })
    expect(field(out, 'marker из источника')).toBe('CLI-FILE')
  })

  it('конфиг/env НЕ перебивает атрибут документа', async () => {
    const out = await run(file, { weak: { slug: 'from-config' } })
    expect(field(out, 'marker из источника')).toBe('DOC-FILE')
  })

  it('CLI сильнее конфига и env одновременно', async () => {
    const out = await run(file, { cli: { slug: 'from-cli' }, weak: { slug: 'from-config' } })
    expect(field(out, 'marker из источника')).toBe('CLI-FILE')
  })

  it('helpers.attr и ${} совпадают во всех прогонах', async () => {
    for (const o of [{}, { cli: { slug: 'from-cli' } }, { weak: { slug: 'from-config' } }]) {
      const out = await run(file, o as RunOptions)
      expect(field(out, 'slug через helpers.attr'), `расхождение при ${JSON.stringify(o)}`).toBe(
        field(out, 'slug через ${} в ctx'),
      )
    }
  })
})

describe('examples/resolve — зависимые источники (§1.2)', () => {
  it('deps.mdz: путь звена берётся из предыдущего звена', async () => {
    const out = await run(probe('resolve', 'deps.mdz'))
    expect(field(out, 'registry.active')).toBe('alice')
    expect(field(out, 'bot.name')).toBe('Alice')
    expect(field(out, 'bot.persona')).toBe('сдержанная, говорит короткими фразами')
    expect(field(out, 'label.text')).toBe('Alice (alto)')
  })

  it('inline-dep.mdz: тело звена видит предыдущее звено', async () => {
    const out = await run(probe('resolve', 'inline-dep.mdz'))
    expect(field(out, 'registry.active')).toBe('alice')
    expect(field(out, 'label.text')).toBe('активен alice')
  })

  it('forward-ref.mdz: ссылка вперёд — громкая ошибка с именем звена', async () => {
    await expect(run(probe('resolve', 'forward-ref.mdz'))).rejects.toThrow(
      /source "label" ссылается на "registry", объявленный НИЖЕ/,
    )
  })
})

describe('examples/resolve — ${} в теле источника (§1.3)', () => {
  it('inline-forms.mdz: телесная и атрибутная формы дают одно и то же', async () => {
    const out = await run(probe('resolve', 'inline-forms.mdz'))
    const body = field(out, 'a.text (тело mdd)')
    expect(body).toBe('привет мир')
    expect(body).toBe(field(out, 'b.text (атрибуты)'))
    expect(out).not.toMatch(/\[object Object\]/)
  })

  it('probe.mdz: значение — строка, а не утёкший объект', async () => {
    expect((await run(probe('resolve', 'probe.mdz'))).trim()).toBe('"привет мир"')
  })
})

describe('examples/forge — композиция форматов (§1.4–§1.7)', () => {
  it('build.mdz: инклуды внутри тела звена, last-wins', async () => {
    const out = await run(probe('forge', 'build.mdz'))
    expect(field(out, 'bot.name')).toBe('Carly')
    expect(field(out, 'bot.age')).toBe('26')
    expect(field(out, 'bot.traits')).toBe('сдержанная, но упрямая') // preset поверх
    expect(field(out, 'bot.style')).toBe('короткие реплики')
    expect(field(out, 'bot.setting')).toBe('летняя трасса, переезд')
  })

  it('mixed.mdz: одинарные кавычки, путь от документа, дерево из функции', async () => {
    const out = await run(probe('forge', 'mixed.mdz'))
    expect(field(out, 'bot.name')).toBe('Carly')
    expect(field(out, 'typeof bot.preset')).toBe('object')
    expect(field(out, 'isContext(bot.preset)')).toBe('true')
    expect(field(out, 'bot.preset.temperature')).toBe('0.9')
    expect(field(out, 'bot.preset.style')).toBe('из json-пресета')
    expect(field(out, 'bot.lore.city')).toBe('Мидленд')
  })

  it('fn-forms.mdz: поле результата вызова и монтирование поддерева', async () => {
    const out = await run(probe('forge', 'fn-forms.mdz'))
    expect(field(out, 'поле .temperature')).toBe('0.9')
    expect(field(out, 'поле .style')).toBe('из json-пресета')
    expect(field(out, 'целиком → дерево')).toBe('true')
    expect(field(out, 'из дерева .max_tokens')).toBe('512')
  })
})
