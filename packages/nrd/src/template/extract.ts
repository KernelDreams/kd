// extractNrd — вырезать NRD-блок из шаблона (spec §3.3).
//
// Portable: чистая строковая операция, без fs/Node. NRD-блок обрамлён
// `<{ nrd }>` ... `<{ endnrd }>` и содержит mdz-конфиг для nrd-context.
// ntpl его НЕ интерпретирует — только извлекает текст между тегами.

const NRD_RE = /<\{\s*nrd\s*\}>([\s\S]*?)<\{\s*endnrd\s*\}>/

export interface ExtractResult {
  /** mdz-конфиг между `<{ nrd }>` и `<{ endnrd }>`, или null если блока нет. */
  nrdBlock: string | null
  /** Шаблон без NRD-блока — то, что идёт в render(). */
  body: string
}

/**
 * Разделить шаблон на NRD-конфиг и тело.
 *
 * - блок есть → `{ nrdBlock: <текст>, body: <шаблон без блока> }`
 * - блока нет → `{ nrdBlock: null, body: <шаблон как есть> }`
 *
 * Текст блока возвращается с обрезанными краевыми переводами строк; ведущая
 * пустая строка, оставшаяся после удаления блока из тела, тоже убирается.
 */
export function extractNrd(template: string): ExtractResult {
  const match = NRD_RE.exec(template)
  if (!match) {
    return { nrdBlock: null, body: template }
  }
  const nrdBlock = match[1].replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '')
  const body = (template.slice(0, match.index) + template.slice(match.index + match[0].length)).replace(
    /^\r?\n/,
    '',
  )
  return { nrdBlock, body }
}
