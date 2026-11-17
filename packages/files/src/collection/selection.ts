/**
 * Выделение Far (любая коллекция): курсор + отмеченные. Ins/Space — отметить и шагнуть, Shift+стрелки —
 * диапазон, Gray+/− — по маске, Gray* — инвертировать. Операция берёт отмеченные, а нет
 * их — запись под курсором. `..` не отмечается никогда.
 */

import { compileMask } from './mask.js'

export const UP = '..'

/** Отметить/снять имя. */
export function toggle(sel: readonly string[], name: string): string[] {
  if (name === UP) return [...sel]
  return sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]
}

/** Диапазон от `from` до `to` (индексы в `names`) — отметить все, как Shift+стрелки в Far. */
export function selectRange(sel: readonly string[], names: readonly string[], from: number, to: number, on = true): string[] {
  const [a, b] = from <= to ? [from, to] : [to, from]
  const span = names.slice(Math.max(0, a), b + 1).filter((n) => n !== UP)
  const set = new Set(sel)
  for (const n of span) {
    if (on) set.add(n)
    else set.delete(n)
  }
  return names.filter((n) => set.has(n))
}

/** Gray+ / Gray−: добавить или снять по маске Far. Каталоги — только если `dirs`. */
export function selectByMask(
  sel: readonly string[],
  entries: readonly { name: string; kind: 'file' | 'dir' }[],
  mask: string,
  on: boolean,
  dirs = false,
): string[] {
  const m = compileMask(mask)
  const set = new Set(sel)
  for (const e of entries) {
    if (e.name === UP || (!dirs && e.kind === 'dir') || !m(e.name)) continue
    if (on) set.add(e.name)
    else set.delete(e.name)
  }
  return entries.map((e) => e.name).filter((n) => set.has(n))
}

/** Gray*: инвертировать по файлам (каталоги Far не трогает). */
export function invert(sel: readonly string[], entries: readonly { name: string; kind: 'file' | 'dir' }[]): string[] {
  const set = new Set(sel)
  return entries.filter((e) => e.name !== UP && (e.kind === 'dir' ? set.has(e.name) : !set.has(e.name))).map((e) => e.name)
}

/** Только существующие имена (после перечитывания каталога). */
export function prune(sel: readonly string[], names: readonly string[]): string[] {
  const live = new Set(names)
  return sel.filter((n) => live.has(n))
}

/** Над чем операция: отмеченные, иначе курсор (кроме `..`). */
export function operands(sel: readonly string[], cursor: string | undefined): string[] {
  if (sel.length > 0) return [...sel]
  return cursor && cursor !== UP ? [cursor] : []
}
