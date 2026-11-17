import type { AsyncResult } from './result.js'
import type { IStorage } from './storage.js'

/**
 * Файловая система хоста — расширение {@link IStorage} тем, без чего не
 * обходятся агентные тулы и драйверы сессий: метаданные, байты,
 * каталоги, переименование. Реализации — у хоста: Node (`node:fs`), браузер
 * (OPFS, IndexedDB), память (тесты), Worker (R2/D1).
 *
 * Контракт путей — как у `IStorage`: прямой слеш; абсолютные пути хоста
 * (`/Users/a/proj`, `/proj` в OPFS) берутся как есть. Кодировка текста — UTF-8.
 * «Нет такого» — штатный исход (`ok(undefined)` / `ok(false)`), `err` — сбой
 * носителя или прав.
 *
 * Семантика методов `IStorage` для `IFileSystem`: `write` создаёт недостающие
 * каталоги; `list(prefix)` — все файлы под каталогом `prefix` рекурсивно,
 * пути полные; `delete` — файл (нет файла — ok).
 */
export interface IFileSystem extends IStorage {
  /** Метаданные пути; нет — `ok(undefined)`. Симлинк — по цели. */
  stat(path: string): AsyncResult<FileStat | undefined>
  /** Байты файла; нет — `ok(undefined)`. */
  readBytes(path: string): AsyncResult<Uint8Array | undefined>
  /** Записать байты (каталоги создаются). */
  writeBytes(path: string, data: Uint8Array): AsyncResult<void>
  /** Записи каталога (имена, без рекурсии); нет каталога — `ok(undefined)`. */
  readdir(path: string): AsyncResult<DirEntry[] | undefined>
  /** Создать каталог с родителями; есть — ok. */
  mkdir(path: string): AsyncResult<void>
  /** Переименовать файл или каталог; родитель цели создаётся, цель перезаписывается. */
  rename(from: string, to: string): AsyncResult<void>
  /** Удалить файл или каталог (`recursive` — с содержимым); нет — ok. */
  remove(path: string, opts?: { recursive?: boolean }): AsyncResult<void>
  /**
   * Канонический путь (симлинки разрешены). Нет метода — у носителя симлинков
   * нет, путь и есть канонический. Пути, которого нет, — `err`.
   */
  realpath?(path: string): AsyncResult<string>
  /** Дописать текст в конец файла (нет файла — создать). Нет метода — read+write. */
  append?(path: string, content: string): AsyncResult<void>
}

export interface FileStat {
  type: 'file' | 'dir'
  /** Байты (у каталога — 0 или как отдаёт носитель). */
  size: number
  /** Время изменения, мс эпохи; носитель без времени — 0. */
  mtimeMs: number
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir'
}
