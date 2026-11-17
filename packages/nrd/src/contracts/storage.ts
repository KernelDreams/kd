import type { AsyncResult } from './result.js'

/**
 * Абстракция чтения/записи. Все операции через Result. Реализации
 * (fsStorage/memoryStorage) — в потребителе (nr-infra).
 *
 * Контракт: пути всегда с прямым слешем (`config/models.md`), реализация
 * конвертирует под OS. Кодировка — UTF-8.
 */
export interface IStorage {
  /** ok(undefined) = файла нет (штатно), err = диск/права. */
  read(path: string): AsyncResult<string | undefined>
  write(path: string, content: string): AsyncResult<void>
  exists(path: string): AsyncResult<boolean>
  /** Список путей (с прямым слешем) под префиксом. */
  list(prefix: string): AsyncResult<string[]>
  delete(path: string): AsyncResult<void>
}
