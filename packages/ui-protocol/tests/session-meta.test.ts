/**
 * session-meta-spec §2 — документ меты и merge патча.
 *
 * Merge живёт в протоколе, а не в бэкендах, поэтому проверяется здесь один раз
 * и за всех: pi-расширение, backend-pi и store-бэкенд обязаны применять патч
 * одинаково, иначе «мета» означала бы разное в разных бэкендах.
 */

import { describe, it, expect } from 'vitest'
import { isSessionPromptMode, mergeSessionMeta, sessionPromptMode } from '../src/index.js'
import type { SessionMetaDoc, SessionMetaOps, SessionMetaPatch } from '../src/index.js'

describe('mergeSessionMeta', () => {
  it('на пустом документе даёт сам патч', () => {
    expect(mergeSessionMeta({}, { prompt: { pre: 'ты кот' }, notes: 'черновик' })).toEqual({
      prompt: { pre: 'ты кот' },
      notes: 'черновик',
    })
  })

  it('мержит prompt по своим ключам, не стирая соседний', () => {
    const doc: SessionMetaDoc = { prompt: { pre: 'ты кот', post: 'мяукай' } }
    expect(mergeSessionMeta(doc, { prompt: { post: 'не мяукай' } })).toEqual({
      prompt: { pre: 'ты кот', post: 'не мяукай' },
    })
  })

  it('null удаляет ключ верхнего уровня и ключ внутри prompt', () => {
    const doc: SessionMetaDoc = { prompt: { pre: 'a', post: 'b' }, notes: 'n' }
    expect(mergeSessionMeta(doc, { notes: null })).toEqual({ prompt: { pre: 'a', post: 'b' } })
    expect(mergeSessionMeta(doc, { prompt: { pre: null } })).toEqual({ prompt: { post: 'b' }, notes: 'n' })
  })

  it('опустевший prompt не остаётся пустым объектом', () => {
    expect(mergeSessionMeta({ prompt: { pre: 'a' } }, { prompt: { pre: null } })).toEqual({})
    expect(mergeSessionMeta({ prompt: { pre: 'a' } }, { prompt: null })).toEqual({})
  })

  it('undefined — это «ключ не патчили», а не удаление', () => {
    const doc: SessionMetaDoc = { prompt: { pre: 'a' }, notes: 'n' }
    expect(mergeSessionMeta(doc, { notes: undefined })).toEqual(doc)
    expect(mergeSessionMeta(doc, { prompt: { pre: undefined } })).toEqual(doc)
  })

  it('чужие ключи проносятся как есть — документ открыт для расширений', () => {
    expect(mergeSessionMeta({ nrs: { lore: 1 } }, { nrs: { lore: 2 }, worldState: 'x' })).toEqual({
      nrs: { lore: 2 },
      worldState: 'x',
    })
  })

  it('mode мержится тем же правилом, что pre/post (§7)', () => {
    expect(mergeSessionMeta({ prompt: { pre: 'ты кот' } }, { prompt: { mode: 'replace' } })).toEqual({
      prompt: { pre: 'ты кот', mode: 'replace' },
    })
    // Снятие режима — возврат к дефолту окружения, а не к 'append' записью.
    expect(mergeSessionMeta({ prompt: { pre: 'a', mode: 'replace' } }, { prompt: { mode: null } })).toEqual({
      prompt: { pre: 'a' },
    })
  })

  it('effectivePrompt read-only: не приходит патчем и не остаётся в документе (§7)', () => {
    expect(mergeSessionMeta({}, { effectivePrompt: 'подделка' } as SessionMetaPatch)).toEqual({})
    // Клиент вернул то, что прочитал через get — вычисленный ключ не должен
    // осесть в файле сессии.
    expect(
      mergeSessionMeta({ effectivePrompt: 'что ушло в модель' }, { notes: 'n' }),
    ).toEqual({ notes: 'n' })
  })

  it('вход не мутируется', () => {
    const doc: SessionMetaDoc = { prompt: { pre: 'a' } }
    mergeSessionMeta(doc, { prompt: { pre: 'b' }, notes: 'n' })
    expect(doc).toEqual({ prompt: { pre: 'a' } })
  })
})

describe('SessionMetaOps', () => {
  it('реализуется поверх merge; get на пустой сессии отдаёт {}', async () => {
    const store = new Map<string, SessionMetaDoc>()
    const ops: SessionMetaOps = {
      async get(id: string): Promise<SessionMetaDoc> {
        return store.get(id) ?? {}
      },
      async patch(id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc> {
        const next = mergeSessionMeta(store.get(id) ?? {}, patch)
        store.set(id, next)
        return next
      },
    }

    expect(await ops.get('s1')).toEqual({})
    expect(await ops.patch('s1', { prompt: { pre: 'ты кот' } })).toEqual({ prompt: { pre: 'ты кот' } })
    expect(await ops.patch('s1', { prompt: { post: 'мяукай' } })).toEqual({
      prompt: { pre: 'ты кот', post: 'мяукай' },
    })
    expect(await ops.get('s1')).toEqual({ prompt: { pre: 'ты кот', post: 'мяукай' } })
  })
})

describe('sessionPromptMode (§7)', () => {
  it('ключа нет — append', () => {
    expect(sessionPromptMode({})).toBe('append')
    expect(sessionPromptMode({ prompt: { pre: 'ты кот' } })).toBe('append')
  })

  it('replace — как записано', () => {
    expect(sessionPromptMode({ prompt: { pre: 'a', mode: 'replace' } })).toBe('replace')
  })

  it('незнакомое значение — append: неизвестный режим не выкидывает штатный промпт', () => {
    expect(sessionPromptMode({ prompt: { mode: 'втихаря' } } as SessionMetaDoc)).toBe('append')
    expect(isSessionPromptMode('втихаря')).toBe(false)
    expect(isSessionPromptMode('replace')).toBe(true)
  })
})
