// Part ⇄ ContentBlock bridge (spec §3.3, §3.4).
//
// The store model speaks typed `Part`s; the orchestrator/provider layer speaks
// nrd-core `ContentBlock`s (EngineResponse.content). This module is the single
// mapping table between them, used by the handlers (ContentBlock → Part on
// append) and by the context boundary (Part → ContentBlock for the nrd-core
// context engine). Kept engine-internal — consumers use nr-chat-store directly.

import type { Value } from '@kerneldreams/nrd'
import type { ContentBlock } from './message-model.js'
import type { Message, Part, StoreNode } from '@kerneldreams/chat-store'

function safeParse(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {}
  } catch {
    return json
  }
}

/** Plain-text view of nrd-core blocks (stdout / DTO content). */
export function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.body)
    .join('\n')
    .trim()
}

/** Concatenated text of a message's text-parts (trimmed). */
export function textFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * ContentBlock → Part (spec §3.4 table): text→text, thinking→thinking,
 * tool_use/tool_result→one-of, everything else→custom (closedness preserved).
 */
export function blocksToParts(blocks: ContentBlock[]): Part[] {
  const parts: Part[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        parts.push({ type: 'text', text: b.body })
        break
      case 'thinking': {
        const part: Part = { type: 'thinking', text: b.body }
        const sig = b.attrs['signature']
        if (typeof sig === 'string') part.meta = { signature: sig }
        parts.push(part)
        break
      }
      case 'tool_use':
        parts.push({
          type: 'tool_use',
          data: safeParse(b.body),
          meta: {
            callId: String(b.attrs['call_id'] ?? b.attrs['id'] ?? ''),
            name: String(b.attrs['name'] ?? ''),
          },
        })
        break
      case 'tool_result': {
        const part: Part = {
          type: 'tool_result',
          text: b.body,
          meta: { callId: String(b.attrs['call_id'] ?? b.attrs['id'] ?? ''), error: b.attrs['error'] === true },
        }
        parts.push(part)
        break
      }
      default:
        parts.push({ type: 'custom', text: b.body, meta: { hint: `block.${b.type}`, attrs: b.attrs } })
    }
  }
  return parts
}

/** Part → ContentBlock (inverse of {@link blocksToParts}), for the nrd-core context engine. */
export function partsToBlocks(parts: Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        blocks.push({ type: 'text', attrs: {}, body: p.text })
        break
      case 'thinking': {
        const attrs: Record<string, Value> = {}
        if (p.meta?.signature) attrs['signature'] = p.meta.signature
        blocks.push({ type: 'thinking', attrs, body: p.text })
        break
      }
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          attrs: { name: p.meta.name, call_id: p.meta.callId },
          body: typeof p.data === 'string' ? p.data : JSON.stringify(p.data ?? {}),
        })
        break
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          attrs: { call_id: p.meta.callId, ...(p.meta.error ? { error: true } : {}) },
          body: p.text ?? (p.data !== undefined ? JSON.stringify(p.data) : ''),
        })
        break
      case 'file':
      case 'image':
      case 'error':
        blocks.push({ type: 'text', attrs: {}, body: p.text ?? '' })
        break
      case 'custom': {
        const attrs = (p.meta as { attrs?: Record<string, Value> }).attrs
        blocks.push({
          type: typeof p.meta.hint === 'string' && p.meta.hint.startsWith('block.') ? p.meta.hint.slice(6) : 'text',
          attrs: attrs && typeof attrs === 'object' ? attrs : {},
          body: p.text ?? (p.data !== undefined ? JSON.stringify(p.data) : ''),
        })
        break
      }
    }
  }
  return blocks
}

/**
 * StoreNode → model Message for stream events. Swipes are computed on demand by
 * the consumer (`swipeInfo`), not carried in every event (spec §3.3), so a
 * fresh node needs no tree here.
 */
export function messageFromNode(node: StoreNode): Message {
  const message: Message = { id: node.id, role: node.role, parts: node.parts }
  if (node.name !== undefined) message.name = node.name
  if (node.flags && Object.keys(node.flags).length) message.flags = node.flags
  return message
}
