// spawnExecutor — Node-реализация Executor поверх nr-infra.execShell / runFile.
// Spec: docs/specs/nrd-exec-spec.md §7.3, решения §11 B/F.
//
// Ступень `@kerneldreams/nrd/node` — браузерный бандл её не
// импортит, `zx` и `node:*` tree-shake-аются, `execBlock` остаётся portable.
//
// ts/zx исполняются через ВРЕМЕННЫЙ ФАЙЛ + `node` нативно (Node 24, без tsx) —
// честные стектрейсы с именем файла/строкой, zx работает (хочет файл-модуль).
// Решение §11 B: файл + ГАРАНТИРОВАННЫЙ cleanup в `try/finally` (иначе хвосты —
// в core видны 20 висячих `tmpclaude-*`).

import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
// Рантайм-примитивы (execShell/runFile/ExecError/generateId) остаются в nr-infra;
// Result/ok/err и типы ExecOptions/ExecResult — из канона contracts (ступень 1).
import { execShell, runFile, ExecError } from './exec.js'
import { generateId } from '../infra/id.js'
import {
  ok,
  err,
  type Result,
  type ExecOptions,
  type ExecResult,
} from '../contracts/index.js'
import type { Executor, ExecInput, ExecOutput, Engine } from '../exec/executor.js'

const SUPPORTS: ReadonlySet<Engine> = new Set<Engine>(['shell', 'ts', 'zx'])

const require = createRequire(import.meta.url)

/**
 * Абсолютный `import` для `zx/globals`. Временный файл лежит в `tmpdir()` —
 * вне node_modules nrd-exec, поэтому голый `import 'zx/globals'` не резолвится.
 * Резолвим `zx` относительно ЭТОГО модуля (где он установлен) и инъектируем
 * абсолютный file-URL. Кэшируем. `zx` не установлен → внятная ошибка.
 */
let zxImportCache: string | undefined
function zxGlobalsImport(): string {
  if (zxImportCache === undefined) {
    zxImportCache = `import ${JSON.stringify(pathToFileURL(require.resolve('zx/globals')).href)}\n`
  }
  return zxImportCache
}

/** ExecInput → ExecOptions примитива nr-infra. */
function toOptions(input: ExecInput): ExecOptions {
  return {
    cwd: input.cwd,
    env: input.env,
    timeout: input.timeout,
    input: input.input,
  }
}

/**
 * Result<ExecResult, ExecError> примитива → Result<ExecOutput>.
 *
 * Ключевой момент: ненулевой код процесса nr-infra отдаёт как `err(ExecError)`,
 * но `ExecResult` лежит в `error.result`. Для контракта Executor это НЕ ошибка
 * executor'а — разворачиваем обратно в `ok(ExecOutput)` с реальным `code`,
 * чтобы `execBlock` сам решил по §6. `err` оставляем только для подлинного
 * сбоя spawn без результата.
 */
function toOutput(r: Result<ExecResult, ExecError>): Result<ExecOutput> {
  if (r.ok) {
    return ok({ stdout: r.value.stdout, stderr: r.value.stderr, code: r.value.code })
  }
  const e = r.error
  if (e instanceof ExecError) {
    return ok({ stdout: e.result.stdout, stderr: e.result.stderr, code: e.result.code })
  }
  return err(e)
}

/**
 * spawnExecutor — Node executor. `supports = {shell, ts, zx}`.
 * - shell → `execShell(code, opts)` (системная оболочка).
 * - ts/zx → временный `.mts` + `runFile` (node нативно стрипит типы); zx
 *   инъектирует `import 'zx/globals'`. Временный файл всегда удаляется в `finally`.
 */
export const spawnExecutor: Executor = {
  id: 'spawn',
  supports: SUPPORTS,

  async run(input: ExecInput): Promise<Result<ExecOutput>> {
    if (!SUPPORTS.has(input.engine)) {
      return err(new Error(`spawnExecutor: движок "${input.engine}" не поддерживается`))
    }

    const opts = toOptions(input)

    if (input.engine === 'shell') {
      return toOutput(await execShell(input.code, opts))
    }

    // ts / zx — временный файл-модуль (.mts → всегда ESM: top-level await, import).
    const file = join(tmpdir(), `nrd-exec-${generateId()}.mts`)
    let body: string
    try {
      body = input.engine === 'zx' ? `${zxGlobalsImport()}${input.code}` : input.code
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)))
    }
    try {
      await writeFile(file, body, 'utf8')
      return toOutput(await runFile(file, [], opts))
    } finally {
      // §11 B: гарантированный cleanup — никаких висячих временных файлов.
      await rm(file, { force: true })
    }
  },
}
