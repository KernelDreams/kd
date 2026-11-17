/**
 * Сортировка коллекции как в Far: группы (`dir`) всегда сверху и по имени, записи — по ключу,
 * при равенстве — по имени. Ключи и их сравнения — у источника (`name` есть всегда).
 */

import type { Item } from './item.js'

export interface ItemSort<K extends string = string> {
  key: K
  desc?: boolean
}

/** Сравнение двух записей по ключу; `0`/`NaN` — равны (дальше решает имя). */
export type ItemCompare<E> = (a: E, b: E) => number

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Имена по-человечески: числа как числа, без регистра и диакритики. */
export const compareText = (a: string, b: string): number => collator.compare(a, b)

/** Сравнения ключей, общих для любой коллекции: имя, размер, время. */
export const ITEM_COMPARE = {
  name: (a: Item, b: Item): number => compareText(a.name, b.name),
  size: (a: Item, b: Item): number => (a.size ?? 0) - (b.size ?? 0),
  mtime: (a: Item, b: Item): number => Date.parse(a.mtime ?? '') - Date.parse(b.mtime ?? ''),
}

/** Отсортировать: группы сверху (по имени; обратный порядок — только у ключа `name`); ключ без сравнения в `compare` — по имени. */
export function sortItems<E extends Item, K extends string>(
  items: readonly E[],
  sort: ItemSort<K>,
  compare: Partial<Record<K, ItemCompare<E>>>,
): E[] {
  const dir = sort.desc ? -1 : 1
  const byName = (a: E, b: E): number => compareText(a.name, b.name)
  const byKey = compare[sort.key] ?? byName
  const cmp = (a: E, b: E): number => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    if (a.kind === 'dir') return byName(a, b) * (sort.key === 'name' ? dir : 1)
    // `NaN || …` — тоже по имени (время, которого нет).
    const r = byKey(a, b) || byName(a, b)
    return r * dir
  }
  return [...items].sort(cmp)
}
