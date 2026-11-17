/**
 * Node-адаптер `CodeLoader` (rz-merge §0.5).
 *
 * Тело `fn` — модуль: он импортирует пакеты и объявляет `export`. Единственный
 * честный способ загрузить его в Node — временный файл + `import()`.
 *
 * Куда класть файл: В САМ `baseDir`, скрытым именем. Импорты тела обязаны
 * резолвиться так же, как если бы оно лежало файлом рядом с документом
 * (rz-merge §5): голые (`@kerneldreams/nrd`, `@toon-format/toon`) — обходом
 * вверх по node_modules от места файла, относительные (`./parts/x.ts`) — от
 * директории документа. Подкаталог (`<baseDir>/.nrd/tmp/`, как буквально
 * написано в §0.5) ломает вторую половину: `./x.ts` начинает искаться в
 * `.nrd/tmp/x.ts`. Требование §5 сильнее буквы §0.5 — иначе относительный
 * импорт молча уезжает не туда.
 *
 * При недоступной на запись директории — фолбэк в системный temp (тело без
 * относительных импортов и без пакетов там работает).
 *
 * Файл удаляется сразу после `import()`. Кэш модулей ноды это не отменяет,
 * поэтому имя уникально на вызов: два разных тела под одним id не склеятся.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CodeLoader, CodeLoadOptions, LoadedModule } from '../contracts/index.js'

/** Префикс скрытого временного модуля рядом с документом. */
export const TMP_PREFIX = '.nrd-fn-'

let seq = 0

function safeName(filename: string | undefined, lang: string): string {
  const base = (filename ?? 'fn').replace(/\.[^.]*$/, '').replace(/[^\w.-]/g, '_')
  return `${TMP_PREFIX}${base || 'fn'}-${process.pid}-${seq++}.${lang}`
}

/** Куда положить тело перед импортом: сам `baseDir`, иначе системный temp. */
function tempModulePath(baseDir: string, name: string): { file: string; cleanup: string } {
  try {
    const file = join(baseDir, name)
    writeFileSync(file, '', 'utf-8')
    return { file, cleanup: file }
  } catch {
    const dir = mkdtempSync(join(tmpdir(), 'nrd-fn-'))
    return { file: join(dir, name), cleanup: dir }
  }
}

/**
 * Node-реализация {@link CodeLoader}.
 *
 * @param baseDir база для резолва импортов тела; по умолчанию — cwd.
 */
export function nodeCodeLoader(baseDir: string = process.cwd()): CodeLoader {
  return {
    id: 'node',
    async load(code: string, opts?: CodeLoadOptions): Promise<LoadedModule> {
      const lang = opts?.lang ?? 'ts'
      const dir = opts?.baseDir ?? baseDir
      const { file, cleanup } = tempModulePath(dir, safeName(opts?.filename, lang))
      try {
        writeFileSync(file, code, 'utf-8')
        return (await import(pathToFileURL(file).href)) as LoadedModule
      } finally {
        try {
          rmSync(cleanup, { recursive: true, force: true })
        } catch {
          // временный файл — best effort
        }
      }
    },
  }
}
