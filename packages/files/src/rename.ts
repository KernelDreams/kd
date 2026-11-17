/**
 * Пакетное переименование (Yazi, file-panel-spec §4): имена открываются текстом — по
 * одному на строку, — правятся в редакторе, план показывает diff и применяется.
 * Обмен именами (`a`↔`b`) и цепочки идут через временные имена: ни одна правка не
 * затирает чужой файл.
 */

export interface RenamePair {
  from: string
  to: string
}

export interface RenamePlan {
  /** Что меняется (без неизменных). */
  pairs: RenamePair[]
  errors: string[]
  /** Шаги в порядке применения: `rename(from, to)` по одному. */
  steps: RenamePair[]
}

/** Имена → текст для редактора. */
export function renameText(names: readonly string[]): string {
  return `${names.join('\n')}\n`
}

const BAD = /[/\0]/

/**
 * План по исходным именам и правленому тексту. `existing` — все имена каталога: новое
 * имя, занятое файлом вне правки, — ошибка. Число строк должно совпасть.
 */
export function planRename(names: readonly string[], edited: string, existing: readonly string[] = names): RenamePlan {
  const lines = edited.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const errors: string[] = []
  if (lines.length !== names.length) {
    errors.push(`строк ${lines.length}, а имён ${names.length}: строки не добавлять и не удалять`)
    return { pairs: [], errors, steps: [] }
  }
  const pairs: RenamePair[] = []
  const targets = new Map<string, string>()
  names.forEach((from, i) => {
    const to = lines[i]!.trim()
    if (to === '') errors.push(`строка ${i + 1}: пустое имя`)
    else if (to === '.' || to === '..' || BAD.test(to)) errors.push(`строка ${i + 1}: недопустимое имя «${to}»`)
    else if (targets.has(to)) errors.push(`«${to}» — два раза (строки ${names.indexOf(targets.get(to)!) + 1} и ${i + 1})`)
    else {
      targets.set(to, from)
      if (to !== from) pairs.push({ from, to })
    }
  })
  const moving = new Set(names)
  for (const p of pairs) {
    if (existing.includes(p.to) && !moving.has(p.to)) errors.push(`«${p.to}» уже есть в каталоге`)
  }
  if (errors.length > 0) return { pairs, errors, steps: [] }
  return { pairs, errors, steps: orderSteps(pairs, existing) }
}

/** Порядок шагов: свободная цель — сразу; цикл — через временное имя. */
function orderSteps(pairs: readonly RenamePair[], existing: readonly string[]): RenamePair[] {
  const steps: RenamePair[] = []
  const pending = new Map(pairs.map((p) => [p.from, p.to]))
  const occupied = new Set(existing)
  let tmpN = 0
  const tmp = (name: string): string => {
    let t: string
    do t = `.nr-rename-${tmpN++}-${name}`
    while (occupied.has(t))
    return t
  }
  while (pending.size > 0) {
    let progressed = false
    for (const [from, to] of [...pending]) {
      if (!occupied.has(to)) {
        steps.push({ from, to })
        occupied.delete(from)
        occupied.add(to)
        pending.delete(from)
        progressed = true
      }
    }
    if (progressed) continue
    // Цикл: первый из оставшихся уходит во временное имя.
    const [from, to] = pending.entries().next().value as [string, string]
    const t = tmp(from)
    steps.push({ from, to: t })
    occupied.delete(from)
    occupied.add(t)
    pending.delete(from)
    pending.set(t, to)
  }
  return steps
}

/** Обратный план (отмена): шаги наоборот, `from`↔`to`. */
export function undoSteps(steps: readonly RenamePair[]): RenamePair[] {
  return [...steps].reverse().map((s) => ({ from: s.to, to: s.from }))
}

/** Diff имён для показа: строки `- было` / `+ стало`. */
export function renameDiff(pairs: readonly RenamePair[]): string {
  return pairs.map((p) => `- ${p.from}\n+ ${p.to}`).join('\n')
}
