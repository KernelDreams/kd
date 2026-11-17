import { spawn, type SpawnOptions } from 'node:child_process'
import { type AsyncResult, ok, err } from '../infra/result.js'
import type { ExecOptions, ExecResult } from '../contracts/index.js'

/**
 * Примитив исполнения процессов — голый Node-IO, рядом с http/storage.
 * Ноль зависимостей (`child_process`). НЕ знает про Executor/блоки/формат —
 * платформо-нейтрален по отношению к NRD. Фундамент под `spawnExecutor` (nrd-exec).
 *
 * Все функции возвращают Result: предсказуемый исход (ненулевой код, ENOENT,
 * таймаут) — через err(), не throws. `ExecResult` доступен в обоих исходах —
 * на err он лежит в `ExecError.result` (stderr для диагностики).
 *
 * ExecOptions/ExecResult — типы переехали в @kerneldreams/nrd/contracts (ступень 1);
 * реализации (execShell/runFile) и класс ExecError остаются здесь.
 */
export type { ExecOptions, ExecResult } from '../contracts/index.js'

/**
 * Ошибка исполнения. Несёт `result` — `ExecResult` доступен и на провале
 * (ненулевой код / spawn-ошибка / таймаут), не только на успехе.
 */
export class ExecError extends Error {
  readonly result: ExecResult
  constructor(message: string, result: ExecResult) {
    super(message)
    this.name = 'ExecError'
    this.result = result
  }
}

/** Общий раннер поверх child_process.spawn. */
function run(
  command: string,
  args: string[],
  opts: ExecOptions,
  defaultShell: boolean,
): AsyncResult<ExecResult, ExecError> {
  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: opts.shell ?? defaultShell,
    }

    const child = spawn(command, args, spawnOpts)

    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let settled = false

    const finish = (r: Awaited<AsyncResult<ExecResult, ExecError>>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, opts.timeout)
    }

    // spawn-ошибка (ENOENT и т.д.) — процесс не стартовал.
    child.on('error', (e) => {
      finish(err(new ExecError(e.message, { stdout, stderr: stderr || e.message, code: -1 })))
    })

    child.on('close', (code, signal) => {
      const exitCode = code ?? -1
      const result: ExecResult = { stdout, stderr, code: exitCode }
      if (timedOut) {
        finish(err(new ExecError(`Process timed out after ${opts.timeout}ms`, result)))
      } else if (exitCode !== 0) {
        const reason = signal ? `killed by ${signal}` : `exited with code ${exitCode}`
        finish(err(new ExecError(`Process ${reason}`, result)))
      } else {
        finish(ok(result))
      }
    })

    // stdin: гасим EPIPE (процесс мог не читать ввод), затем закрываем поток.
    if (child.stdin) {
      child.stdin.on('error', () => {})
      if (opts.input !== undefined) child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

/**
 * Выполнить shell-команду. `child_process.spawn` с оболочкой по умолчанию
 * (команда — строка для шелла). Ноль зависимостей.
 */
export function execShell(cmd: string, opts: ExecOptions = {}): AsyncResult<ExecResult, ExecError> {
  return run(cmd, [], opts, true)
}

/**
 * Запустить файл: `node <path> args`. Без оболочки по умолчанию —
 * node вызывается напрямую (честные аргументы, без шелл-экранирования).
 */
export function runFile(
  path: string,
  args: string[] = [],
  opts: ExecOptions = {},
): AsyncResult<ExecResult, ExecError> {
  return run(process.execPath, [path, ...args], opts, false)
}
