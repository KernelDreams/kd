// text-cast-spec §2.4 — громкость нерезолвленного плейсхолдера в декларациях.
//
// Дефолт остаётся lenient (существующие батчи на него опираются); strict —
import { resolve, get } from '../../src/core/index.js'
// опция хоста: нерезолвленный ключ роняет сборку и называет ключ и звено.

import { describe, it, expect } from 'vitest'
import { memoryStorage } from '../../src/web/index.js'
import { buildContext } from '../../src/context/index.js'

// Конфиги собираем join('\n') — чтобы `${...}` не интерполировался тест-файлом.
function cfg(...lines: string[]): string {
  return lines.join('\n')
}

const doc = cfg(
  '## $source bot',
  '$nr-type: inline',
  '$name: Carly',
  '$system: ${card.system}',
)

describe('§2.4 — режим резолва деклараций', () => {
  it('lenient (дефолт): нерезолвленный ключ остаётся литералом', async () => {
    const ctx = await buildContext(doc)
    expect(ctx.get(['bot', 'system'])).toBe('${card.system}')
    expect(ctx.get(['bot', 'name'])).toBe('Carly')
  })

  it('strict: ошибка называет ключ и звено', async () => {
    await expect(buildContext(doc, { mode: 'strict' })).rejects.toThrow(
      /source "bot".*ключ "system".*card\.system/s,
    )
  })

  it('strict не мешает резолвимым декларациям', async () => {
    const ok = cfg(
      '$slug: carly',
      '## $source bot',
      '$nr-type: inline',
      '$name: ${slug}',
    )
    const ctx = await buildContext(ok, { mode: 'strict' })
    expect(ctx.get(['bot', 'name'])).toBe('carly')
  })

  it('strict ловит нерезолвленное и в корневом атрибуте', async () => {
    const bad = cfg('$path: ./bots/${missing}.md', '## $source s', '$nr-type: inline', '$a: 1')
    await expect(buildContext(bad, { mode: 'strict' })).rejects.toThrow(
      /корневой атрибут, ключ "path".*missing/s,
    )
  })

  it('strict распространяется на transform-декларации', async () => {
    const bad = cfg(
      '## $source s',
      '$nr-type: inline',
      '$a: 1',
      '',
      '## $transform t',
      '$nr-type: nope',
      '$arg: ${nowhere}',
    )
    await expect(buildContext(bad, { mode: 'strict' })).rejects.toThrow(
      /transform "t".*ключ "arg".*nowhere/s,
    )
  })

  it('opt-out `\\${` не считается нерезолвленным и в strict', async () => {
    const s = cfg('## $source s', '$nr-type: inline', '$tpl: \\${literal}')
    const ctx = await buildContext(s, { mode: 'strict' })
    // ctx.get — сырой вид: эскейп жив до выхода резолвера (§3.1)
    expect(ctx.get(['s', 'tpl'])).toBe('\\${literal}')
    expect(resolve('${s.tpl}', ctx)).toBe('${literal}')
    expect(get('s.tpl', ctx)).toBe('${literal}')
  })

  it('strict доезжает до тела звена через storage-источник', async () => {
    const store = memoryStorage()
    await store.write('bot.md', '@name: Carly')
    const s = cfg(
      '## $source card',
      "$nr: {type: 'file', parse: 'mdd'}",
      '$path: ${missing_path}',
    )
    await expect(buildContext(s, { mode: 'strict', storage: store })).rejects.toThrow(
      /source "card".*ключ "path".*missing_path/s,
    )
  })
})
