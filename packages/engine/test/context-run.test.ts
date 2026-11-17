// End-to-end через run() на memory-драйвере: §13.2 (dry с инъекциями, trace),
// §13.4 (стейт на ленте).
//
// $visibility / $collapsed / %summary end-to-end через mds-файл переехали в
// nr-chat-store (парсинг) и в context-engine.test.ts (unit на nrd-core Message):
// плоская модель стора их узловые атрибуты пока не несёт (спец §1: collapsed не
// переезжает; visibility/summary — dormant до возврата через meta).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { objectContext } from '@kerneldreams/nrd'
import { run } from '../src/run.js'
import type { EngineConfig, SessionStore } from '../src/types.js'
import { memSession } from './helpers.js'

let dir: string
let store: SessionStore
let sid: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nr-ctx-'))
  ;({ store, sid } = await memSession())
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const BOOK = `## @entry elves
@keys: @[эльфы]
@priority: 50
@tags: @[lore]

Эльфы живут в хрустальных башнях.
`

function cfg(cmd: string): EngineConfig {
  return { assembly: 'direct', handler: 'chat', cmd }
}

function ctx(extra: Record<string, unknown> = {}) {
  return objectContext({ __basedir: dir, char: 'Луна', user: 'владелец', ...extra })
}

describe('run — dry с инъекциями (§13.2)', () => {
  it('лорбук из $lorebooks (ctx) попадает в промпт', async () => {
    mkdirSync(join(dir, 'lorebooks'))
    writeFileSync(join(dir, 'lorebooks', 'fantasy.mdd'), BOOK)
    await store.appendNode(sid, { role: 'system', text: 'Ты рассказчик.' })
    await store.appendNode(sid, { role: 'user', text: 'Расскажи про эльфы.' })

    const res = await run(cfg('dry'), { target: { store, sessionId: sid }, context: ctx({ lorebooks: 'fantasy' }) })
    expect(res.output).toContain('Эльфы живут в хрустальных башнях')
    expect(res.output).toContain('Ты рассказчик')
    expect(res.output).toContain('Расскажи про эльфы')
  })

  it('без $lorebooks — промпт как был, инъекций нет', async () => {
    await store.appendNode(sid, { role: 'system', text: 'Ты рассказчик.' })
    await store.appendNode(sid, { role: 'user', text: 'Привет.' })
    const res = await run(cfg('dry'), { target: { store, sessionId: sid }, context: ctx() })
    expect(res.output).toContain('Ты рассказчик')
    expect(res.output).not.toContain('Эльфы')
  })
})

describe('run — trace (§13.2, §7)', () => {
  it('trace объясняет каждое решение; --json — машиночитаемо', async () => {
    mkdirSync(join(dir, 'lorebooks'))
    writeFileSync(join(dir, 'lorebooks', 'fantasy.mdd'), BOOK)
    await store.appendNode(sid, { role: 'user', text: 'Расскажи про эльфы.' })

    const human = await run(cfg('trace'), { target: { store, sessionId: sid }, context: ctx({ lorebooks: 'fantasy' }) })
    expect(human.output).toContain('context trace')
    expect(human.output).toContain('matched')
    expect(human.output).toContain('fantasy:elves')
    expect(human.output).toContain('included')

    const json = await run(
      { ...cfg('trace'), json: true },
      { target: { store, sessionId: sid }, context: ctx({ lorebooks: 'fantasy' }) },
    )
    const parsed = JSON.parse(json.output) as {
      meta: { decisions: { kind: string }[]; injectionsMatched: number }
    }
    expect(parsed.meta.injectionsMatched).toBe(1)
    expect(parsed.meta.decisions.some((d) => d.kind === 'matched')).toBe(true)
  })
})

describe('стейт на ленте — §13.4', () => {
  it('стейт-нода, дописанная между ходами, видна следующим ходам (last-wins)', async () => {
    mkdirSync(join(dir, 'lorebooks'))
    writeFileSync(
      join(dir, 'lorebooks', 'state.mdd'),
      `## @entry low-hp
@keys: @[HP: 3]
@priority: 100
@tags: @[lore]

Персонаж при смерти — опиши слабость.
`,
    )
    await store.appendNode(sid, { role: 'user', text: 'Бью гоблина.' })

    // до дописи стейта — entry молчит
    const before = await run(cfg('dry'), { target: { store, sessionId: sid }, context: ctx({ lorebooks: 'state' }) })
    expect(before.output).not.toContain('Персонаж при смерти')

    // стейт дописан ПОСЛЕ хода — по last-wins виден следующим ходам
    await store.appendNode(sid, { role: 'state', text: 'HP: 3/20' })
    await store.appendNode(sid, { role: 'user', text: 'Бью ещё раз.' })

    const after = await run(cfg('dry'), { target: { store, sessionId: sid }, context: ctx({ lorebooks: 'state' }) })
    expect(after.output).toContain('Персонаж при смерти')
  })
})
