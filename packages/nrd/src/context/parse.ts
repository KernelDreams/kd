// Parse форматы (§4.5). Сырые данные → IContext по `$nr-parse`.

import {
  objectContext,
  parseDocument,
  resolveValue,
  walk,
  chainContext,
  contextToString,
} from '../core/index.js'
import type { IContext, Segment, Value } from '../contracts/index.js'

export type ParseMode = 'text' | 'json' | 'mdd' | 'mdz'

/** Закрытый набор режимов (§4.5). Реестр кодеков — ронять на неизвестном имени. */
export const PARSE_MODES: readonly ParseMode[] = ['text', 'json', 'mdd', 'mdz']

const LENIENT = { mode: 'lenient' } as const
/** Значение документа отдаётся в контекст — opt-out `\${` жив до выхода резолвера (§3.1). */
const LENIENT_RAW = { mode: 'lenient', keepOptOut: true } as const

/**
 * Нормализовать значение `$nr-parse` к известному режиму.
 *
 * Отсутствующее / пустое значение → `text` (легально, §3.3). Неизвестное имя —
 * **громкая ошибка**: молчаливый фолбэк в `text` превращал `$nr-parse: ccv3`
 * в строку и прятал опечатку (DEBT 23.07).
 */
export function parseMode(v: unknown, where?: string): ParseMode {
  if (v === undefined || v === null) return 'text'
  const s = String(v).trim().toLowerCase()
  if (s === '') return 'text'
  if ((PARSE_MODES as readonly string[]).includes(s)) return s as ParseMode
  const at = where ? ` (${where})` : ''
  throw new Error(
    `nrd-context: неизвестный $nr-parse: "${String(v)}"${at} — известные: ${PARSE_MODES.join(' | ')}`,
  )
}

function isInterpolated(v: unknown): v is { raw: string; placeholders: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { raw?: unknown }).raw === 'string' &&
    Array.isArray((v as { placeholders?: unknown }).placeholders)
  )
}

/**
 * Разобранный документ + внешняя цепочка → контекст, чьи значения резолвятся
 * ЛЕНИВО, при доступе (resolve-fix §1.3).
 *
 * Без этого `${}` в ТЕЛЕ источника (`parse: mdd|mdz`) не резолвился вообще:
 * `parseDocument` отдаёт InterpolatedValue, документ видит только себя, и
 * значение утекало наружу объектом (`String(v)` → `[object Object]`) — молча.
 * Атрибутная форма того же плагина при этом резолвилась нормально; инвариант
 * «обе формы дают одинаковый результат» и восстанавливается здесь.
 *
 * Резолв идёт об `chain(сам документ, внешняя цепочка)`: собственные ключи
 * сильнее внешних, как и у корневых атрибутов. Значение целиком из плейсхолдера
 * остаётся деревом (§1.6) — за это отвечает `resolveValue`.
 */
function resolvingContext(inner: IContext, external: IContext): IContext {
  const scope = chainContext(inner, external)
  const unfold = (v: Value | undefined): Value | undefined =>
    isInterpolated(v) ? resolveValue(v.raw, scope, LENIENT_RAW) : v

  return {
    get(path: Segment[]): Value | undefined {
      if (path.length === 0) return undefined
      let cur = unfold(inner.get([path[0]]))
      for (let i = 1; i < path.length; i++) {
        if (cur === undefined || cur === null) return undefined
        cur = unfold(walk(cur, [path[i]], LENIENT))
      }
      return cur
    },
    func: (name: string, args: Value[]) => inner.func(name, args),
    // Касты — сквозные: `text`/`raw`/`records` описывают САМ документ (конверт),
    // а не значение ключа. Тело как payload не резолвится (та же граница, что у
    // тел `fn`/шаблонов в rz).
    cast: (name: string) => inner.cast(name),
    // Текст — по общему правилу (text-cast-spec §2.2), но об ЭТОТ контекст:
    // дамп обязан отдавать резолвнутые значения, а не сырые InterpolatedValue.
    toString(): string {
      return contextToString(this)
    },
  }
}

/**
 * Распарсить сырую строку по режиму:
 * - text → `objectContext({ content })`
 * - json → `JSON.parse` → objectContext (массив/скаляр оборачивается в `{ value }`)
 * - mdd  → parseDocument(sigil '@')
 * - mdz  → parseDocument(sigil '$')
 *
 * `chain` — внешняя цепочка резолва для `${}` внутри разобранного документа
 * (§1.3). Не передана → прежнее поведение: документ резолвится только об себя.
 */
export function parseRaw(raw: string, mode: ParseMode, chain?: IContext): IContext {
  switch (mode) {
    case 'json': {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return objectContext(parsed as Record<string, unknown>)
      }
      return objectContext({ value: parsed })
    }
    case 'mdd': {
      const doc = parseDocument(raw, { sigil: '@' })
      return chain ? resolvingContext(doc, chain) : doc
    }
    case 'mdz': {
      const doc = parseDocument(raw, { sigil: '$' })
      return chain ? resolvingContext(doc, chain) : doc
    }
    case 'text':
    default:
      return objectContext({ content: raw })
  }
}
