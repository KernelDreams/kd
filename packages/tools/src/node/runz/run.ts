/**
 * Запуск процесса с раздельными потоками, хвостовой обрезкой, таймаутом и
 * отменой (спека §2). Про runz здесь ничего нет: argv целиком собирает
 * вызывающий, резолв скрипта — дело самого runz.
 *
 * Ошибки запуска (нет бинаря, нет каталога) — значение, а не исключение:
 * расширение отдаёт их модели текстом. Ненулевой exit — не ошибка запуска, а
 * обычный результат: stderr runz («script not found») модель увидит в нём.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'

export const DEFAULT_MAX_CHARS = 400_000
export const MAX_MAX_CHARS = 5_000_000
/** stderr — не больше этого, даже когда `maxChars` больше (§2). */
export const STDERR_MAX_CHARS = 20_000
export const DEFAULT_TIMEOUT_SEC = 300
export const MAX_TIMEOUT_SEC = 3_600
/** Пауза между SIGTERM и SIGKILL при таймауте и отмене. */
export const KILL_GRACE_MS = 2_000

export type RunzErrorCode =
  /** Кривые параметры: пустой скрипт, несуществующий cwd. */
  | 'bad_request'
  /** Процесс не стартовал: нет бинаря, нет прав. */
  | 'spawn'

export class RunzError extends Error {
  readonly code: RunzErrorCode

  constructor(code: RunzErrorCode, message: string) {
    super(message)
    this.name = 'RunzError'
    this.code = code
  }
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: RunzError }

/**
 * Хвост потока не длиннее `max` символов и полный счёт символов.
 *
 * Обрезка — с головы (остаётся конец), как `truncateTail` у bash в pi: у
 * скриптов итог и ошибки обычно в конце. Буфер схлопывается с запасом
 * (при 2×max), а не на каждом чанке — иначе slice на 400 К на каждые 64 КБ.
 */
export class TailBuffer {
  private text = ''
  private count = 0

  constructor(readonly max: number) {}

  push(chunk: string): void {
    this.count += chunk.length
    this.text += chunk
    if (this.text.length > this.max * 2) this.text = this.text.slice(-this.max)
  }

  /** Сколько символов пришло всего. */
  get total(): number {
    return this.count
  }

  get truncated(): boolean {
    return this.count > this.max
  }

  value(): string {
    if (this.text.length <= this.max) return this.text
    const tail = this.text.slice(-this.max)
    // Не начинать с половинки суррогатной пары.
    const first = tail.charCodeAt(0)
    return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
  }
}

export interface RunSpec {
  /** Полный argv: `[bin, ...args]`. */
  argv: string[]
  cwd: string
  stdin?: string
  maxChars: number
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface RunOutcome {
  /** `null` — процесс убит сигналом (таймаут, отмена). */
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** Обрезан stdout или stderr. */
  truncated: boolean
  /** Полная длина потоков до обрезки. */
  stdoutChars: number
  stderrChars: number
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const fail = (code: RunzErrorCode, message: string): RunResult<never> => ({ ok: false, error: new RunzError(code, message) })

/**
 * Windows: `.cmd`/`.bat` (так стоит runz — `S:\\bin\\runz.cmd`) Node без шелла не запускает (EINVAL, CVE-2024-27980) —
 * через `cmd.exe /d /s /c "…"`, каждый аргумент в кавычках (внутренние `"` удваиваются).
 */
export function spawnArgv(bin: string, args: readonly string[], win = process.platform === 'win32'): { file: string; args: string[]; verbatim: boolean } {
  if (!win || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args: [...args], verbatim: false }
  const q = (a: string): string => `"${a.replace(/"/g, '""')}"`
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin, ...args].map(q).join(' ')}"`], verbatim: true }
}

export function runProcess(spec: RunSpec): Promise<RunResult<RunOutcome>> {
  const [bin, ...args] = spec.argv
  if (!bin) return Promise.resolve(fail('bad_request', 'empty command'))
  if (!isDirectory(spec.cwd)) return Promise.resolve(fail('bad_request', `cwd is not a directory: ${spec.cwd}`))

  const stdout = new TailBuffer(spec.maxChars)
  const stderr = new TailBuffer(Math.min(spec.maxChars, STDERR_MAX_CHARS))
  // Своя группа процессов — чтобы таймаут убил и детей скрипта, а не только runz.
  const group = process.platform !== 'win32'
  const started = Date.now()

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const sp = spawnArgv(bin, args)
      child = spawn(sp.file, sp.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: group,
        windowsHide: true,
        windowsVerbatimArguments: sp.verbatim,
      })
    } catch (e) {
      resolve(fail('spawn', `${bin}: ${(e as Error).message}`))
      return
    }

    let settled = false
    let timedOut = false
    let aborted = false

    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, sig)
        // Windows: группы нет — дерево по pid (cmd.exe → node runz → дети)
        else if (process.platform === 'win32' && child.pid !== undefined) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else child.kill(sig)
      } catch {
        // Группа уже вышла.
      }
    }
    const stop = (): void => {
      kill('SIGTERM')
      // Не чистится на close: дети, пережившие SIGTERM, добиваются и после выхода runz.
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref()
    }
    const onAbort = (): void => {
      if (settled) return
      aborted = true
      stop()
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, spec.timeoutMs)

    const settle = (result: RunResult<RunOutcome>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    child.on('error', (e) => {
      // После успешного старта `error` — осечка kill/stdin, результат придёт с close.
      if (child.pid === undefined) settle(fail('spawn', `${bin}: ${e.message}`))
    })

    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (s: string) => stdout.push(s))
    child.stderr!.on('data', (s: string) => stderr.push(s))
    // Скрипт не читает stdin и вышел раньше — EPIPE не ошибка.
    child.stdin!.on('error', () => {})
    child.stdin!.end(spec.stdin ?? '')

    child.on('close', (code, signal) => {
      settle({
        ok: true,
        value: {
          exitCode: code,
          signal,
          stdout: stdout.value(),
          stderr: stderr.value(),
          truncated: stdout.truncated || stderr.truncated,
          stdoutChars: stdout.total,
          stderrChars: stderr.total,
          timedOut,
          aborted,
          durationMs: Date.now() - started,
        },
      })
    })

    if (spec.signal?.aborted) onAbort()
    else spec.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
