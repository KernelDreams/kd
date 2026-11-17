import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import { createStoreBackend, type GenerateFn } from '../src/store-backend.js'
import { sessionObjectBlocks, sessionObjectsOf } from '../src/session-objects.js'

describe('объекты сессии (v1.53, ABC-507)', () => {
  it('create кладёт objects в мету; ран получает блок object:<тип>/<id>', async () => {
    const seen: Array<{ prefix?: Array<{ source: string; text: string }> }> = []
    const gen: GenerateFn = async function* (req) {
      seen.push(req as never)
      yield { type: 'text', delta: 'ок' }
    }
    const b = createStoreBackend({ store: createMemoryStore(), generate: gen })
    const s = await b.sessions.create({ objects: [{ type: 'slot', id: 'coin_dragon', hash: 'h1', title: 'Coin Dragon', text: 'Правила: ...' }, { type: 'slot', id: 'coin_dragon' }, { type: '', id: 'x' }] as never })
    const meta = await b.meta!.get(s.id)
    expect(meta.objects).toEqual([{ type: 'slot', id: 'coin_dragon', hash: 'h1', title: 'Coin Dragon', text: 'Правила: ...' }])
    for await (const _ of b.run(s.id, { userMessage: 'что тут?' })) void _
    expect(seen[0]!.prefix?.map((x) => x.source)).toEqual(['object:slot/coin_dragon'])
    expect(seen[0]!.prefix?.[0]!.text).toContain('Coin Dragon')
  })
  it('чистка ссылок и блоки без текста', () => {
    expect(sessionObjectsOf([{ type: 'a', id: '1', extra: 1 }, null, 'x'])).toEqual([{ type: 'a', id: '1' }])
    expect(sessionObjectBlocks({ objects: [{ type: 'a', id: '1' }] })[0]!.source).toBe('object:a/1')
    expect(sessionObjectBlocks({})).toEqual([])
  })
})
