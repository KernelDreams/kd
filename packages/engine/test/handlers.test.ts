import { describe, it, expect } from 'vitest'
import { toHistory } from '@kerneldreams/chat-store'
import { ChatHandler } from '../src/handlers/chat.js'
import { RawHandler } from '../src/handlers/raw.js'
import { ExtractHandler } from '../src/handlers/extract.js'
import type { EngineResponse, EngineConfig, HandlerTarget } from '../src/types.js'
import { memSession } from './helpers.js'

const cfg: EngineConfig = { model: 'x' }

function resp(text: string): EngineResponse {
  return {
    content: [{ type: 'text', attrs: {}, body: text }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 2 },
  }
}

async function target(assistantId = 'aaaaaa'): Promise<HandlerTarget> {
  const { store, sid } = await memSession()
  return { store, sessionId: sid, assistantId }
}

describe('RawHandler', () => {
  it('returns text, saves nothing', async () => {
    const t = await target()
    const r = await new RawHandler().handle(resp('the answer'), t, cfg)
    expect(r.output).toBe('the answer')
    const model = await t.store.load(t.sessionId)
    expect(model.nodes).toHaveLength(0)
  })
})

describe('ChatHandler', () => {
  it('appends the assistant turn under the id-first id and returns its text', async () => {
    const t = await target('weruka')
    const r = await new ChatHandler().handle(resp('hello'), t, cfg)
    expect(r.output).toBe('hello')
    const model = await t.store.load(t.sessionId)
    expect(model.nodes).toHaveLength(1)
    expect(model.nodes[0]!.id).toBe('weruka')
    expect(model.nodes[0]!.role).toBe('assistant')
  })

  it('persists thinking parts (round-trips through the store)', async () => {
    const t = await target()
    const response: EngineResponse = {
      content: [
        { type: 'thinking', attrs: {}, body: 'reasoning' },
        { type: 'text', attrs: {}, body: 'final' },
      ],
      stopReason: 'end_turn',
    }
    await new ChatHandler().handle(response, t, cfg)
    const stored = toHistory(await t.store.load(t.sessionId)).at(-1)!
    expect(stored.parts.map((p) => p.type)).toEqual(['thinking', 'text'])
  })

  it('does not append an empty (cancelled) response', async () => {
    const t = await target()
    await new ChatHandler().handle({ content: [], stopReason: 'cancelled' }, t, cfg)
    const model = await t.store.load(t.sessionId)
    expect(model.nodes).toHaveLength(0)
  })
})

describe('ExtractHandler', () => {
  it('pulls a JSON object out of the text', async () => {
    const t = await target()
    const r = await new ExtractHandler().handle(resp('here you go: {"score": 9, "ok": true} done'), t, cfg)
    expect(r.artifacts?.data).toEqual({ score: 9, ok: true })
  })
})
