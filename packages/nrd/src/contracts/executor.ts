// Executor — контракт исполнения блока (PORTABLE, ноль Node-специфики).
//
// Контракт язык блок-семантики: что блок *хочет* исполнить и что возвращает.
// Реализации (execBlock, spawnExecutor) — в потребителе (nrd-exec). `Result`
// приходит как ТИП — стирается при компиляции, рантайм сюда не протекает.

import type { Result } from './result.js'

/** Движок блока — то, что блок *хочет* исполнить. */
export type Engine = 'shell' | 'ts' | 'zx'

/** Вход исполнения — платформо-нейтральный (никакого `process.env`, только строки). */
export interface ExecInput {
  /** Движок (берётся из имени блока, не из info-string fence). */
  engine: Engine
  /** Тело блока после снятия fence и резолва `${}`. */
  code: string
  /** Доп. переменные окружения (строки; executor решает, как применить). */
  env?: Record<string, string>
  /** Рабочая директория. Опциональна — браузерный executor игнорирует. */
  cwd?: string
  /** Таймаут, мс. */
  timeout?: number
  /** Данные на stdin. */
  input?: string
}

/** Результат исполнения — два канала. */
export interface ExecOutput {
  /** Текстовый вывод. Даёт любой executor. Парсится по `$nr-parse`. */
  stdout: string
  /** Нативный return — даёт только in-process executor (`AsyncFunction`); spawn оставляет `undefined`. */
  value?: unknown
  /** Диагностика. */
  stderr: string
  /** Код завершения процесса (0 — успех). */
  code: number
}

/**
 * Контракт исполнения. Каждый executor честно объявляет `supports` — какие
 * движки он тянет в своём окружении. `execBlock` сверяет движок блока с
 * `supports` и даёт внятный `Result.err`, если движок не поддержан.
 *
 * `Result.err` от `run` — это сбой САМОГО executor'а (не смог исполнить:
 * не записал временный файл и т.п.). Ненулевой код процесса — это НЕ err:
 * он живёт в `ExecOutput.code`, чтобы `execBlock` сам решил.
 */
export interface Executor {
  readonly id: string
  readonly supports: ReadonlySet<Engine>
  run(input: ExecInput): Promise<Result<ExecOutput>>
}
