// Context Engine — §13.1: scoring, бюджет, block filtering, $visibility,
// collapsed/%summary, decision log.

import { describe, it, expect } from 'vitest'
import { objectContext, chainContext, emptyContext } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { Message } from '../src/message-model.js'
import { DefaultContextEngine } from '../src/context/engine.js'
import { readEngineConfig, CTX_DEFAULTS } from '../src/context/config.js'
import { estimateTokens } from '../src/context/tokens.js'
import type { ContextEvent } from '../src/context/engine.js'
import type { ContextPackage, IContextInjector } from '../src/context/types.js'

function msg(role: string, body: string, attrs: Record<string, unknown> = {}): Message {
  return { role, attrs: attrs as Message['attrs'], blocks: [{ type: 'text', attrs: {}, body }] }
}

function session(messages: Message[]) {
  return { getAllMessages: () => messages }
}

function textOf(pkg: ContextPackage): string[] {
  return pkg.messages.map((m) =>
    m.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.body)
      .join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Конфиг из каскада (§2)
// ---------------------------------------------------------------------------

describe('readEngineConfig — $ctx-* каскад', () => {
  it('дефолты, когда в цепочке ничего нет', () => {
    expect(readEngineConfig(emptyContext)).toEqual(CTX_DEFAULTS)
  })

  it('ближнее звено цепочки побеждает (CLI > сессия)', () => {
    const cli = objectContext({ 'ctx-max-tokens': 4000 })
    const sessionAttrs = objectContext({ 'ctx-max-tokens': 8000, 'ctx-recent-depth': 2 })
    const cfg = readEngineConfig(chainContext(cli, sessionAttrs))
    expect(cfg.maxTokens).toBe(4000)
    expect(cfg.recentDepth).toBe(2)
  })

  it('$lorebooks — name-list из строки и из массива', () => {
    expect(readEngineConfig(objectContext({ lorebooks: 'a, b' })).lorebooks).toEqual(['a', 'b'])
    expect(readEngineConfig(objectContext({ lorebooks: ['a', 'b'] })).lorebooks).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Токены
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('кириллица дороже латиницы (занижаем бюджет)', () => {
    const cyr = 'привет как дела сегодня'
    const lat = 'hello how are you today!!'
    expect(cyr.length).toBeCloseTo(lat.length, -1)
    expect(estimateTokens(cyr)).toBeGreaterThan(estimateTokens(lat))
  })
})

// ---------------------------------------------------------------------------
// Scoring + бюджет (§3)
// ---------------------------------------------------------------------------

describe('assemble — scoring и бюджет', () => {
  it('всё влезло — лента цела, порядок хронологический', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(
      session([msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three')]),
      emptyContext,
    )
    expect(textOf(pkg)).toEqual(['one', 'two', 'three'])
    expect(pkg.meta.historyFull).toBe(3)
    expect(pkg.meta.historyDropped).toBe(0)
  })

  it('бюджет режет старое: свежее сообщение бьёт старое (score = base - distance)', async () => {
    const engine = new DefaultContextEngine()
    // Каждое сообщение ~5 токенов; бюджет на два.
    const ctx = objectContext({ 'ctx-max-tokens': 1010, 'ctx-reserve-output': 1000 })
    const pkg = await engine.assemble(
      session([msg('user', 'aaaaaaaaaaaaaaaaaaaa'), msg('assistant', 'bbbbbbbbbbbbbbbbbbbb'), msg('user', 'cccc')]),
      ctx,
    )
    expect(textOf(pkg)).toEqual(['bbbbbbbbbbbbbbbbbbbb', 'cccc'])
    expect(pkg.meta.historyDropped).toBe(1)
    expect(pkg.meta.dropped[0]).toMatchObject({ reason: 'budget', source: 'history' })
  })

  it('%system и $frozen — Infinity: остаются, когда обычные сообщения вылетают', async () => {
    const engine = new DefaultContextEngine()
    const ctx = objectContext({ 'ctx-max-tokens': 1012, 'ctx-reserve-output': 1000 })
    const pkg = await engine.assemble(
      session([
        msg('system', 'SYS'),
        msg('user', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        msg('assistant', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        msg('user', 'keep', { frozen: true }),
      ]),
      ctx,
    )
    expect(textOf(pkg)).toContain('SYS')
    expect(textOf(pkg)).toContain('keep')
    expect(pkg.meta.historyDropped).toBeGreaterThan(0)
  })

  it('обязательный контекст не влезает → ошибка, а не тихий дроп', async () => {
    const engine = new DefaultContextEngine()
    const ctx = objectContext({ 'ctx-max-tokens': 1002, 'ctx-reserve-output': 1000 })
    await expect(
      engine.assemble(session([msg('system', 'x'.repeat(400))]), ctx),
    ).rejects.toThrow(/не влезает в бюджет/)
  })

  it('budget:exceeded едет в hooks-канал', async () => {
    const events: ContextEvent[] = []
    const engine = new DefaultContextEngine({ onEvent: (e) => events.push(e) })
    const ctx = objectContext({ 'ctx-max-tokens': 1005, 'ctx-reserve-output': 1000 })
    await engine.assemble(session([msg('user', 'a'.repeat(80)), msg('user', 'b')]), ctx)
    const budget = events.find((e) => e.type === 'budget:exceeded')
    expect(budget).toBeDefined()
    expect(budget!['available']).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Block filtering по глубине (§4)
// ---------------------------------------------------------------------------

describe('assemble — block filtering по глубине', () => {
  const withThinking = (body: string): Message => ({
    role: 'assistant',
    attrs: {},
    blocks: [
      { type: 'thinking', attrs: {}, body: 'REASONING' },
      { type: 'text', attrs: {}, body },
      { type: 'usage', attrs: {}, body: '{"in":1}' },
    ],
  })

  it('recent — thinking сохраняется; middle — выбрасывается; usage — никогда', async () => {
    const engine = new DefaultContextEngine()
    const ctx = objectContext({ 'ctx-recent-depth': 1, 'ctx-summary-depth': 30 })
    const pkg = await engine.assemble(session([withThinking('old'), withThinking('fresh')]), ctx)

    const types = pkg.messages.map((m) => m.blocks.map((b) => b.type))
    expect(types[0]).toEqual(['text']) // middle: thinking срезан
    expect(types[1]).toEqual(['thinking', 'text']) // recent: thinking остался
    expect(types.flat()).not.toContain('usage') // usage — никогда
  })

  it('tool-блоки в средних — только при $ctx-tools-in-middle', async () => {
    const tooled: Message = {
      role: 'assistant',
      attrs: {},
      blocks: [
        { type: 'text', attrs: {}, body: 'calling' },
        { type: 'tool_use', attrs: { name: 'search' }, body: '{}' },
      ],
    }
    const engine = new DefaultContextEngine()
    const base = { 'ctx-recent-depth': 0, 'ctx-summary-depth': 30 }

    const off = await engine.assemble(session([tooled]), objectContext(base))
    expect(off.messages[0]!.blocks.map((b) => b.type)).toEqual(['text'])

    const on = await engine.assemble(
      session([tooled]),
      objectContext({ ...base, 'ctx-tools-in-middle': true }),
    )
    expect(on.messages[0]!.blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })
})

// ---------------------------------------------------------------------------
// %summary и $collapsed (§10)
// ---------------------------------------------------------------------------

describe('assemble — %summary и $collapsed', () => {
  it('старое сообщение с %summary заменяется на summary, свежее — нет', async () => {
    const withSummary = (body: string): Message => ({
      role: 'assistant',
      attrs: {},
      blocks: [
        { type: 'text', attrs: {}, body },
        { type: 'summary', attrs: {}, body: `SUM(${body})` },
      ],
    })
    const engine = new DefaultContextEngine()
    // summary-depth: 1 → всё, что глубже последнего, считается old
    const ctx = objectContext({ 'ctx-recent-depth': 0, 'ctx-summary-depth': 1 })
    const pkg = await engine.assemble(session([withSummary('old'), withSummary('fresh')]), ctx)

    expect(textOf(pkg)).toEqual(['SUM(old)', 'fresh'])
    expect(pkg.messages[0]!.isSummary).toBe(true)
    expect(pkg.meta.historySummarized).toBe(1)
    expect(pkg.meta.decisions).toContainEqual({
      kind: 'replaced',
      item: 'assistant@0',
      by: 'summary',
    })
  })

  it('$collapsed — один item из тела ссылки, свой score', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(
      session([
        msg('system', 'Свернули 6 итераций приветствия', { collapsed: 'greeting', id: 'g1' }),
        msg('user', 'дальше'),
      ]),
      emptyContext,
    )
    expect(pkg.messages[0]!.isCollapsedSummary).toBe(true)
    expect(textOf(pkg)[0]).toBe('Свернули 6 итераций приветствия')
    expect(pkg.meta.decisions).toContainEqual({
      kind: 'replaced',
      item: 'system#g1',
      by: 'collapsed',
    })
  })
})

// ---------------------------------------------------------------------------
// $visibility (§4, §13.5)
// ---------------------------------------------------------------------------

describe('assemble — $visibility', () => {
  it('$visibility: ui — сообщение не уходит модели, помечено dropped(visibility)', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(
      session([
        msg('user', 'привет'),
        msg('system', 'HP: 12/20 · Инвентарь: меч', { visibility: 'ui', id: 'panel' }),
        msg('assistant', 'ответ'),
      ]),
      emptyContext,
    )
    expect(textOf(pkg)).toEqual(['привет', 'ответ'])
    expect(pkg.meta.decisions).toContainEqual({
      kind: 'dropped',
      item: 'system#panel',
      reason: 'visibility',
      detail: '$visibility: ui',
    })
  })

  it('$visibility: model — уходит модели (в UI прячет консьюмер)', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(
      session([msg('system', 'служебная инъекция', { visibility: 'model' })]),
      emptyContext,
    )
    expect(textOf(pkg)).toEqual(['служебная инъекция'])
  })

  it('$visibility на контент-блоке — режется отдельный блок, сообщение живёт', async () => {
    const mixed: Message = {
      role: 'assistant',
      attrs: {},
      blocks: [
        { type: 'text', attrs: {}, body: 'видно всем' },
        { type: 'text', attrs: { visibility: 'ui' }, body: 'СТАТ-ПАНЕЛЬ' },
      ],
    }
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(session([mixed]), emptyContext)
    expect(textOf(pkg)).toEqual(['видно всем'])
  })

  it('$hidden — dropped(hidden), не visibility', async () => {
    const engine = new DefaultContextEngine()
    const pkg = await engine.assemble(
      session([msg('user', 'OOC', { hidden: true, id: 'ooc' }), msg('user', 'привет')]),
      emptyContext,
    )
    expect(textOf(pkg)).toEqual(['привет'])
    expect(pkg.meta.decisions).toContainEqual({ kind: 'dropped', item: 'user#ooc', reason: 'hidden' })
  })
})

// ---------------------------------------------------------------------------
// Injector-шов + decision log (§5, §7)
// ---------------------------------------------------------------------------

const stubInjector = (entries: { id: string; content: string; priority: number; depth?: number }[]): IContextInjector => ({
  id: 'stub',
  async scan() {
    return entries.map((e) => ({
      id: e.id,
      content: e.content,
      tags: ['lore'],
      priority: e.priority,
      source: 'stub',
      matchedKeys: ['k'],
      ...(e.depth === undefined ? {} : { triggeredAtDepth: e.depth }),
    }))
  },
})

describe('assemble — injector и decision log', () => {
  it('recency boost: тот же priority, но свежий триггер — выше', async () => {
    const engine = new DefaultContextEngine({
      injectors: [
        stubInjector([
          { id: 'far', content: 'FAR', priority: 50, depth: 9 },
          { id: 'near', content: 'NEAR', priority: 50, depth: 0 },
        ]),
      ],
    })
    const pkg = await engine.assemble(session([msg('user', 'hi')]), emptyContext)
    expect(pkg.injections.map((i) => i.id)).toEqual(['near', 'far'])
    expect(pkg.injections[0]!.score).toBeGreaterThan(pkg.injections[1]!.score)
  })

  it('decision log объясняет каждое решение: matched → scored → included', async () => {
    const engine = new DefaultContextEngine({
      injectors: [stubInjector([{ id: 'elves', content: 'Эльфы живут в башнях', priority: 50 }])],
    })
    const pkg = await engine.assemble(session([msg('user', 'эльфы?')]), emptyContext)
    const kinds = pkg.meta.decisions.map((d) => d.kind)
    expect(kinds).toContain('matched')
    expect(kinds).toContain('scored')
    expect(kinds).toContain('included')
    expect(pkg.meta.decisions).toContainEqual({
      kind: 'matched',
      entry: 'elves',
      injector: 'stub',
      keys: ['k'],
    })
    expect(pkg.meta.injectionsMatched).toBe(1)
    expect(pkg.meta.injectionsIncluded).toBe(1)
  })

  it('injector упал → движок жив, инъекций просто нет', async () => {
    const engine = new DefaultContextEngine({
      injectors: [{ id: 'boom', scan: async () => { throw new Error('нет сети') } }],
    })
    const pkg = await engine.assemble(session([msg('user', 'hi')]), emptyContext)
    expect(pkg.injections).toEqual([])
    expect(textOf(pkg)).toEqual(['hi'])
  })
})

// ---------------------------------------------------------------------------
// Стейт-на-ленте (§13.4)
// ---------------------------------------------------------------------------

describe('стейт на ленте', () => {
  it('стейт-блок виден injector-у только после своей позиции', async () => {
    const seen: string[] = []
    const spy: IContextInjector = {
      id: 'state-reader',
      async scan(ctx) {
        seen.push(ctx.recentText)
        return []
      },
    }
    const engine = new DefaultContextEngine({ injectors: [spy] })

    const beforeState = [msg('user', 'ход 1'), msg('assistant', 'ответ 1')]
    await engine.assemble(session(beforeState), emptyContext)

    const afterState = [
      ...beforeState,
      msg('state', 'HP: 12/20', { visibility: 'model' }),
      msg('user', 'ход 2'),
    ]
    await engine.assemble(session(afterState), emptyContext)

    expect(seen[0]).not.toContain('HP: 12/20') // до дописи — стейта нет
    expect(seen[1]).toContain('HP: 12/20') // после — есть, из семантики ленты
  })
})
