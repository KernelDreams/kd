// Block filtering по глубине + ось видимости (§4).
//
// Порядок жёсткий: сначала видимость, потом глубина. Assembler получает уже
// отфильтрованные blocks[] — политика живёт здесь, не в шаблоне.
//
// | Глубина                  | text | thinking | tool_use/result   | summary        |
// |--------------------------|------|----------|-------------------|----------------|
// | recent (< N)             |  ✓   |    ✓     |         ✓         |       —        |
// | middle (N..M)            |  ✓   |    —     | $ctx-tools-in-mid |       —        |
// | old (> M)                |  ✓   |    —     |         —         | заменяет text  |
// | $frozen                  |  ✓   |    ✓     |         ✓         |       —        |
//
// usage / embedding / annotation — никогда. Это аналитика, не контекст.

import type { ContentBlock } from '../message-model.js'
import { blockVisibility, type Visibility } from './model.js'

/** Никогда не уезжает в модель — мета/аналитика. */
const NEVER = new Set(['usage', 'embedding', 'annotation'])

const TOOL_TYPES = new Set(['tool_use', 'tool_result'])

export type Depth = 'recent' | 'middle' | 'old'

export function depthOf(distance: number, recentDepth: number, summaryDepth: number): Depth {
  if (distance < recentDepth) return 'recent'
  if (distance < summaryDepth) return 'middle'
  return 'old'
}

export interface FilterOptions {
  depth: Depth
  frozen: boolean
  toolsInMiddle: boolean
  /** Видимость сообщения — блоки наследуют её, если своей не объявили. */
  inherited: Visibility
}

/** Блок уезжает в модель? */
function keepBlock(b: ContentBlock, o: FilterOptions): boolean {
  if (NEVER.has(b.type)) return false
  if (b.type === 'summary') return false // потребляется движком, не отправляется
  if (o.frozen || o.depth === 'recent') return true
  if (b.type === 'thinking') return false // дорогой; выбрасывается первым
  if (TOOL_TYPES.has(b.type)) return o.depth === 'middle' && o.toolsInMiddle
  return true
}

/** Виден модели? `ui` — нет (стат-панель, инвентарь: модель начнёт имитировать). */
export function visibleToModel(v: Visibility): boolean {
  return v !== 'ui'
}

/**
 * Отфильтровать блоки сообщения: сначала видимость, потом глубина.
 * `summaryText` (если есть и сообщение old) заменяет text-блоки целиком.
 */
export function filterBlocks(
  blocks: ContentBlock[],
  o: FilterOptions,
  summaryText?: string,
): { blocks: ContentBlock[]; replacedBySummary: boolean } {
  const visible = blocks.filter((b) => visibleToModel(blockVisibility(b, o.inherited)))

  if (!o.frozen && o.depth === 'old' && summaryText) {
    const kept = visible.filter((b) => b.type !== 'text' && keepBlock(b, o))
    return {
      blocks: [{ type: 'text', attrs: {}, body: summaryText }, ...kept],
      replacedBySummary: true,
    }
  }

  return { blocks: visible.filter((b) => keepBlock(b, o)), replacedBySummary: false }
}
