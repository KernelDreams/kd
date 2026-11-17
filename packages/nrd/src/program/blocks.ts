/**
 * Работа с деревом блоков: атрибуты → значения, тело → текст, корень → params.
 *
 * Порт логики `readBlockAttrs` из слоя сборки контекста (тот же контракт:
 * значения резолвятся против ctx, `$body`/`$name` — зарезервированные слоты,
 * декларация нормализуется до плоской `nr-*`). Программному слою она нужна для
 * блоков, которых сборка контекста не трогает (`fn`, `template`, данные).
 */

import { resolve } from '../core/index.js'
import { normalizeNrAttrs } from '../context/index.js'
import type { IContext, Value } from '../core/index.js'
import type { Block, AttributeValue, BodyValue } from '../md/index.js'

export const ATTR_BODY = '$body'
export const ATTR_NAME = '$name'

/**
 * AttributeValue → плоское значение; InterpolatedValue резолвится об ctx.
 *
 * Значение ложится обратно в контекст — это ещё рекурсия, не выход: opt-out
 * `\${` остаётся живым (`keepOptOut`), сворачивают его только выходы резолвера
 * (`resolve`/`resolveValue`/`get`). Иначе `$u: a \${b} c` хранился бы как
 * `a ${b} c`, и `${u}` подставлял бы `b` (engine-spec §3.1). Та же
 * форма, что у quoted-значения `"a \\${b} c"`.
 */
export function attrToValue(v: AttributeValue, ctx: IContext): Value {
  if (v === null || typeof v !== 'object') return v as Value
  if (Array.isArray(v)) return v.map((item) => attrToValue(item as AttributeValue, ctx)) as Value
  if ('raw' in v) return resolve((v as { raw: string }).raw, ctx, KEEP_OPT_OUT)
  return v as Value
}

const KEEP_OPT_OUT = { keepOptOut: true } as const

/**
 * Текст тела блока — сырой, без резолва `${}`.
 *
 * Тело — payload (код `fn`, шаблон, чужой формат), а не значение: подставлять в
 * него хостовые `${}` значило бы интерпретировать содержимое конверта («конверт
 * vs содержимое»). Декларации живут в атрибутах, они и резолвятся.
 */
export function bodyText(b: BodyValue | undefined): string {
  if (b === undefined) return ''
  return typeof b === 'string' ? b : b.raw
}

/**
 * Снять обрамляющий фенс с тела. Тело в mdz обычно завёрнуто в ```` ```ts ````,
 * а в mds фенс из 4+ бэктиков — единственный способ спрятать от сканера ленты
 * чужие `%`-строки (чат-разметка внутри шаблона). В обоих случаях payload — то,
 * что внутри.
 */
export function stripFence(text: string): string {
  const lines = text.split('\n')
  if (!lines[0]?.match(/^`{3,}[\w-]*\s*$/)) return text
  const open = lines[0].match(/^`+/)![0].length
  const lastIdx = lines.length - 1
  const close = lines[lastIdx]?.match(/^(`{3,})\s*$/)
  if (!close || close[1].length < open) return text
  return lines.slice(1, lastIdx).join('\n')
}

/** Атрибуты блока → Record; декларация сведена к плоской `nr-*`. */
export function readBlockAttrs(block: Block, ctx: IContext): Record<string, Value> {
  const raw: Record<string, Value> = {}
  for (const a of block.attrs) {
    raw[a.key.join('.')] = attrToValue(a.value, ctx) // last-wins
  }
  const out = normalizeNrAttrs(raw)
  out[ATTR_BODY] = bodyText(block.body)
  out[ATTR_NAME] = block.id ?? block.name
  return out
}

/** Корневые атрибуты документа как params (без служебных слотов). */
export function rootParams(root: Block, ctx: IContext): Record<string, Value> {
  const raw: Record<string, Value> = {}
  for (const a of root.attrs) {
    raw[a.key.join('.')] = attrToValue(a.value, ctx)
  }
  return normalizeNrAttrs(raw)
}
