/**
 * Вид «дерево» (Obsidian, file-panel-spec §2) над каталогами: строки дерева коллекции
 * (`buildTreeRows`, `nr-collection`) с сортировкой Far.
 */

import { buildTreeRows, type DirLoad, type TreeRow } from './collection/index.js'
import type { Entry, Sort } from './entries.js'
import { sortEntries } from './entries.js'

export interface TreeOpts {
  sort?: Sort
  hidden?: boolean
  /** Фильтр имён (маска Far); каталоги с подходящими потомками остаются. */
  filter?: string
}

/** Строки дерева от корня `root` (сам корень не рисуется). */
export function treeRows<E extends Entry>(
  root: string,
  dirs: ReadonlyMap<string, DirLoad<E>>,
  expanded: ReadonlySet<string>,
  opts: TreeOpts = {},
): TreeRow<E>[] {
  return buildTreeRows(root, dirs, expanded, {
    order: (es) => sortEntries(es, opts.sort),
    ...(opts.hidden !== undefined ? { hidden: opts.hidden } : {}),
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
  })
}
