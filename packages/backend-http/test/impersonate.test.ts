/**
 * (протокол v1.19): персоны и рецепты через хранилище, адресат хода
 * `target`, impersonate бэкендом, полный рецепт из чанка `recipe`.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent, PersonasDoc, PromptRecipe, PromptView } from '@kerneldreams/ui-protocol'
import { PROMPT_ACTIVITY_KIND, derivedText } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenChunk, type GenerateRequest, type PersonaStore, type RecipeStore } from '../src/store-backend.js'
import { collect, scriptGen } from './store-harness.js'

const bot = { id: 'bot', kind: 'char' as const, name: 'Scarlett' }
const me = { id: 'me', kind: 'user' as const, name: 'Ann', scenario: 'тайна' }

function stores() {
  const personas = new Map<string, PersonasDoc>()
  const recipes = new Map<string, { data: unknown; texts: Map<string, string> }>()
  const personaStore: PersonaStore = {
    get: async (sid) => personas.get(sid) ?? { personas: [] },
    set: async (sid, doc) => void personas.set(sid, doc),
  }
  const recipeStore: RecipeStore = {
    put: async (sid, data, texts) => void recipes.set(`${sid}/${data.forMessageId}`, { data: structuredClone(data), texts: new Map(texts) }),
    get: async (sid, mid) => recipes.get(`${sid}/${mid}`),
  }
  return { personas, recipes, personaStore, recipeStore }
}

const recipeChunk: GenChunk = {
  type: 'recipe',
  system: 'LORE\n\nPRE',
  systemBlocks: [
    { source: 'lorebook:bot: Butcher', text: 'LORE' },
    { source: 'meta.pre', text: 'PRE' },
  ],
  injections: [
    { role: 'system', text: 'LORE', source: 'lorebook:bot: Butcher', reason: 'ключ «Rico»' },
    { role: 'user', text: 'POST', source: 'meta.post' },
  ],
  tools: [],
}

describe('store-backend: персоны и рецепты через хранилище', () => {
  it('personas.store — capability, save/list через стор; raw — generate видит текст без имён', async () => {
    const s0 = stores()
    const seen: GenerateRequest[] = []
    const backend = createStoreBackend({
      store: createMemoryStore(),
      generate: scriptGen({ chunks: [{ type: 'text', delta: 'Scarlett: привет' }], onRequest: (r) => seen.push(r) }),
      personas: { store: s0.personaStore, raw: true },
    })
    expect((await backend.capabilities()).personas).toEqual({ edit: true, multi: true })
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [bot, { ...bot, id: 'b2', name: 'Bob' }, me], 'me')
    expect(s0.personas.get(s.id)?.userId).toBe('me')
    await collect(backend.run(s.id, { userMessage: 'hi' }))
    // raw: без префикса «Ann: » (имена в ходу — два собеседника), документ персон — целиком.
    expect(derivedText(seen[0]!.messages.at(-1)!)).toBe('hi')
    expect(seen[0]!.personas?.userId).toBe('me')
    // Срез префикса ответа — по-прежнему здесь: в ленте текст чистый, имя — в meta.
    const { messages } = await backend.history(s.id)
    expect(derivedText(messages.at(-1)!)).toBe('привет')
    expect(messages.at(-1)!.meta?.personaId).toBe('bot')
  })

  it('чанк recipe — полный рецепт: блоки, инъекции с причиной, тулы; пишется в стор рецептов и читается после рестарта', async () => {
    const s0 = stores()
    const store = createMemoryStore()
    const backend = createStoreBackend({ store, generate: scriptGen({ chunks: [recipeChunk, { type: 'text', delta: 'ok' }] }), prompts: { store: s0.recipeStore } })
    const s = await backend.sessions.create()
    await collect(backend.run(s.id, { userMessage: 'Rico?' }))
    const answer = (await backend.history(s.id)).messages.at(-1)!
    const saved = s0.recipes.get(`${s.id}/${answer.id}`)!.data as PromptRecipe & { forMessageId: string }
    expect(saved.forMessageId).toBe(answer.id)
    expect(saved.tools).toEqual([])
    expect(saved.systemBlocks?.map((b) => b.source)).toEqual(['lorebook:bot: Butcher', 'meta.pre'])

    // Новый процесс (память пуста) — вид из стора.
    const again = createStoreBackend({ store, generate: scriptGen({ chunks: [] }), prompts: { store: s0.recipeStore } })
    const view = await again.messages!.prompt!(s.id, answer.id)
    expect(view.system).toBe('LORE\n\nPRE')
    expect(view.systemBlocks).toEqual([
      { source: 'lorebook:bot: Butcher', text: 'LORE' },
      { source: 'meta.pre', text: 'PRE' },
    ])
    expect(view.injections[0]).toEqual({ role: 'system', text: 'LORE', source: 'lorebook:bot: Butcher', reason: 'ключ «Rico»' })
    expect(view.recipe).not.toHaveProperty('forMessageId')
  })
})

describe('store-backend: target и impersonate (v1.19)', () => {
  it('без опции impersonate — not_supported до run_start; кривой target — bad_request', async () => {
    const backend = createStoreBackend({ store: createMemoryStore(), generate: scriptGen({ chunks: [] }) })
    const s = await backend.sessions.create()
    expect((await backend.capabilities()).impersonate).toBeUndefined()
    await expect(collect(backend.run(s.id, { target: { kind: 'user' } }))).rejects.toMatchObject({ code: 'not_supported' })
    await expect(collect(backend.run(s.id, { target: { kind: 'narrator' } as never }))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('impersonate: userMessage → input, ответ стримится сообщением игрока, лента и версия не меняются, промпт — activity', async () => {
    const s0 = stores()
    const seen: GenerateRequest[] = []
    const store = createMemoryStore()
    const backend = createStoreBackend({
      store,
      generate: scriptGen({ chunks: [{ ...recipeChunk, target: { kind: 'user' }, sent: [{ role: 'system', content: 'S' }, { role: 'user', content: 'INSTR' }] } as GenChunk, { type: 'text', delta: 'Я ' }, { type: 'text', delta: 'иду.' }], onRequest: (r) => seen.push(r) }),
      personas: { store: s0.personaStore, raw: true },
      prompts: { store: s0.recipeStore },
      impersonate: true,
    })
    expect((await backend.capabilities()).impersonate).toBe(true)
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [bot, me], 'me')
    await backend.messages!.append!(s.id, [{ type: 'text', text: 'Привет, путник.' }], { role: 'assistant' })
    const before = await backend.history(s.id)

    const events = (await collect(backend.run(s.id, { userMessage: 'спроси имя', target: { kind: 'user' } }))) as AnyRunEvent[]
    expect(seen[0]!.target).toEqual({ kind: 'user' })
    expect(seen[0]!.input).toBe('спроси имя')
    const start = events.find((e) => e.type === 'message_start') as { message: { role: string; meta?: { personaId?: string } } }
    expect(start.message).toMatchObject({ role: 'user', meta: { personaId: 'me' } })
    const end = events.find((e) => e.type === 'message_end') as { message: { parts: Array<{ text: string }> } }
    expect(end.message.parts[0]!.text).toBe('Я иду.')
    const activity = events.find((e) => e.type === 'activity') as { kind: string; payload: PromptView }
    expect(activity.kind).toBe(PROMPT_ACTIVITY_KIND)
    expect(activity.payload.recipe.target).toEqual({ kind: 'user' })
    expect(activity.payload.sent?.at(-1)).toEqual({ role: 'user', content: 'INSTR' })
    const runEnd = events.at(-1) as { type: string; status: string; version: string }
    expect(runEnd).toMatchObject({ type: 'run_end', status: 'done', version: before.version })

    const after = await backend.history(s.id)
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id))
    expect(s0.recipes.size).toBe(0)
  })

  it('target char с personaId — то же, что personaId', async () => {
    const s0 = stores()
    const seen: GenerateRequest[] = []
    const backend = createStoreBackend({ store: createMemoryStore(), generate: scriptGen({ chunks: [{ type: 'text', delta: 'x' }], onRequest: (r) => seen.push(r) }), personas: { store: s0.personaStore, raw: true } })
    const s = await backend.sessions.create()
    await backend.personas!.save!(s.id, [bot, { id: 'b2', kind: 'char', name: 'Bob' }, me], 'me')
    await collect(backend.run(s.id, { userMessage: 'hi', target: { kind: 'char', personaId: 'b2' } }))
    expect(seen[0]!.persona?.id).toBe('b2')
    expect(seen[0]!.target).toEqual({ kind: 'char', personaId: 'b2' })
  })
})
