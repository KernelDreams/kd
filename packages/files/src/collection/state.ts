/**
 * Состояние списка панели — данные: `{view, sort, cursor, selection, columns, hidden, tile}`.
 * Живёт в параметрах вкладки (строки): переживает перезагрузку и открывается ссылкой. Какие
 * виды, ключи сортировки и колонки бывают — форма (`ListShape`) источника; где список
 * (каталог, коллекция) — тоже у источника, поверх этих полей.
 */

import type { ItemSort } from './sort.js'

export interface ListState<V extends string = string, C extends string = string, K extends string = string> {
  view: V
  sort: ItemSort<K>
  /** Имя под курсором (не путь: путь — место списка + имя). */
  cursor?: string
  /** Отмеченные имена (Ins/Space). */
  selection: string[]
  columns: C[]
  /** Показывать скрытые. */
  hidden: boolean
  /** Сторона плитки эскизов, px. */
  tile?: number
}

/** Что бывает у списка источника: виды, ключи сортировки, колонки (первая — обязательная). */
export interface ListShape<V extends string, C extends string, K extends string> {
  views: readonly V[]
  defaultView: V
  sortKeys: readonly K[]
  defaultSort: K
  columns: readonly C[]
  defaultColumns: readonly C[]
  /** Колонка, без которой списка нет (`name`): всегда первой. */
  firstColumn: C
}

export const DEFAULT_TILE = 128
export const MIN_TILE = 64
export const MAX_TILE = 320

export const clampTile = (px: number): number => Math.min(MAX_TILE, Math.max(MIN_TILE, Math.round(px)))

/** Состояние по умолчанию. */
export function defaultList<V extends string, C extends string, K extends string>(shape: ListShape<V, C, K>): ListState<V, C, K> {
  return { view: shape.defaultView, sort: { key: shape.defaultSort }, selection: [], columns: [...shape.defaultColumns], hidden: false }
}

/** Имена выделения в строке: через `\n` (имя `\n` не содержит на практике; `/` — никогда). */
const SEP = '\n'

/** Состояние → параметры вкладки; по умолчанию — не пишется. */
export function encodeList<V extends string, C extends string, K extends string>(s: ListState<V, C, K>, shape: ListShape<V, C, K>): Record<string, string> {
  const out: Record<string, string> = {}
  if (s.view !== shape.defaultView) out.view = s.view
  if (s.sort.key !== shape.defaultSort || s.sort.desc) out.sort = `${s.sort.desc ? '-' : ''}${s.sort.key}`
  if (s.cursor) out.cursor = s.cursor
  if (s.selection.length > 0) out.sel = s.selection.join(SEP)
  if (s.columns.join(',') !== shape.defaultColumns.join(',')) out.cols = s.columns.join(',')
  if (s.hidden) out.hidden = '1'
  if (s.tile !== undefined && s.tile !== DEFAULT_TILE) out.tile = String(s.tile)
  return out
}

/** Параметры вкладки → поля списка поверх `base`; мусор — как в `base`. */
export function decodeList<V extends string, C extends string, K extends string, S extends ListState<V, C, K>>(
  p: Readonly<Record<string, string | undefined>>,
  shape: ListShape<V, C, K>,
  base: S,
): S {
  const s = base
  if (shape.views.includes(p.view as V)) s.view = p.view as V
  if (p.sort) {
    const desc = p.sort.startsWith('-')
    const key = desc ? p.sort.slice(1) : p.sort
    if (shape.sortKeys.includes(key as K)) s.sort = { key: key as K, ...(desc ? { desc: true } : {}) }
  }
  if (p.cursor) s.cursor = p.cursor
  if (p.sel) s.selection = p.sel.split(SEP).filter(Boolean)
  if (p.cols) {
    const cols = p.cols.split(',').filter((c): c is C => shape.columns.includes(c as C))
    if (cols.length > 0) s.columns = cols.includes(shape.firstColumn) ? cols : [shape.firstColumn, ...cols]
  }
  if (p.hidden === '1') s.hidden = true
  const tile = Number(p.tile)
  if (Number.isFinite(tile) && tile > 0) s.tile = clampTile(tile)
  return s
}

/** Следующий по кругу (клавиша смены вида). */
export function nextOf<V>(list: readonly V[], v: V): V {
  return list[(list.indexOf(v) + 1) % list.length]!
}
