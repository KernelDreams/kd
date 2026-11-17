/**
 * Материализация шаблона runz (forms-spec §4.1; пришло из pi-ext-image, image-chat-spec §4.1): блок
 * корневых атрибутов со значениями вставляется перед первой строкой `## ` —
 * это конец корневой зоны NRD, и по last-wins значения перекрывают дефолты
 * шаблона. Шаблон без значений остаётся runnable из CLI как есть.
 */

/**
 * Строка как quoted-скаляр NRD. Кавычки форсируют строку и снимают эскейпы
 * (`\\`, `\"`, `\n`, `\r`, `\t`).
 *
 * `${` уходит как opt-out `\${` (engine-spec §3.1): значение — данные, не шаблон,
 * а резолвер NRD рекурсивен по значениям (§3.3) — без эскейпа `${seed}` или
 * `${readFile(…)}` из пользовательского текста исполнились бы в шаблоне. Литерал
 * `${` шаблон получает через резолвер: `${key}` в теле или `resolveValue('${key}', ctx)`
 * в хендлере; сырой `asText(ctx.get([key]))` видит эскейп.
 *
 * `\` прямо перед `${` в NRD не выражается точно: такие `\` удваиваются, чтобы
 * плейсхолдер остался опт-аутом (иначе `\${x}` = эскейп слэша + ЖИВОЙ `${x}` —
 * инъекция); цена — лишний `\` в результате, `${` остаётся литералом.
 */
export function nrdString(value: string): string {
  const data = value.replace(/(\\*)\$\{/g, (_m, slashes: string) => slashes + slashes + '\\${')
  return (
    '"' +
    data
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  )
}

export type TemplateValue = string | number | boolean

/** Имя атрибута: только то, что NRD читает как ключ без эскейпов. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** Значения запуска: скаляр или список скаляров (корневой `IArray` шаблона). */
export type TemplateValues = Record<string, TemplateValue | TemplateValue[]>

const scalar = (value: TemplateValue): string => (typeof value === 'string' ? nrdString(value) : String(value))

/**
 * Блок `$key: value`. Список — flow-литерал `$[…]`: строковые элементы —
 * {@link nrdString} (кавычки держат запятую и скобки, `${` — opt-out), числа и
 * флаги — как есть, пустой — `$[]`.
 */
export function valueBlock(values: TemplateValues): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!KEY_RE.test(key)) throw new Error(`bad template key "${key}"`)
    const encoded = Array.isArray(value) ? `$[${value.map(scalar).join(', ')}]` : scalar(value)
    lines.push(`$${key}: ${encoded}`)
  }
  return lines.join('\n')
}

/** Текст шаблона + значения → текст документа запуска. */
export function materialize(template: string, values: TemplateValues): string {
  const block = valueBlock(values)
  const lines = template.split(/\r?\n/)
  const at = lines.findIndex((l) => l.startsWith('## '))
  if (at < 0) return template.replace(/\s*$/, '') + '\n\n' + block + '\n'
  return [...lines.slice(0, at), block, '', ...lines.slice(at)].join('\n')
}
