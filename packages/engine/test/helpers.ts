// Test helpers: an in-memory fake LLMProvider (no network) + a memory store.

import type { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from '@kerneldreams/nrd/web'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { Message, MessageFlags, Part, SessionStore } from '@kerneldreams/chat-store'

/** A memory store + a fresh session id (replaces the old MemorySession in tests). */
export async function memSession(): Promise<{ store: SessionStore; sid: string }> {
  const store = createMemoryStore()
  const { id } = await store.create({})
  return { store, sid: id }
}

/** Build a store `Message` from role + text (or parts) + flags — for assembler tests. */
export function msg(
  role: string,
  body: string | Part[],
  extra: { flags?: MessageFlags; name?: string; id?: string } = {},
): Message {
  const parts: Part[] = typeof body === 'string' ? [{ type: 'text', text: body }] : body
  const m: Message = { id: extra.id ?? '', role, parts }
  if (extra.flags) m.flags = extra.flags
  if (extra.name) m.name = extra.name
  return m
}

/** A provider that replays a fixed chunk script for stream(). */
export function fakeProvider(chunks: LLMChunk[]): LLMProvider & { lastRequest?: LLMRequest } {
  const p: LLMProvider & { lastRequest?: LLMRequest } = {
    async chat(req: LLMRequest) {
      p.lastRequest = req
      const text = chunks
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      const value: LLMResponse = { content: text, stop_reason: 'end_turn' }
      return { ok: true as const, value }
    },
    async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
      p.lastRequest = req
      for (const c of chunks) yield c
    },
  }
  return p
}

/** Build a text+done chunk script from a final string. */
export function textChunks(text: string, usage = { input_tokens: 5, output_tokens: 7 }): LLMChunk[] {
  return [
    { type: 'text', text },
    { type: 'done', stop_reason: 'end_turn', usage },
  ]
}
