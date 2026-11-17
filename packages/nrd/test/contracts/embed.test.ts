import { describe, it, expect } from 'vitest'
import {
  ok,
  type EmbedRequest,
  type EmbedResponse,
  type EmbedStore,
  type LLMProvider,
} from '../../src/contracts/index.js'

// Контракты — только типы: тест проверяет, что формы собираются и
// `embed` у провайдера опционален.
describe('embed contracts', () => {
  it('LLMProvider без embed — валиден', () => {
    const p: LLMProvider = {
      chat: async () => ok({ content: '', stop_reason: 'end_turn' }),
      stream: async function* () {},
    }
    expect(p.embed).toBeUndefined()
  })

  it('LLMProvider с embed', async () => {
    const p: LLMProvider = {
      chat: async () => ok({ content: '', stop_reason: 'end_turn' }),
      stream: async function* () {},
      embed: async (req: EmbedRequest) =>
        ok<EmbedResponse>({ vectors: req.input.map(() => new Float32Array(3)), model: req.model }),
    }
    const r = await p.embed!({ model: 'embed/x', input: ['a', 'b'] })
    expect(r.ok && r.value.vectors.length).toBe(2)
  })

  it('EmbedStore — форма', async () => {
    const data = new Map<string, Float32Array>()
    const store: EmbedStore = {
      get: async (_s, hs) => new Map(hs.filter((h) => data.has(h)).map((h) => [h, data.get(h)!])),
      put: async (_s, e) => { for (const [h, v] of e) data.set(h, v) },
      stat: async () => ({ count: data.size, dim: data.size ? 3 : null }),
      spaces: async () => ['embed/x'],
    }
    await store.put('embed/x', new Map([['h1', new Float32Array(3)]]))
    expect((await store.get('embed/x', ['h1', 'h2'])).size).toBe(1)
    expect(await store.stat('embed/x')).toEqual({ count: 1, dim: 3 })
  })
})
