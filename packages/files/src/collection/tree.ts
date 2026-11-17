/**
 * Вид «дерево» (Obsidian, file-panel-spec §2): раскрытые группы разворачиваются в плоский
 * список строк с глубиной. Загрузка — снаружи: дерево знает только, что уже прочитано, что
 * раскрыто и что грузится. Порядок записей внутри группы — у источника (`order`).
 */

import type { Item } from './item.js'
import { isHidden } from './item.js'
import { compileMask } from './mask.js'

export type DirLoad<E extends Item = Item> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; entries: readonly E[] }

export interface TreeRow<E extends Item = Item> {
  entry: E
  depth: number
  expanded: boolean
  loading: boolean
  error: string | null
}

export interface TreeRowsOpts<E extends Item = Item> {
  /** Порядок записей группы; нет — как пришли. */
  order?: (entries: readonly E[]) => readonly E[]
  hidden?: boolean
  /** Фильтр имён (маска Far); группы с подходящими потомками остаются. */
  filter?: string
}

/** Строки дерева от корня `root` (сам корень не рисуется). */
export function buildTreeRows<E extends Item>(
  root: string,
  dirs: ReadonlyMap<string, DirLoad<E>>,
  expanded: ReadonlySet<string>,
  opts: TreeRowsOpts<E> = {},
): TreeRow<E>[] {
  const match = opts.filter ? compileMask(opts.filter) : null
  const order = opts.order ?? ((es: readonly E[]) => es)
  const rows: TreeRow<E>[] = []
  const walk = (dir: string, depth: number): boolean => {
    const load = dirs.get(dir)
    if (!load || load.status !== 'ready') return false
    let any = false
    for (const e of order(load.entries.filter((x) => opts.hidden || !isHidden(x)))) {
      const open = e.kind === 'dir' && expanded.has(e.path)
      const sub = dirs.get(e.path)
      const at = rows.length
      rows.push({ entry: e, depth, expanded: open, loading: sub?.status === 'loading', error: sub?.status === 'error' ? sub.error : null })
      const childHit = open ? walk(e.path, depth + 1) : false
      const selfHit = !match || match(e.name)
      if (match && !selfHit && !childHit) rows.length = at
      else any = true
    }
    return any
  }
  walk(root, 0)
  return rows
}

/** Группы, которые надо перечитать по событию слежения: загруженные родители путей. */
export function dirsToReload(paths: readonly string[], loaded: Iterable<string>): string[] {
  const set = new Set(loaded)
  if (paths.includes('')) return [...set]
  const out = new Set<string>()
  for (const p of paths) {
    const i = p.lastIndexOf('/')
    const parent = i <= 0 ? '/' : p.slice(0, i)
    if (set.has(parent)) out.add(parent)
    if (set.has(p)) out.add(p)
  }
  return [...out]
}
