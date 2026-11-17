// Хелперы без DOM и зависимостей: шаг числа для поля-числа (запасной контрол пакета и `NumberField` кита
// хозяина — одна логика) и множественное число для счётчиков («4 файла»). Реэкспорт — из `.` и `./react`.

/** Текст поля → число: запятая как точка, пробелы мимо; пусто или не число — `undefined`. */
export function parseNumber(text: string): number | undefined {
  const t = text.replace(/\s+/g, '').replace(',', '.')
  if (t === '' || t === '-' || t === '.') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** Знаков после точки у шага (`0.05` → 2): шаг не копит ошибку плавающей точки. */
function decimals(n: number): number {
  const s = String(n)
  if (s.includes('e-')) return Number(s.split('e-')[1])
  return s.includes('.') ? s.split('.')[1]!.length : 0
}

export function clampNumber(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min
  if (max !== undefined && v > max) return max
  return v
}

/**
 * Шаг клавишей или колесом: `dir` ±1, `scale` — множитель (Shift — ×10, Alt — ×0.1). Пусто — от `min` (или 0).
 * Итог в границах и округлён по шагу.
 */
export function stepNumber(value: number | undefined, dir: 1 | -1, o: { step?: number; min?: number; max?: number; scale?: number } = {}): number {
  const step = (o.step && o.step > 0 ? o.step : 1) * (o.scale ?? 1)
  const from = value ?? clampNumber(0, o.min, o.max)
  const places = Math.max(decimals(step), decimals(from))
  const next = Number((from + dir * step).toFixed(Math.min(places, 12)))
  return clampNumber(next, o.min, o.max)
}

/**
 * Форма слова при числе: `plural(4, ['файл', 'файла', 'файлов'])` → «файла». Правила языка — `Intl.PluralRules`
 * (`ru`: one / few / many; `en`: one / other — тогда `[one, other]`). Дробное — форма `few` (как «2,5 файла»).
 */
export function plural(n: number, forms: readonly [string, string, string?], locale = 'ru'): string {
  const rule = new Intl.PluralRules(locale).select(n)
  if (forms.length === 2 || forms[2] === undefined) return rule === 'one' ? forms[0] : forms[1]
  return rule === 'one' ? forms[0] : rule === 'few' || rule === 'other' && !Number.isInteger(n) ? forms[1] : forms[2]
}

/** Число и слово: `countOf(4, ['файл', 'файла', 'файлов'])` → «4 файла». */
export function countOf(n: number, forms: readonly [string, string, string?], locale = 'ru'): string {
  return `${n} ${plural(n, forms, locale)}`
}
