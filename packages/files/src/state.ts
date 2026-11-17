/**
 * Состояние вкладки панели (file-panel-spec §3) — данные: `{host, path, view, sort,
 * selection, columns, hidden}`. Живёт в параметрах вкладки (строки): переживает
 * перезагрузку и открывается ссылкой `#/t/files?…`.
 */

import { decodeList, defaultList, encodeList, nextOf, type ListShape, type ListState } from './collection/index.js'
import { normalizePath } from './address.js'
import { SORT_KEYS, type SortKey } from './entries.js'

export type PanelView = 'tree' | 'far' | 'yazi' | 'thumbs'
export const PANEL_VIEWS: readonly PanelView[] = ['tree', 'far', 'yazi', 'thumbs']

/** Колонки вида Far. */
export type Column = 'name' | 'size' | 'mtime' | 'ext' | 'git'
export const COLUMNS: readonly Column[] = ['name', 'size', 'mtime', 'ext', 'git']
export const DEFAULT_COLUMNS: readonly Column[] = ['name', 'size', 'mtime']

/** Состояние списка (`nr-collection`) + где он: хост и каталог. */
export interface PanelState extends ListState<PanelView, Column, SortKey> {
  host?: string
  /** Каталог панели, абсолютный. */
  path: string
  /**
   * Источник «ветка против базы» (git-spec §1): вместо каталога — файлы `git diff base...HEAD`
   * репы каталога `path`; значение — база (`master`). Нет — обычный каталог.
   */
  against?: string
}

/** Виды, ключи сортировки и колонки панели файлов. */
export const PANEL_SHAPE: ListShape<PanelView, Column, SortKey> = {
  views: PANEL_VIEWS,
  defaultView: 'far',
  sortKeys: SORT_KEYS,
  defaultSort: 'name',
  columns: COLUMNS,
  defaultColumns: DEFAULT_COLUMNS,
  firstColumn: 'name',
}

export function defaultState(path: string, host?: string): PanelState {
  return { ...(host ? { host } : {}), path: normalizePath(path), ...defaultList(PANEL_SHAPE) }
}

/** Состояние → параметры вкладки; по умолчанию — не пишется. */
export function encodeState(s: PanelState): Record<string, string> {
  return { path: s.path, ...(s.host ? { host: s.host } : {}), ...encodeList(s, PANEL_SHAPE), ...(s.against ? { vs: s.against } : {}) }
}

/** Параметры вкладки → состояние; мусор — значения по умолчанию. `fallback` — каталог без `path`. */
export function decodeState(p: Readonly<Record<string, string | undefined>>, fallback = '/'): PanelState {
  const s = decodeList(p, PANEL_SHAPE, defaultState(p.path && p.path !== '' ? p.path : fallback, p.host || undefined))
  if (p.vs) s.against = p.vs
  return s
}

/** Следующий вид по кругу (клавиша смены вида). */
export function nextView(v: PanelView): PanelView {
  return nextOf(PANEL_VIEWS, v)
}

/** Перейти в каталог: курсор и выделение сбрасываются; `cursor` — на каком имени встать (Ctrl+PgUp — на прежнем каталоге). */
export function goTo(s: PanelState, path: string, cursor?: string): PanelState {
  const { cursor: _c, against: _a, ...rest } = s
  return { ...rest, path: normalizePath(path), selection: [], ...(cursor ? { cursor } : {}) }
}
