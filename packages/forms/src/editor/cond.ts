// `$show-if` / `$hide-if` (spec §2): по ключам И, внутри списка ИЛИ; значения нет — условие не
// выполнено. Данные не трогает. Путь — от корня, внутри повторителя — от элемента (`scope`).

import { get } from './get.js'
import type { ShowIf } from './types.js'

export function condHolds(cond: ShowIf, scope: unknown): boolean {
  for (const [path, vals] of Object.entries(cond)) {
    if (!Array.isArray(vals)) return false
    const v = get(scope, path)
    if (v === undefined) return false
    if (!vals.some((x) => x === v || (typeof x !== 'object' && String(x) === String(v)))) return false
  }
  return true
}

/** Виден ли узел над областью данных. */
export function shown(node: { showIf?: ShowIf; hideIf?: ShowIf }, scope: unknown): boolean {
  if (node.showIf && !condHolds(node.showIf, scope)) return false
  if (node.hideIf && condHolds(node.hideIf, scope)) return false
  return true
}
