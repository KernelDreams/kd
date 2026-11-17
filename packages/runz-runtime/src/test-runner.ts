/**
 * @kerneldreams/runz-runtime — `runz test`
 *
 * `node --test` с resolve-хуком runz и реестром runz.
 *
 * У appz нет package.json — под голым `node --test` они не резолвят
 * `@kerneldreams/nrd`, и тесты приходилось писать либо без nrd-импортов, либо
 * с рукописным хуком в каждом файле. `runz test [цель]` подставляет тот же хук,
 * что и запуск скрипта (`--import register-hook.ts`), и ищет цель по тем же
 * `$paths`, что и `runz <script>`.
 *
 * Файлы тестов собираются здесь, а не отдаются автопоиску `node --test`:
 * дефолтные шаблоны ноды менялись от версии к версии, а набор должен быть
 * предсказуем и одинаков на всех машинах.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { RegistryOptions } from './registry.ts'
import { builtinScriptsDir, globalRunzDir } from './registry.ts'
import { expandHome, resolvePath } from './paths.ts'
import { modulePath } from './home.ts'

/** Имя файла-теста: `*.test.ts` / `*.test.mts`. */
export function isTestFile(name: string): boolean {
  return /\.test\.m?ts$/.test(name)
}

/** Директории, которые не обходим при поиске тестов. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.runz', '.claude', '.code'])

/**
 * Собрать файлы тестов внутри директории — рекурсивно, в стабильном порядке.
 * `filter` — подстрока пути (не glob): `runz test rz --filter=detect`.
 */
export function collectTestFiles(dir: string, filter?: string): string[] {
  const out: string[] = []
  const walk = (cur: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full)
      } else if (e.isFile() && isTestFile(e.name)) {
        out.push(full)
      }
    }
  }
  const stat = fs.statSync(dir)
  if (stat.isFile()) return isTestFile(path.basename(dir)) ? [dir] : []
  walk(dir)
  return filter ? out.filter((f) => f.includes(filter)) : out
}

/**
 * Найти цель теста: явный путь либо имя в реестре (`runz test rz`).
 * Возвращает директорию (или файл теста), null — не найдено.
 */
export function findTestTarget(target: string, opts: RegistryOptions): string | null {
  const direct = resolvePath(target, opts.cwd)
  if (target.includes('/') || target.includes('\\') || path.isAbsolute(target) ||
      target.startsWith('~') || target.startsWith('.')) {
    return fs.existsSync(direct) ? direct : null
  }
  const dirs: string[] = [opts.cwd]
  if (opts.projectDir) dirs.push(path.join(opts.projectDir, '.runz', 'scripts'))
  for (const p of opts.paths) dirs.push(expandHome(p))
  dirs.push(builtinScriptsDir())
  dirs.push(path.join(globalRunzDir(), 'scripts'))

  for (const dir of dirs) {
    for (const candidate of [path.join(dir, target), path.join(dir, `${target}.test.ts`)]) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // следующий кандидат
      }
    }
  }
  return null
}

export interface RunTestsOptions {
  /** Цель: путь или имя в реестре. По умолчанию — cwd. */
  target?: string
  cwd: string
  projectDir: string | null
  paths: string[]
  /** Подстрока пути файла-теста. */
  filter?: string
  /** Прокинуть в `node --test` (например `--test-concurrency=1`). */
  nodeArgs?: string[]
}

export interface RunTestsResult {
  exitCode: number
  /** Найденные файлы — для сообщений хоста. */
  files: string[]
  dir: string
}

/** Preload-модуль, ставящий resolve-хук в тестовый процесс. */
export function registerHookPath(): string {
  return modulePath('register-hook')
}

/**
 * argv `node` для прогона. `--import` ждёт URL: на Windows голый путь
 * `S:\…` нода читает как схему `s:` (ERR_UNSUPPORTED_ESM_URL_SCHEME),
 * поэтому хук — `file://`. Файлы `--test` — пути, их нода принимает и так.
 */
export function testArgv(
  hook: string,
  files: string[],
  nodeArgs: string[] = [],
  windows: boolean = process.platform === 'win32',
): string[] {
  return ['--import', pathToFileURL(hook, { windows }).href, '--test', ...nodeArgs, ...files]
}

/**
 * Запустить `node --test` по найденным файлам. Пустой набор — ошибка (exit 1),
 * не «зелёный прогон ни по чему»: молчаливый успех на нуле тестов — худший вид
 * зелёного.
 */
export function runTests(o: RunTestsOptions): RunTestsResult {
  const target = o.target ?? '.'
  const dir = findTestTarget(target, { cwd: o.cwd, projectDir: o.projectDir, paths: o.paths })
  if (!dir) {
    process.stderr.write(`runz test: цель не найдена: ${target}\n`)
    return { exitCode: 1, files: [], dir: target }
  }
  const files = collectTestFiles(dir, o.filter)
  if (files.length === 0) {
    process.stderr.write(
      `runz test: в "${dir}" нет файлов *.test.ts` +
        (o.filter ? ` по фильтру "${o.filter}"` : '') + '\n',
    )
    return { exitCode: 1, files, dir }
  }

  const args = testArgv(registerHookPath(), files, o.nodeArgs)
  const r = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: fs.statSync(dir).isDirectory() ? dir : path.dirname(dir),
  })
  return { exitCode: r.status ?? 1, files, dir }
}
