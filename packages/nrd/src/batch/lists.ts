// Тело блока-оси → точки (batch-spec §1, §2.1).
//
// Переехало из comfy/lib/prompts.ts без изменения поведения списков: метка
// `value // label`, комментарии, диапазон `a..b/step`, фенс = одно значение.
// Новое — ось-таблица: тело tbl, строка = точка со своими колонками.

import { coerce, coerceTyped, parseTableRows } from '../md/index.js'
import type { Scalar, TypedColumn } from '../md/index.js'
import type { IArray, Value } from '../core/icontext.js'
import { wrapValue } from '../core/contexts.js'

/** Точка списка: значение и необязательная метка (`value // label`). */
export interface ListEntry {
  value: string
  label?: string
}

/** Точка оси: у таблицы — ещё и значения колонок строки. */
export interface BatchPoint extends ListEntry {
  /** Колонки строки таблицы (кроме `label`) — простые переменные точки. */
  vars?: Record<string, Value>
}

/** Разобранное тело блока. */
export type AxisBody =
  | { kind: 'fenced'; value: string }
  | { kind: 'list'; points: BatchPoint[] }
  | { kind: 'table'; columns: string[]; points: BatchPoint[] }

// Декоративные строки тела: `//`, `#`, `*`, `` ` `` (как в ядре) плюс
// конвенции comfy — `---` и «закомментированный атрибут» `$//`.
const COMMENT_PREFIXES = ['//', '#', '*', '`', '---', '$//']

function isComment(line: string): boolean {
  return COMMENT_PREFIXES.some((p) => line.startsWith(p))
}

/** Значимые строки тела: обрезанные, без пустых и комментариев. */
function significant(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isComment(l))
}

/** Диапазон `start..end/step` → числа строками (точность — по знакам шага). */
export function parseRange(line: string): string[] | null {
  const m = line.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (!m) return null

  const start = parseFloat(m[1])
  const end = parseFloat(m[2])
  const step = parseFloat(m[3])
  if (step <= 0 || !Number.isFinite(start) || !Number.isFinite(end)) return null

  const stepStr = m[3]
  const dotIdx = stepStr.indexOf('.')
  const precision = dotIdx >= 0 ? stepStr.length - dotIdx - 1 : 0

  const values: string[] = []
  const direction = end >= start ? 1 : -1
  for (let v = start; direction > 0 ? v <= end + step / 100 : v >= end - step / 100; v += step * direction) {
    const rounded = parseFloat(v.toFixed(precision))
    if (direction > 0 ? rounded > end : rounded < end) break
    values.push(precision > 0 ? rounded.toFixed(precision) : String(rounded))
  }
  return values
}

/** Тело в ```-фенсе → его содержимое (одно многострочное значение); иначе null. */
export function extractFencedBlock(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return null
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return null
  const lastFence = trimmed.lastIndexOf('```')
  if (lastFence <= 0 || lastFence === trimmed.indexOf('```')) return null
  return trimmed.slice(firstNewline + 1, lastFence).trim()
}

/** Тело-список → точки: комментарии пропускаются, `// label`, диапазоны. */
export function parseList(text: string): ListEntry[] {
  const entries: ListEntry[] = []
  for (const line of significant(text)) {
    const labelMatch = line.match(/\s+\/\/\s*(.+)$/)
    const clean = labelMatch ? line.slice(0, line.length - labelMatch[0].length).trim() : line
    const label = labelMatch ? labelMatch[1].trim() : undefined

    // Диапазон разворачивает строку во много точек с общей меткой.
    const range = parseRange(clean)
    if (range) {
      for (const v of range) entries.push(label === undefined ? { value: v } : { value: v, label })
    } else {
      entries.push(label === undefined ? { value: clean } : { value: clean, label })
    }
  }
  return entries
}

/** Ячейка-список: значение-массив, в `${}` склеивается через `, `. */
function cellList(items: Scalar[]): IArray {
  const texts = items.map((x) => (x === null ? '' : String(x)))
  return {
    length: () => items.length,
    at: (i: number) => wrapValue(items[i] as Value),
    iterate: () => items as Value[],
    cast: (name: string): any => (name === 'text' ? texts.join(', ') : undefined),
    toString: () => texts.join(', '),
  }
}

/** Ячейка → значение переменной: нетипизированная — строкой (без коэрсии в число). */
function cellValue(raw: string, col: TypedColumn): Value {
  if (col.type) {
    const v = coerceTyped(raw, col)
    if (Array.isArray(v)) return cellList(v)
    return v === null ? '' : v
  }
  if (col.required && raw === '') coerceTyped(raw, col) // бросит TableParseError
  const v = coerce(raw)
  return typeof v === 'string' ? v : raw
}

function cellText(v: Value | undefined): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return String(v)
  return String(v)
}

/**
 * Тело блока → оси/значение.
 *
 * - фенс → одно значение;
 * - первая значимая строка с `|` и у всех строк то же число ячеек → таблица;
 *   несовпадение → список + предупреждение (строка с `|` в промпте не должна
 *   внезапно стать таблицей);
 * - иначе — список. Пустое тело → null.
 */
export function parseAxisBody(text: string, warn?: (msg: string) => void, name = '?'): AxisBody | null {
  const fenced = extractFencedBlock(text)
  if (fenced !== null) return { kind: 'fenced', value: fenced }

  const lines = significant(text)
  if (lines.length === 0) return null

  if (lines.length > 1 && lines[0].includes('|')) {
    const { columns, rows } = parseTableRows(lines.join('\n'))
    const bad = rows.findIndex((r) => r.length !== columns.length)
    if (bad < 0 && rows.length > 0) return table(columns, rows)
    if (bad >= 0) {
      warn?.(
        `ось ${name}: строка ${bad + 2} — ${rows[bad].length} ячеек при ${columns.length} в заголовке; ` +
          `тело разобрано как список`,
      )
    }
  }

  const points = parseList(text)
  return points.length > 0 ? { kind: 'list', points } : null
}

function table(columns: TypedColumn[], rows: string[][]): AxisBody {
  const names = columns.map((c) => c.name)
  const labelIdx = names.indexOf('label')
  const points: BatchPoint[] = rows.map((cells) => {
    const vars: Record<string, Value> = {}
    columns.forEach((col, j) => {
      if (j !== labelIdx) vars[col.name] = cellValue(cells[j] ?? '', col)
    })
    const first = cellText(vars[names[labelIdx === 0 ? 1 : 0]])
    const label = labelIdx >= 0 ? cells[labelIdx] : first
    return { value: first, label: label || undefined, vars }
  })
  return { kind: 'table', columns: names.filter((n) => n !== 'label'), points }
}
