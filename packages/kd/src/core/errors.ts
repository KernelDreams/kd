/**
 * Коды выхода `kd` (kd-cli-spec §3): 0 — готово; 1 — тул упал; 2 — неверный вызов;
 * 3 — не хватает нужного (модель, ключ, машина); 4 — прерван с сохранённым состоянием.
 */

export type ExitCode = 0 | 1 | 2 | 3 | 4

export const EXIT = { ok: 0, failed: 1, usage: 2, missing: 3, interrupted: 4 } as const

export interface KdErrorInfo {
  /** Поле, о котором ошибка. */
  field?: string
  /** Подсказка человеку и модели. */
  hint?: string
  /** Исправленная команда целиком (на кодах 2 и 3 — последняя строка stderr). */
  fix?: string
  /** Вызов, исправленный объектом (для модели: `{tool, action, params}`). */
  fixCall?: unknown
  /** Варианты (выбор тула, действия). */
  choices?: string[]
}

export class KdError extends Error {
  readonly code: ExitCode
  readonly info: KdErrorInfo
  constructor(code: ExitCode, message: string, info: KdErrorInfo = {}) {
    super(message)
    this.name = 'KdError'
    this.code = code
    this.info = info
  }
}

export const isKdError = (e: unknown): e is KdError => e instanceof KdError

/** Расстояние Дамерау — Левенштейна (опечатки `pubish` → `publish`). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

/** Ближайшее имя из списка, если похоже. */
export function nearest(word: string, names: readonly string[]): string | undefined {
  let best: string | undefined
  let bestD = Infinity
  for (const n of names) {
    const dd = distance(word.toLowerCase(), n.toLowerCase())
    if (dd <= Math.max(1, Math.floor(n.length / 3)) && dd < bestD) {
      best = n
      bestD = dd
    }
  }
  return best
}
