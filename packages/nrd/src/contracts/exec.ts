/**
 * Контракт примитива исполнения процессов. Реализации (execShell/runFile,
 * ExecError) — в потребителе (nr-infra). Платформо-нейтрально по отношению к NRD.
 *
 * Все функции-реализации возвращают Result: предсказуемый исход (ненулевой код,
 * ENOENT, таймаут) — через err(), не throws.
 */
export interface ExecOptions {
  /** Рабочая директория процесса. */
  cwd?: string
  /** Доп. переменные окружения — merge поверх process.env. */
  env?: Record<string, string>
  /** мс; по истечении процесс убивается (SIGKILL). */
  timeout?: number
  /** Оболочка: true=системная, строка=путь к шеллу, false=без оболочки. */
  shell?: string | boolean
  /** Данные на stdin процесса. */
  input?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}
