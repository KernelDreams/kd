/**
 * Запись коллекции — то, что панель рисует строкой: имя, путь (ключ), вид. `dir` — группа
 * (каталог, папка коллекции), её можно раскрыть; `file` — сама запись. Остальные поля —
 * у источника (файлы — `Entry` пакета `nr-files`, поле в поле с `FileEntry` протокола).
 */

export interface Item {
  name: string
  /** Ключ записи: путь в коллекции, абсолютный у файлов. */
  path: string
  kind: 'file' | 'dir'
  size?: number
  /** ISO-время. */
  mtime?: string
}

/** Скрытая запись (`.git`, `.DS_Store`). */
export const isHidden = (e: Pick<Item, 'name'>): boolean => e.name.startsWith('.')
