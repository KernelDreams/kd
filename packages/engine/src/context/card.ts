// Чтение полей карточки из IContext.
//
// mdd-карточка приходит через `## $source` — поле может быть строкой, IArray
// (коллекция блоков) или IContext. Один хелпер на движок и ассемблер, чтобы
// «что считается текстом карточки» было ровно в одном месте.

import type { IContext } from '@kerneldreams/nrd'

/** Поля карточки, которые движок скорит и кладёт в ContextPackage. */
export const CARD_FIELDS = [
  'system_prompt',
  'personality',
  'scenario',
  'post_history_instructions',
] as const

function stripMddComments(s: string): string {
  return s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('@//'))
    .join('\n')
    .trim()
}

function fieldText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v !== 'object' || v === null) return ''

  const obj = v as { at?: (i: number) => unknown; cast?: (n: string) => unknown }
  if (typeof obj.at === 'function') {
    const first = obj.at(0) as { cast?: (n: string) => unknown } | string | undefined
    if (typeof first === 'string') return first.trim()
    if (first && typeof first.cast === 'function') {
      const t = first.cast('text')
      if (typeof t === 'string') return t.trim()
    }
    return ''
  }
  if (typeof obj.cast === 'function') {
    const t = obj.cast('text')
    if (typeof t === 'string') return t.trim()
  }
  return ''
}

/** Склеенный текст перечисленных полей карточки (пустые пропускаются). */
export function cardField(context: IContext, ...fields: string[]): string {
  const parts: string[] = []
  for (const f of fields) {
    const text = fieldText(context.get([f]))
    if (text) parts.push(text)
  }
  return parts.map(stripMddComments).filter(Boolean).join('\n\n')
}
