/**
 * Компакция в createStoreBackend (протокол v1.18): чанк `compaction`
 * пишет узел через опцию `compaction` (pi-драйвер — запись compaction pi) до
 * ответа рана; команда рана (`run.commands`, `RunStartInput.command`) — ран без
 * user-сообщения и без заранее открытого ответа.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore } from '@kerneldreams/chat-store/pi'
import { NotSupportedError, type AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenChunk, type GenerateFn, type GenerateRequest } from '../src/store-backend.js'

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

function piBackend(generate: GenerateFn) {
  const dir = mkdtempSync(join(tmpdir(), 'store-compact-'))
  const store = createPiStore({ dir, piServiceEntries: 'hide' })
  const backend = createStoreBackend({ store, generate, commands: ['compact'], compaction: store.compaction! })
  return { dir, store, backend }
}

function entries(dir: string): Array<Record<string, unknown>> {
  const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
  return readFileSync(join(dir, file), 'utf-8').trim().split('\n').slice(1).map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('компакция в ране', () => {
  it('перед ответом: узел compaction между user и ответом, событие system; ответ — ребёнок узла', async () => {
    let firstKept = ''
    const { dir, backend } = piBackend(async function* (req: GenerateRequest): AsyncGenerator<GenChunk> {
      firstKept = req.messages[req.messages.length - 1]!.id
      yield { type: 'compaction', summary: 'S1', firstKeptEntryId: firstKept, tokensBefore: 900, details: { readFiles: [], modifiedFiles: [] }, usage: { input: 50, output: 9 } }
      yield { type: 'text', delta: 'ответ' }
    })
    const s = await backend.sessions.create()
    const events = await drain(backend.run(s.id, { userMessage: 'q' }))

    const starts = events.filter((e) => e.type === 'message_start') as Array<{ message: { role: string } }>
    expect(starts.map((e) => e.message.role)).toEqual(['user', 'assistant', 'system'])
    const ends = events.filter((e) => e.type === 'message_end') as Array<{ message: { id: string; role: string; parts: Array<{ type: string; meta?: { hint?: string } }> } }>
    expect(ends.map((e) => e.message.role)).toEqual(['user', 'system', 'assistant'])
    expect(ends[1]!.message.parts[0]).toMatchObject({ type: 'custom', meta: { hint: 'pi.compaction' } })

    const hist = await backend.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    const lines = entries(dir)
    const compaction = lines.find((e) => e.type === 'compaction')!
    expect(compaction).toMatchObject({ summary: 'S1', firstKeptEntryId: firstKept, tokensBefore: 900 })
    const answer = lines.find((e) => e.type === 'message' && (e.message as { role: string }).role === 'assistant')!
    expect(answer.parentId).toBe(compaction.id)
  })

  it('/compact: ран команды без user-сообщения, без пустого ответа; generate видит command', async () => {
    let seen: GenerateRequest['command']
    const chat = piBackend(async function* (req) {
      seen = req.command
      if (!req.command) {
        yield { type: 'text', delta: 'a' }
        return
      }
      yield { type: 'compaction', summary: 'S', firstKeptEntryId: req.messages.at(-1)!.id, tokensBefore: 10 }
    })
    const caps = await chat.backend.capabilities()
    expect(caps.run).toEqual({ continue: true, vars: true, commands: ['compact'] })
    const s = await chat.backend.sessions.create()
    await drain(chat.backend.run(s.id, { userMessage: 'q' }))
    const events = await drain(chat.backend.run(s.id, { command: { name: 'compact', args: 'про тесты' } }))
    expect(seen).toEqual({ name: 'compact', args: 'про тесты' })
    expect((events.filter((e) => e.type === 'message_start') as Array<{ message: { role: string } }>).map((e) => e.message.role)).toEqual(['system'])
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const hist = await chat.backend.history(s.id)
    expect(hist.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system'])
  })

  it('незаявленная команда — not_supported до run_start; с репликой — bad_request', async () => {
    const { backend } = piBackend(async function* () {})
    const s = await backend.sessions.create()
    await expect(drain(backend.run(s.id, { command: { name: 'nope' } }))).rejects.toBeInstanceOf(NotSupportedError)
    await expect(drain(backend.run(s.id, { command: { name: 'compact' }, userMessage: 'x' }))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('без опции compaction чанк пропускается; без commands — capability нет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-compact-'))
    const store = createPiStore({ dir })
    const backend = createStoreBackend({
      store,
      generate: async function* () {
        yield { type: 'compaction', summary: 'S', firstKeptEntryId: 'x', tokensBefore: 1 }
        yield { type: 'text', delta: 'ok' }
      },
    })
    expect((await backend.capabilities()).run).toEqual({ continue: true, vars: true })
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    expect((await backend.history(s.id)).messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('чанк recipe: system рецепта — то, что ушло модели (опция prompts); без опции — пропуск', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-recipe-'))
    const store = createPiStore({ dir, piServiceEntries: 'hide' })
    const backend = createStoreBackend({
      store,
      prompts: true,
      generate: async function* () {
        yield { type: 'recipe', system: 'профиль\n\n<available_skills>…</available_skills>' }
        yield { type: 'text', delta: 'ok' }
      },
    })
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    const answer = (await backend.history(s.id)).messages.at(-1)!
    const view = await backend.messages!.prompt!(s.id, answer.id)
    expect(view.system).toContain('<available_skills>')
  })

  it('чанк recipe.mds — effectivePrompt меты (последний ран, ABC-235); patch его не пишет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-mds-'))
    const store = createPiStore({ dir, piServiceEntries: 'hide' })
    let n = 0
    const backend = createStoreBackend({
      store,
      generate: async function* () {
        yield { type: 'recipe', system: 'S', mds: `%meta {model: 'm'}\n%system {source: 'agent.pre'}\nS${++n}\n` }
        yield { type: 'text', delta: 'ok' }
      },
    })
    const s = await backend.sessions.create()
    expect((await backend.meta!.get(s.id)).effectivePrompt).toBeUndefined()
    await drain(backend.run(s.id, { userMessage: 'q' }))
    await drain(backend.run(s.id, { userMessage: 'q2' }))
    expect((await backend.meta!.get(s.id)).effectivePrompt).toContain('S2')
    await backend.meta!.patch(s.id, { notes: 'x' })
    expect((await backend.meta!.get(s.id)).effectivePrompt).toContain('S2')
  })
})
