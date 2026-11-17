/**
 * Rust-style result type. Единая модель ошибок для всего IO стека kd.
 *
 * Предсказуемые ошибки (сеть, диск, невалидный JSON, permission denied) — через `err()`.
 * Баги (null pointer, type error) — throws как обычно.
 *
 * Канон (ступень 1 Total Refactor): конструкторы `ok/err/isOk/isErr` принадлежат
 * типу Result и живут здесь. Реализации IO — в потребителях (nr-infra и др.).
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

/** Промис, разрешающийся в Result. Тип возврата всех async IO-функций. */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>

/** Успешный результат. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Результат с ошибкой. */
export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error }
}

/** Type guard: результат успешен. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok
}

/** Type guard: результат — ошибка. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok
}
