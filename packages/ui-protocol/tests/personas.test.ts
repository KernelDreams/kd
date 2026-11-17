/**
 * personas-spec §1–4 — персоны: форма, кто есть кто, имя в тексте, шов.
 */

import { describe, it, expect } from 'vitest'
import {
  PERSONAS_CUSTOM_TYPE,
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandPersonaNames,
  isPersona,
  isPersonasDoc,
  isPromptRecipe,
  personaPrefixed,
  personasCapability,
  personasDocOf,
  personasSystemBlock,
  personasVoiced,
  stripPersonaPrefix,
  turnPersona,
  userPersona,
  validatePersonas,
} from '../src/index.js'
import type { Capabilities, Message, Persona, PersonasDoc, PersonasOps, RunStartInput } from '../src/index.js'

const alice: Persona = { id: 'alice', kind: 'char', name: 'Alice', color: '#f0a' }
const bob: Persona = { id: 'bob', kind: 'char', name: 'Bob', prompt: 'Ты ворчун. {{user}} тебя раздражает.' }
const me: Persona = { id: 'me', kind: 'user', name: 'owner' }
const doc: PersonasDoc = { personas: [alice, bob, me], userId: 'me' }

describe('форма', () => {
  it('isPersona / isPersonasDoc', () => {
    expect(isPersona(alice)).toBe(true)
    expect(isPersona({ id: 'x', kind: 'narrator', name: 'N' })).toBe(false)
    expect(isPersona({ id: 'x', kind: 'char', name: 'N', model: 5 })).toBe(false)
    expect(isPersonasDoc(doc)).toBe(true)
    expect(isPersonasDoc({ personas: [alice, { id: 1 }] })).toBe(false)
    expect(isPersonasDoc({ personas: [], userId: 3 })).toBe(false)
  })

  it('personasDocOf терпит битых: выпадают только они', () => {
    expect(personasDocOf({ personas: [alice, { id: 1 }, me], userId: 'me' })).toEqual({ personas: [alice, me], userId: 'me' })
    expect(personasDocOf({ userId: 7 })).toEqual({ personas: [] })
    expect(personasDocOf('x')).toBeUndefined()
  })

  it('validatePersonas', () => {
    expect(validatePersonas(doc.personas, 'me')).toBeUndefined()
    expect(validatePersonas([])).toBeUndefined()
    expect(validatePersonas('x')).toMatch(/массив/)
    expect(validatePersonas([alice, { ...bob, id: 'alice' }])).toMatch(/повторяется/)
    expect(validatePersonas([{ ...alice, name: ' ' }])).toMatch(/имя/)
    expect(validatePersonas([{ ...alice, id: '' }])).toMatch(/id/)
    expect(validatePersonas([alice], 'ghost')).toMatch(/нет/)
    expect(validatePersonas([alice, me], 'alice')).toMatch(/не user/)
  })

  it('capability: true — прежняя форма', () => {
    expect(personasCapability({})).toBeUndefined()
    expect(personasCapability({ personas: false })).toBeUndefined()
    expect(personasCapability({ personas: true })).toEqual({})
    expect(personasCapability({ personas: { edit: true, multi: true } })).toEqual({ edit: true, multi: true })
  })

  it('константы спеки', () => {
    expect(PERSONAS_CUSTOM_TYPE).toBe('nr-session-personas')
    expect(PERSONA_INJECTION_SOURCE).toBe('persona')
  })
})

describe('кто есть кто', () => {
  it('user — по userId, иначе первая user', () => {
    expect(userPersona(doc)?.id).toBe('me')
    expect(userPersona({ personas: [alice, me] })?.id).toBe('me')
    expect(userPersona({ personas: [alice, me], userId: 'alice' })?.id).toBe('me') // userId не user — не он
    expect(userPersona({ personas: [alice] })).toBeUndefined()
  })

  it('ход: явный — эта char, без него — первая char', () => {
    expect(charPersonas(doc).map((p) => p.id)).toEqual(['alice', 'bob'])
    expect(turnPersona(doc)?.id).toBe('alice')
    expect(turnPersona(doc, 'bob')?.id).toBe('bob')
    expect(turnPersona(doc, 'me')).toBeUndefined() // user не ходит
    expect(turnPersona(doc, 'ghost')).toBeUndefined()
    expect(turnPersona({ personas: [me] })).toBeUndefined()
  })

  it('имена в ходу: собеседников >1 либо prompt у персоны хода', () => {
    expect(personasVoiced(doc, alice)).toBe(true)
    expect(personasVoiced({ personas: [alice, me] }, alice)).toBe(false)
    expect(personasVoiced({ personas: [bob, me] }, bob)).toBe(true)
    expect(personasVoiced({ personas: [] }, undefined)).toBe(false)
  })
})

describe('имя в тексте', () => {
  it('{{char}}/{{user}} и ST-шные <BOT>/<USER>, регистр не важен', () => {
    expect(expandPersonaNames('{{char}} смотрит на {{User}}; <BOT> и <user>', { char: 'Alice', user: 'owner' })).toBe(
      'Alice смотрит на owner; Alice и owner',
    )
    expect(expandPersonaNames('{{char}} и {{user}}', { user: 'owner' })).toBe('{{char}} и owner')
  })

  it('префикс на отправке', () => {
    expect(personaPrefixed('Alice', 'привет')).toBe('Alice: привет')
  })

  it('срез префикса известной персоны', () => {
    const all = doc.personas
    expect(stripPersonaPrefix('Bob: ну и что?', all)).toEqual({ text: 'ну и что?', personaId: 'bob' })
    expect(stripPersonaPrefix('\n  alice:\nпривет', all)).toEqual({ text: 'привет', personaId: 'alice' })
    expect(stripPersonaPrefix('**Bob:** ну', all)).toEqual({ text: 'ну', personaId: 'bob' })
    expect(stripPersonaPrefix('**Bob**: ну', all)).toEqual({ text: 'ну', personaId: 'bob' })
    expect(stripPersonaPrefix('Примечание: текст', all)).toEqual({ text: 'Примечание: текст' })
    expect(stripPersonaPrefix('Bobby: не Bob', all)).toEqual({ text: 'Bobby: не Bob' })
  })

  it('длинные имена первыми', () => {
    const anna: Persona = { id: 'a', kind: 'char', name: 'Анна' }
    const annaMaria: Persona = { id: 'am', kind: 'char', name: 'Анна Мария' }
    expect(stripPersonaPrefix('Анна Мария: да', [anna, annaMaria])).toEqual({ text: 'да', personaId: 'am' })
  })

  it('блок участников: кто, чей ход, prompt персоны с раскрытыми именами', () => {
    const block = personasSystemBlock(doc, bob)
    expect(block).toContain('В этом диалоге участвуют:')
    expect(block).toContain('- Alice\n- Bob\n- owner (пользователь)')
    expect(block).toContain('Сейчас ход: Bob.')
    expect(block).toContain('owner тебя раздражает.')
    expect(personasSystemBlock(doc, alice)).not.toContain('раздражает')
  })
})

describe('шов', () => {
  it('ops, capability, meta и рецепт типизируются', async () => {
    const caps: Capabilities = { protocol: 1, personas: { edit: true, multi: true } }
    let stored: PersonasDoc = { personas: [] }
    const ops: PersonasOps = {
      list: async () => stored,
      save: async (_sid, personas, userId) => (stored = userId === undefined ? { personas } : { personas, userId }),
    }
    await ops.save!('s', doc.personas, 'me')
    expect((await ops.list('s')).userId).toBe('me')
    expect(personasCapability(caps)?.multi).toBe(true)

    const m: Message = { id: 'a1', role: 'assistant', parts: [], meta: { personaId: 'bob' } }
    expect(m.meta?.personaId).toBe('bob')
    // v1.12: адресат и свидетели — опциональные поля меты, ядро их не трактует
    const w: Message = { id: 'a2', role: 'assistant', parts: [], meta: { personaId: 'bob', to: 'me', seen: ['me'] } }
    expect([w.meta?.to, w.meta?.seen]).toEqual(['me', ['me']])
    // v1.13: пол персоны — опциональное поле, документ с ним годен
    expect(validatePersonas([{ id: 'me', kind: 'user', name: 'Вилл', gender: 'male' }], 'me')).toBeUndefined()
    // v1.13: типизированное действие и пожелание — поля входа рана, не трактуются
    const input: RunStartInput = { segments: [{ type: 'look', text: '' }], wish: 'пусть ворвётся стража' }
    expect(input.userMessage).toBeUndefined()
    const recipe = { at: 'x', systemHash: 'h', injections: [], messageIds: [], personaId: 'bob' }
    expect(isPromptRecipe(recipe)).toBe(true)
    expect(isPromptRecipe({ ...recipe, personaId: 1 })).toBe(false)
  })
})
