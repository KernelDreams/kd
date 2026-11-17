// Конфиг движка — данные, не TS-объект (решение №2).
//
// Все настройки живут атрибутами `$ctx-*` в обычном каскаде IContext
// (CLI > сессия > карточка > конфиг). Отдельных конфиг-файлов у движка нет.
// readEngineConfig — единственная точка чтения; дальше движок работает с
// типизированным EngineCtxConfig.

import { asText } from '@kerneldreams/nrd'
import type { IContext, Value } from '@kerneldreams/nrd'
import type { EngineCtxConfig } from './types.js'

/**
 * Дефолт context window, когда `$ctx-max-tokens` не задан и модель неизвестна.
 * Осознанно большой: ложный дроп истории хуже, чем незамеченный overflow —
 * провайдер об overflow скажет, а молча потерянное сообщение не заметит никто.
 */
export const DEFAULT_MAX_TOKENS = 128_000

export const CTX_DEFAULTS: EngineCtxConfig = {
  maxTokens: DEFAULT_MAX_TOKENS,
  reserveOutput: 1024,
  recentDepth: 5,
  summaryDepth: 30,
  toolsInMiddle: false,
  cardScore: 10_000,
  historyScore: 1_000,
  summaryScore: 500,
  collapsedScore: 750,
  examplesScore: 100,
  scanDepth: 10,
  lorebooks: [],
}

function num(ctx: IContext, key: string, fallback: number): number {
  const v = ctx.get([key])
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = asText(v)
  if (t !== undefined && t.trim() !== '' && !Number.isNaN(Number(t))) return Number(t)
  return fallback
}

function bool(ctx: IContext, key: string, fallback: boolean): boolean {
  const v = ctx.get([key])
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** name-list: `$[a, b]` (массив) или `a, b` (строка). */
export function nameList(v: Value): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  const arr = v as { iterate?: () => Iterable<Value> }
  if (typeof arr.iterate === 'function') {
    return [...arr.iterate()].map((x) => String(asText(x) ?? x).trim()).filter(Boolean)
  }
  return String(asText(v) ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** Прочитать `$ctx-*` из цепочки вызывающего. Единственная точка чтения (§2). */
export function readEngineConfig(ctx: IContext): EngineCtxConfig {
  return {
    maxTokens: num(ctx, 'ctx-max-tokens', CTX_DEFAULTS.maxTokens),
    reserveOutput: num(ctx, 'ctx-reserve-output', CTX_DEFAULTS.reserveOutput),
    recentDepth: num(ctx, 'ctx-recent-depth', CTX_DEFAULTS.recentDepth),
    summaryDepth: num(ctx, 'ctx-summary-depth', CTX_DEFAULTS.summaryDepth),
    toolsInMiddle: bool(ctx, 'ctx-tools-in-middle', CTX_DEFAULTS.toolsInMiddle),
    cardScore: num(ctx, 'ctx-card-score', CTX_DEFAULTS.cardScore),
    historyScore: num(ctx, 'ctx-history-score', CTX_DEFAULTS.historyScore),
    summaryScore: num(ctx, 'ctx-summary-score', CTX_DEFAULTS.summaryScore),
    collapsedScore: num(ctx, 'ctx-collapsed-score', CTX_DEFAULTS.collapsedScore),
    examplesScore: num(ctx, 'ctx-examples-score', CTX_DEFAULTS.examplesScore),
    scanDepth: num(ctx, 'ctx-scan-depth', CTX_DEFAULTS.scanDepth),
    lorebooks: nameList(ctx.get(['lorebooks'])),
  }
}
