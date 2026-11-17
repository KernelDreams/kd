/**
 * @kerneldreams/runz-runtime — где пакет стоит
 *
 * Пакет живёт в двух раскладках, и всё, что зависит от пути к собственным
 * файлам, решается здесь:
 *   - исходники в воркспейсе runz (`runz/packages/runtime/src/*.ts`) — так
 *     runz исполняет себя сам; ссылка `node_modules/@kerneldreams/runz-runtime` в
 *     воркспейсе ведёт сюда же (Node видит realpath);
 *   - установленный пакет (`<host>/node_modules/@kerneldreams/runz-runtime/dist/*.js`) —
 *     exz, nrchat и прочие хосты из реестра.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NM = `${path.sep}node_modules${path.sep}`

/** Расширение модулей пакета: `.ts` из исходников, `.js` из `dist`. */
export const MODULE_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'

/** Пакет установлен в чужой `node_modules`, а не исполняется из воркспейса runz. */
export const INSTALLED = HERE.includes(NM)

/**
 * Корень воркспейса хоста — каталог, чей `node_modules` даёт канонические
 * `@kerneldreams/*`: репа runz для исходников, хост (exz, nrchat) для
 * установленного пакета.
 */
export function workspaceRoot(): string {
  return runzHome() ?? (INSTALLED ? HERE.slice(0, HERE.lastIndexOf(NM)) : path.resolve(HERE, '..', '..', '..'))
}

/**
 * Корень CLI runz (каталог с `bin/runz.ts` и `scripts/`), если известен. С рантайм живёт в репе kd
 * (`kd/packages/runz-runtime`), а CLI — отдельно: путь от исходников рантайма до `scripts` runz больше не
 * выводится. Источники по порядку: `RUNZ_HOME` (ставит `bin/runz.ts` при старте), прежняя раскладка
 * (`runz/packages/runtime/src` — рядом `bin/runz.ts`), иначе — неизвестен (undefined).
 */
export function runzHome(): string | undefined {
  const env = process.env.RUNZ_HOME
  if (env && fs.existsSync(path.join(env, 'bin', 'runz.ts'))) return env
  if (!INSTALLED) {
    const legacy = path.resolve(HERE, '..', '..', '..')
    if (fs.existsSync(path.join(legacy, 'bin', 'runz.ts'))) return legacy
  }
  return undefined
}

/**
 * Встроенные скрипты дистрибутива runz (`runz/scripts`). Установленный пакет
 * их не несёт — каталог внутри пакета, которого нет, а не `scripts` хоста.
 */
export function builtinScriptsDir(): string {
  const home = runzHome()
  if (home) return path.join(home, 'scripts')
  return INSTALLED ? path.join(HERE, '..', 'scripts') : path.join(HERE, '..', 'scripts')
}

/** Абсолютный путь к модулю пакета по имени без расширения (`'resolve-hook'`). */
export function modulePath(name: string): string {
  return path.join(HERE, name + MODULE_EXT)
}

/** Образцы провайдеров-файлов пакета (`src/providers` / `dist/providers`). */
export function builtinProvidersDir(): string {
  return path.join(HERE, 'providers')
}
