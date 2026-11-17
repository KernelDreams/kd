import type { AsyncResult } from './result.js'

/**
 * Ключ-значение хоста: кэши, индексы, состояние между запросами —
 * всё, что ядро не вправе держать в памяти процесса (хост может быть Worker'ом
 * без общей памяти между запросами). Реализации — у хоста: память, каталог на
 * диске (Node), IndexedDB (браузер), KV/D1/DO (Worker).
 *
 * Значение — JSON-сериализуемое (реализация вправе хранить его текстом).
 * Ключ — строка с `/` как разделителем пространств (`skills/<server>/index`);
 * `list(prefix)` — ключи с этим префиксом, по возрастанию. TTL — «не раньше»:
 * истёкшее значение не возвращается, удаляется когда удобно реализации.
 */
export interface KvStore {
  /** Значение; нет или истекло — `ok(undefined)`. */
  get<T = unknown>(key: string): AsyncResult<T | undefined>
  set(key: string, value: unknown, opts?: KvSetOptions): AsyncResult<void>
  /** Нет ключа — ok. */
  delete(key: string): AsyncResult<void>
  list(prefix: string): AsyncResult<string[]>
}

export interface KvSetOptions {
  /** Время жизни, мс. Нет — бессрочно. */
  ttlMs?: number
}
