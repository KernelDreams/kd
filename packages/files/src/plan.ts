/**
 * План операций над файлами — до вызова бэкенда: куда ляжет каждый источник, что
 * занято, что бессмысленно (копия в саму себя). F5/F6 Far.
 */

import { baseName, isUnder, joinPath, normalizePath, parentPath } from './address.js'

export type OpKind = 'copy' | 'move'

export interface PlannedItem {
  from: string
  to: string
  /** `to` уже есть — спросить: заменить / пропустить / переименовать. */
  conflict?: boolean
}

export interface OpPlan {
  op: OpKind
  items: PlannedItem[]
  /** Отказы: источник равен цели, каталог в самого себя. */
  errors: { from: string; reason: 'same' | 'into-self' }[]
}

/**
 * Источники → цели в каталоге `destDir` (имя то же). Один источник и `dest` не каталог —
 * копия под новым именем (`F5`, ввести путь целиком). `exists` — что уже есть в цели
 * (имена или пути), для пометки конфликтов.
 */
export function planOp(op: OpKind, sources: readonly string[], dest: string, opts: { destIsDir?: boolean; exists?: (path: string) => boolean } = {}): OpPlan {
  const destIsDir = opts.destIsDir ?? true
  const items: PlannedItem[] = []
  const errors: OpPlan['errors'] = []
  const single = sources.length === 1 && !destIsDir
  for (const raw of sources) {
    const from = normalizePath(raw)
    const to = single ? normalizePath(dest) : joinPath(dest, baseName(from))
    if (to === from) {
      errors.push({ from, reason: 'same' })
      continue
    }
    if (isUnder(to, from)) {
      errors.push({ from, reason: 'into-self' })
      continue
    }
    if (op === 'move' && parentPath(from) === parentPath(to) && baseName(from) === baseName(to)) {
      errors.push({ from, reason: 'same' })
      continue
    }
    items.push({ from, to, ...(opts.exists?.(to) ? { conflict: true } : {}) })
  }
  return { op, items, errors }
}

/** Свободное имя рядом: `a.txt` → `a (2).txt`, `a (2).txt` → `a (3).txt`. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem0 = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const m = /^(.*) \((\d+)\)$/.exec(stem0)
  const stem = m ? m[1]! : stem0
  for (let i = m ? Number(m[2]) + 1 : 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!taken(cand)) return cand
  }
}
