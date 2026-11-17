// Context-engine message model (internal).
//
// The context engine keeps working on nrd-core `Message`/`ContentBlock`: a
// well-tested subsystem whose scoring/filtering reads `$visibility`, `%summary`,
// `$collapsed` etc. — concepts the store's flat model doesn't (yet) carry. Rather
// than rewrite it onto `Part`s, the amputation converts the store's `Message` to
// nrd-core at THIS one boundary (`storeToNrd`); the engine stays as-is downstream.
//
// These accessors moved here verbatim from the (now deleted) public `messages.ts`
// — they are the engine's private business, not an exported message API.

import type { Value } from '@kerneldreams/nrd'
import type { Message as NrdMessage, ContentBlock } from '../message-model.js'
import type { Message as StoreMessage } from '@kerneldreams/chat-store'
import { partsToBlocks } from '../parts.js'

/** Block types consumed by the engine, never sent to the API. */
export const META_TYPES = new Set(['summary', 'usage', 'embedding'])

/** Куда едет сообщение/блок: в контекст модели, в UI, или туда и туда. */
export type Visibility = 'model' | 'ui' | 'both'

/** Concatenated text of all `text` blocks (trimmed). */
export function msgText(m: NrdMessage): string {
  return m.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.body)
    .join('\n')
    .trim()
}

export function isHidden(m: NrdMessage): boolean {
  return m.attrs['hidden'] === true
}

export function isFrozen(m: NrdMessage): boolean {
  return m.attrs['frozen'] === true
}

export function isInjected(m: NrdMessage): boolean {
  return m.attrs['injected'] === true
}

/** %system messages flagged $post land after history, just before generation. */
export function isPost(m: NrdMessage): boolean {
  return m.attrs['post'] === true
}

/**
 * `$collapsed: id` — сообщение-ссылка на свёрнутый диапазон (session-format §5).
 * Тело ссылки = summary; полный контент лежит в блоке `## $collapsed <id>`.
 */
export function msgCollapsed(m: NrdMessage): string | undefined {
  const v = m.attrs['collapsed']
  return typeof v === 'string' && v !== '' ? v : undefined
}

function asVisibility(v: Value): Visibility | undefined {
  return v === 'model' || v === 'ui' || v === 'both' ? v : undefined
}

/** `$visibility` сообщения (context-engine-spec §4). Дефолт — `both`. */
export function msgVisibility(m: NrdMessage): Visibility {
  return asVisibility(m.attrs['visibility']) ?? 'both'
}

/** `$visibility` контент-блока. Наследует видимость сообщения, если не задан. */
export function blockVisibility(b: ContentBlock, inherited: Visibility = 'both'): Visibility {
  return asVisibility(b.attrs['visibility']) ?? inherited
}

/** `````%summary`-блок сообщения (message-format-spec §3.2), если есть. */
export function msgSummary(m: NrdMessage): string | undefined {
  const b = m.blocks.find((x) => x.type === 'summary')
  const body = b?.body.trim()
  return body ? body : undefined
}

/**
 * Store `Message` → nrd-core `Message`: the amputation boundary. Flags become
 * `$`-attrs (`hidden`/`frozen`/`injected`), id/name become attrs, parts become
 * blocks. `$visibility`/`%summary`/`$collapsed` have no store home yet, so they
 * stay dormant (parity: they'd only fire if a node carried them).
 */
export function storeToNrd(m: StoreMessage): NrdMessage {
  const attrs: Record<string, Value> = {}
  if (m.id) attrs['id'] = m.id
  if (typeof m.name === 'string') attrs['name'] = m.name
  if (m.flags?.hidden) attrs['hidden'] = true
  if (m.flags?.frozen) attrs['frozen'] = true
  if (m.flags?.injected) attrs['injected'] = true
  return { role: m.role, attrs, blocks: partsToBlocks(m.parts) }
}
