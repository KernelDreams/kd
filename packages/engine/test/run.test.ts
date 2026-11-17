import { describe, it, expect } from 'vitest'
import { toHistory } from '@kerneldreams/chat-store'
import { run } from '../src/run.js'
import type { StreamEvent } from '../src/types.js'
import { fakeProvider, textChunks, memSession } from './helpers.js'

describe('run() integration (no network, memory store)', () => {
  it('memory store + DirectAssembler + SimpleOrchestrator + RawHandler', async () => {
    const { store, sid } = await memSession()
    const provider = fakeProvider(textChunks('4'))
    const result = await run(
      { assembly: 'direct', orchestrator: 'simple', handler: 'raw', model: 'fake' },
      {
        target: { store, sessionId: sid },
        systemPrompt: 'You are a calculator. Output only the number.',
        userMessage: '2 + 2 = ?',
        provider,
      },
    )
    expect(result.output).toBe('4')
    // The assembled prompt reached the provider: system + user.
    expect(provider.lastRequest?.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('dry command returns the assembled prompt without calling the provider', async () => {
    const { store, sid } = await memSession()
    const provider = fakeProvider(textChunks('should-not-appear'))
    const result = await run(
      { handler: 'raw', orchestrator: 'simple', model: 'fake', cmd: 'dry' },
      { target: { store, sessionId: sid }, systemPrompt: 'sys', userMessage: 'hi', provider },
    )
    expect(result.output).toContain('%system')
    expect(result.output).toContain('hi')
    expect(provider.lastRequest).toBeUndefined()
  })

  it('ChatHandler appends the reply and emits typed events', async () => {
    const { store, sid } = await memSession()
    const events: StreamEvent[] = []
    const result = await run(
      { assembly: 'direct', orchestrator: 'simple', handler: 'chat', model: 'fake' },
      {
        target: { store, sessionId: sid },
        userMessage: 'hi',
        provider: fakeProvider(textChunks('hello back')),
        onEvent: (e) => events.push(e),
      },
    )
    expect(result.output).toBe('hello back')
    expect(events.find((e) => e.type === 'user_appended')).toBeTruthy()
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeTruthy()
    if (done?.type === 'done') {
      expect(done.version).toBeTruthy()
      expect(done.message.role).toBe('assistant')
      expect(done.nodeId).toBe(done.message.id)
    }

    // Persisted: user + assistant, id-first (event nodeId == stored id).
    const model = await store.load(sid)
    expect(toHistory(model).map((m) => m.role)).toEqual(['user', 'assistant'])
    if (done?.type === 'done') expect(model.nodes.some((n) => n.id === done.nodeId)).toBe(true)
  })
})
