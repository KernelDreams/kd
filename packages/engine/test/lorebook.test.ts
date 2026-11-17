// LorebookInjector — §13.1 (matching), §13.3 (dogfooding: ноль приватных импортов).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyContext } from '@kerneldreams/nrd'
import { memoryStorage } from '@kerneldreams/nrd/web'
import { LorebookInjector, parseLorebook } from '../src/context/injectors/lorebook.js'
import { loadLorebooks } from '../src/context/injectors/load.js'
import { DefaultContextEngine } from '../src/context/engine.js'
import { estimateTokens } from '../src/context/tokens.js'
import type { InjectorCapabilities, ScanContext, Logger } from '../src/context/types.js'

const BOOK = `@name: Fantasy World
@scan_depth: 10

## @entry elves
@keys: @[elves, эльфы]
@priority: 50
@tags: @[lore]

Эльфы живут в хрустальных башнях.

## @entry dark-forest
@keys: @[лес]
@secondary_keys: @[ночь]
@priority: 30
@tags: @[lore, at_depth]
@depth: 1

Тёмный лес — проклятое место.

## @entry rules
@constant: true
@priority: 900
@tags: @[post]

Отвечай в настоящем времени.

## @entry disabled-one
@keys: @[эльфы]
@enabled: false
@priority: 999

Не должно попасть.
`

const silent: Logger = { debug: () => {}, warn: () => {}, error: () => {} }

function caps(): InjectorCapabilities {
  return { log: silent, countTokens: estimateTokens }
}

function scanCtx(texts: string[]): ScanContext {
  return {
    recentText: texts.join('\n'),
    messages: texts.map((t) => ({
      role: 'user',
      blocks: [{ type: 'text', attrs: {}, body: t }],
      attrs: {},
      isSummary: false,
      isFrozen: false,
      isCollapsedSummary: false,
    })),
    card: emptyContext,
    turn: texts.length,
  }
}

describe('parseLorebook — mdd', () => {
  it('читает entries, ключи, теги, флаги', () => {
    const book = parseLorebook(BOOK)
    expect(book.scanDepth).toBe(10)
    expect(book.entries.map((e) => e.id)).toEqual(['elves', 'dark-forest', 'rules', 'disabled-one'])

    const elves = book.entries[0]!
    expect(elves.keys).toEqual(['elves', 'эльфы'])
    expect(elves.tags).toEqual(['lore'])
    expect(elves.priority).toBe(50)
    expect(elves.enabled).toBe(true)

    expect(book.entries[2]!.constant).toBe(true)
    expect(book.entries[3]!.enabled).toBe(false)
  })
})

describe('LorebookInjector — matching', () => {
  it('primary OR, case-insensitive, границы слова (в т.ч. кириллица)', async () => {
    const inj = new LorebookInjector({ id: 'fantasy', source: BOOK })
    const hits = await inj.scan(scanCtx(['Расскажи про Эльфов и про ЭЛЬФЫ']), caps())
    expect(hits.map((h) => h.id)).toContain('fantasy:elves')
  })

  it('слово внутри другого слова не триггерит', async () => {
    const inj = new LorebookInjector({ id: 'fantasy', source: BOOK })
    const hits = await inj.scan(scanCtx(['лесник пошёл домой']), caps())
    expect(hits.map((h) => h.id)).not.toContain('fantasy:dark-forest')
  })

  it('secondary AND: primary без secondary не срабатывает', async () => {
    const inj = new LorebookInjector({ id: 'fantasy', source: BOOK })
    const only = await inj.scan(scanCtx(['идём через лес']), caps())
    expect(only.map((h) => h.id)).not.toContain('fantasy:dark-forest')

    const both = new LorebookInjector({ id: 'fantasy', source: BOOK })
    const hits = await both.scan(scanCtx(['идём через лес в ночь']), caps())
    expect(hits.map((h) => h.id)).toContain('fantasy:dark-forest')
  })

  it('constant — всегда, без ключей; $enabled: false — никогда', async () => {
    const inj = new LorebookInjector({ id: 'fantasy', source: BOOK })
    const hits = await inj.scan(scanCtx(['привет']), caps())
    expect(hits.map((h) => h.id)).toEqual(['fantasy:rules'])
    expect(hits[0]!.matchedKeys).toEqual(['$constant'])
    expect(hits.map((h) => h.id)).not.toContain('fantasy:disabled-one')
  })

  it('cooldown: после срабатывания entry молчит N ходов', async () => {
    const book = `## @entry x
@keys: @[кот]
@cooldown: 3
@priority: 10

Кот пушистый.
`
    const inj = new LorebookInjector({ id: 'b', source: book })
    const first = await inj.scan({ ...scanCtx(['кот']), turn: 1 }, caps())
    expect(first).toHaveLength(1)

    const second = await inj.scan({ ...scanCtx(['кот']), turn: 2 }, caps())
    expect(second).toHaveLength(0) // на cooldown

    const later = await inj.scan({ ...scanCtx(['кот']), turn: 5 }, caps())
    expect(later).toHaveLength(1) // cooldown истёк
  })

  it('scanDepth: entry не видит сообщений глубже своей глубины', async () => {
    const book = `## @entry x
@keys: @[якорь]
@scan_depth: 1
@priority: 10

Про якорь.
`
    const inj = new LorebookInjector({ id: 'b', source: book })
    const deep = await inj.scan(scanCtx(['якорь тут', 'а тут нет', 'и тут нет']), caps())
    expect(deep).toHaveLength(0)

    const near = new LorebookInjector({ id: 'b', source: book })
    expect(await near.scan(scanCtx(['ничего', 'якорь тут']), caps())).toHaveLength(1)
  })
})

describe('$lorebooks → injector end-to-end', () => {
  it('lorebook из $lorebooks срабатывает при assemble; tags доезжают до пакета', async () => {
    const storage = memoryStorage()
    await storage.write('fantasy.mdd', BOOK)

    const injectors = await loadLorebooks(['fantasy'], storage, silent)
    expect(injectors).toHaveLength(1)

    const engine = new DefaultContextEngine({ injectors, storage })
    const pkg = await engine.assemble(
      { getAllMessages: () => [{ role: 'user', attrs: {}, blocks: [{ type: 'text', attrs: {}, body: 'расскажи про эльфы' }] }] },
      emptyContext,
    )

    const ids = pkg.injections.map((i) => i.id)
    expect(ids).toContain('fantasy:elves')
    expect(ids).toContain('fantasy:rules') // constant
    expect(pkg.injections.find((i) => i.id === 'fantasy:rules')!.tags).toEqual(['post'])
    // constant priority 900 > elves 50 + boost
    expect(pkg.injections[0]!.id).toBe('fantasy:rules')
  })

  it('несуществующий лорбук — warn, не падение', async () => {
    const warns: string[] = []
    const injectors = await loadLorebooks(['нет-такого'], memoryStorage(), {
      ...silent,
      warn: (m) => warns.push(m),
    })
    expect(injectors).toEqual([])
    expect(warns[0]).toContain('не найден')
  })
})

// §13.3 — LorebookInjector не импортирует ничего приватного из движка.
describe('dogfooding: плагин живёт на публичном шве', () => {
  it('LorebookInjector импортирует только nrd-core и ../types.js', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/context/injectors/lorebook.ts', import.meta.url)),
      'utf-8',
    )
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
    const allowed = new Set(['@kerneldreams/nrd', '../types.js'])
    const violations = imports.filter((i) => !allowed.has(i))
    expect(violations).toEqual([])
  })
})
