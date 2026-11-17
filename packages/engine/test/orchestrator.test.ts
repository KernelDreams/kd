import { describe, it, expect } from 'vitest'
import { SimpleOrchestrator } from '../src/orchestrators/simple.js'
import type { StreamEvent, LLMMessage } from '../src/types.js'
import { fakeProvider } from './helpers.js'

const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]

describe('SimpleOrchestrator', () => {
  it('assembles text + thinking blocks and reports usage', async () => {
    const provider = fakeProvider([
      { type: 'thinking', text: 'reasoning' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo!' },
      { type: 'done', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } },
    ])
    const orch = new SimpleOrchestrator({ model: 'fake' })
    const res = await orch.execute(messages, provider, [])

    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ input: 3, output: 4 })
    expect(res.content.map((b) => b.type)).toEqual(['thinking', 'text'])
    expect(res.content.find((b) => b.type === 'text')!.body).toBe('Hello!')
  })

  it('emits typed stream events through hooks', async () => {
    const provider = fakeProvider([
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'Hi' },
      { type: 'done', stop_reason: 'end_turn' },
    ])
    const events: StreamEvent[] = []
    const orch = new SimpleOrchestrator({ model: 'fake' })
    await orch.execute(messages, provider, [{ onEvent: (e) => events.push(e) }])

    expect(events).toContainEqual({ type: 'thinking_delta', text: 'hmm' })
    expect(events).toContainEqual({ type: 'delta', text: 'Hi' })
  })

  it('applies beforeRequest / afterResponse hooks', async () => {
    const provider = fakeProvider([{ type: 'text', text: 'x' }, { type: 'done', stop_reason: 'end_turn' }])
    const orch = new SimpleOrchestrator({ model: 'fake' })
    const res = await orch.execute(messages, provider, [
      {
        beforeRequest: (req) => ({ ...req, temperature: 0.9 }),
        afterResponse: (r) => ({ ...r, stopReason: 'patched' }),
      },
    ])
    expect(provider.lastRequest?.temperature).toBe(0.9)
    expect(res.stopReason).toBe('patched')
  })

  it('abort mid-stream discards the partial answer', async () => {
    const provider = fakeProvider([
      { type: 'text', text: 'part' },
      { type: 'text', text: 'ial' },
      { type: 'done', stop_reason: 'end_turn' },
    ])
    const orch = new SimpleOrchestrator({ model: 'fake' })
    // Abort as soon as the first delta arrives; the loop breaks next iteration.
    const res = await orch.execute(messages, provider, [
      { onEvent: (e) => { if (e.type === 'delta') orch.abort() } },
    ])
    expect(res.stopReason).toBe('cancelled')
    expect(res.content).toHaveLength(0)
  })
})
