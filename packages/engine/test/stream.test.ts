import { describe, it, expect } from 'vitest'
import { serializeEvent, parseEvent, parseNDJSON, ndjsonWriter } from '../src/stream.js'
import type { StreamEvent } from '../src/types.js'

describe('NDJSON StreamEvent serialization', () => {
  const events: StreamEvent[] = [
    { type: 'user_appended', message: { id: 'pos:0', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, nodeId: 'pos:0' },
    { type: 'delta', text: 'Hel' },
    { type: 'delta', text: 'lo!' },
    { type: 'thinking_delta', text: 'reasoning' },
    { type: 'done', message: { id: 'pos:1', role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] }, nodeId: 'pos:1', version: 'abc123' },
  ]

  it('round-trips each event', () => {
    for (const e of events) {
      expect(parseEvent(serializeEvent(e))).toEqual(e)
    }
  })

  it('parses a full NDJSON document', () => {
    const doc = events.map(serializeEvent).join('\n') + '\n'
    expect(parseNDJSON(doc)).toEqual(events)
  })

  it('ndjsonWriter emits one line per event', () => {
    const lines: string[] = []
    const write = ndjsonWriter((c) => lines.push(c))
    write({ type: 'delta', text: 'x' })
    expect(lines).toEqual(['{"type":"delta","text":"x"}\n'])
  })
})
