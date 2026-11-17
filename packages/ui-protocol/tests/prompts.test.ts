/**
 * prompt-recipe-spec §1–2 — рецепт промпта: форма и шов `messages.prompt`.
 */

import { describe, it, expect } from 'vitest'
import { PROMPT_ACTIVITY_KIND, PROMPT_HASH_LENGTH, PROMPT_MESSAGE_HASH_LENGTH, PROMPT_RECIPE_CUSTOM_TYPE, canImpersonate, isParticipantRef, isPromptRecipe, targetsUser } from '../src/index.js'
import type { Capabilities, MessagesOps, PromptRecipe, PromptView, RunStartInput } from '../src/index.js'

const recipe: PromptRecipe = {
  at: '2026-09-17T10:00:00.000Z',
  model: 'gpt-x',
  systemHash: 'aaaaaaaaaaaaaaaa',
  injections: [{ role: 'user', hash: 'bbbbbbbbbbbbbbbb', source: 'meta.post' }],
  messageIds: ['m1', 'm2'],
  messageHashes: ['11111111', '22222222'],
  tokens: { input: 10, output: 2 },
}

describe('isPromptRecipe', () => {
  it('принимает полный и минимальный рецепт', () => {
    expect(isPromptRecipe(recipe)).toBe(true)
    expect(isPromptRecipe({ at: 'x', systemHash: 'h', injections: [], messageIds: [] })).toBe(true)
  })

  it('терпит лишние поля записи (forMessageId)', () => {
    expect(isPromptRecipe({ ...recipe, forMessageId: 'a1' })).toBe(true)
  })

  it('отвергает битую форму', () => {
    expect(isPromptRecipe(null)).toBe(false)
    expect(isPromptRecipe([])).toBe(false)
    expect(isPromptRecipe({ ...recipe, systemHash: 1 })).toBe(false)
    expect(isPromptRecipe({ ...recipe, messageIds: ['a', 2] })).toBe(false)
    expect(isPromptRecipe({ ...recipe, injections: [{ role: 'tool', hash: 'h' }] })).toBe(false)
    expect(isPromptRecipe({ ...recipe, messageHashes: 'x' })).toBe(false)
    expect(isPromptRecipe({ ...recipe, model: 5 })).toBe(false)
  })

  it('константы спеки', () => {
    expect(PROMPT_RECIPE_CUSTOM_TYPE).toBe('nr-prompt-recipe')
    expect(PROMPT_HASH_LENGTH).toBe(16)
    expect(PROMPT_MESSAGE_HASH_LENGTH).toBe(8)
  })
})

describe('messages.prompt — шов', () => {
  it('capability и метод типизируются', async () => {
    const caps: Capabilities = { protocol: 1, prompts: true }
    const view: PromptView = {
      recipe,
      system: 'ты кот',
      injections: [{ role: 'user', text: 'мяукай', source: 'meta.post' }],
      messages: [
        { id: 'm1', role: 'user', text: 'привет' },
        { id: 'm2', role: 'assistant', text: '', missing: true },
      ],
    }
    const ops: MessagesOps = { prompt: async () => view }
    expect(caps.prompts).toBe(true)
    expect((await ops.prompt!('s', 'a')).messages.map((m) => m.id)).toEqual(recipe.messageIds)
  })
})

describe('v1.19 — адресат хода (target), impersonate бэкендом, рецепт по блокам', () => {
  it('ParticipantRef: user | char с personaId; прочее — нет', () => {
    expect(isParticipantRef({ kind: 'user' })).toBe(true)
    expect(isParticipantRef({ kind: 'char' })).toBe(true)
    expect(isParticipantRef({ kind: 'char', personaId: 'p1' })).toBe(true)
    expect(isParticipantRef({ kind: 'char', personaId: 1 })).toBe(false)
    expect(isParticipantRef({ kind: 'narrator' })).toBe(false)
    expect(isParticipantRef('user')).toBe(false)
    expect(isParticipantRef(null)).toBe(false)
  })

  it('targetsUser и гейт canImpersonate', () => {
    const input: RunStartInput = { userMessage: 'спроси про башню', target: { kind: 'user' } }
    expect(targetsUser(input)).toBe(true)
    expect(targetsUser({ target: { kind: 'char', personaId: 'p' } })).toBe(false)
    expect(targetsUser({})).toBe(false)
    expect(canImpersonate({ protocol: 1, impersonate: true } as Capabilities)).toBe(true)
    expect(canImpersonate({ protocol: 1 } as Capabilities)).toBe(false)
  })

  it('рецепт с target, systemBlocks и reason инъекции — валиден; кривые — нет', () => {
    const full = {
      ...recipe,
      target: { kind: 'user' },
      systemBlocks: [{ source: 'meta.pre', hash: 'h1' }, { source: 'lorebook:bot: Butcher', hash: 'h2' }],
      injections: [{ role: 'system', hash: 'h2', source: 'lorebook:bot: Butcher', reason: 'ключ «Rico»' }],
    }
    expect(isPromptRecipe(full)).toBe(true)
    expect(isPromptRecipe({ ...full, systemBlocks: [{ source: 1, hash: 'h' }] })).toBe(false)
    expect(isPromptRecipe({ ...full, injections: [{ role: 'system', hash: 'h', reason: 5 }] })).toBe(false)
    expect(PROMPT_ACTIVITY_KIND).toBe('prompt')
  })
})
