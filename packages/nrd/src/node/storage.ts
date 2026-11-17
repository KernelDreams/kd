import { promises as fs } from 'node:fs'
import * as nodePath from 'node:path'
import { ok, err } from '../infra/result.js'
import type { IStorage } from '../contracts/index.js'

// IStorage — тип переехал в @kerneldreams/nrd/contracts (ступень 1);
// реализация fsStorage остаётся здесь; memoryStorage — в `nrd/web` (§2.2).
export type { IStorage } from '../contracts/index.js'

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** «Файла нет» по коду ошибки fs. */
function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT'
}

/**
 * Абсолютен ли путь — по форме строки, не по платформе процесса: `S:/a`, `S:\a`,
 * `\\host\share` (win32) и `/a` (posix) абсолютны везде. Проверка по одной
 * `path.isAbsolute` платформы клеила `S:/a` к root на Unix (и `/a` — всегда).
 */
export function isAbsolutePath(p: string): boolean {
  return nodePath.win32.isAbsolute(p) || nodePath.posix.isAbsolute(p)
}

/**
 * Путь хранилища → путь на диске. Относительный — от `root` (прямой слеш
 * контракта → нативный разделитель OS); абсолютный — как есть, нормализованный.
 */
export function resolveStoragePath(root: string, p: string): string {
  if (isAbsolutePath(p)) return nodePath.normalize(p)
  return nodePath.resolve(root, ...p.split('/').filter(Boolean))
}

/**
 * Файловое хранилище. `root` — базовая директория, пути относительные от root;
 * абсолютный путь (`/a`, `S:/a`, `S:\a`) берётся как есть.
 * Авто-создание директорий при write.
 */
export function fsStorage(root: string): IStorage {
  const resolve = (p: string): string => resolveStoragePath(root, p)

  return {
    async read(path) {
      try {
        const content = await fs.readFile(resolve(path), 'utf-8')
        return ok(content)
      } catch (e) {
        if (isNotFound(e)) return ok(undefined)
        return err(toError(e))
      }
    },

    async write(path, content) {
      try {
        const full = resolve(path)
        await fs.mkdir(nodePath.dirname(full), { recursive: true })
        await fs.writeFile(full, content, 'utf-8')
        return ok(undefined)
      } catch (e) {
        return err(toError(e))
      }
    },

    async exists(path) {
      try {
        await fs.access(resolve(path))
        return ok(true)
      } catch (e) {
        if (isNotFound(e)) return ok(false)
        return err(toError(e))
      }
    },

    async list(prefix) {
      try {
        const dir = resolve(prefix)
        const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => {
            // Собираем относительный от root путь с прямым слешем.
            const parentPath = (e as unknown as { parentPath?: string; path?: string }).parentPath
              ?? (e as unknown as { path?: string }).path
              ?? dir
            const abs = nodePath.join(parentPath, e.name)
            return nodePath.relative(root, abs).split(nodePath.sep).join('/')
          })
        return ok(files.sort())
      } catch (e) {
        if (isNotFound(e)) return ok([])
        return err(toError(e))
      }
    },

    async delete(path) {
      try {
        await fs.rm(resolve(path), { force: true })
        return ok(undefined)
      } catch (e) {
        return err(toError(e))
      }
    },
  }
}
