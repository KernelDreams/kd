/**
 * Запуск шаблона через `runz <файл> --runz-json` (forms-spec §4.1; пришло из
 * pi-ext-image, image-chat-spec §4.1).
 *
 * Отдельный процесс, а не импорт атома: у appz нет package.json, его зависимости
 * резолвит хук runz; а отмена — это SIGTERM процессу, на который comfy отвечает
 * `/interrupt` серверу (иначе стоп не останавливал бы GPU на PC).
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { ScriptArtifact } from '@kerneldreams/nrd/contracts'
import { materialize, type TemplateValues } from './template.js'

export type { ScriptArtifact }

export interface RunResult {
  /** Атом отработал: код 0 и в stdout есть JSON-результат. Пустые `outputs` — не отказ. */
  ok: boolean
  /** `ScriptResult.outputs` — что атом произвёл. */
  outputs: ScriptArtifact[]
  /** Сводка/ошибка атома (`ScriptResult.output`) или причина отказа запуска. */
  output: string
  exitCode: number | null
  ms: number
  aborted: boolean
  timedOut: boolean
  /** Хвост stderr — для диагностики. */
  stderr: string
}

export interface RunOpts {
  /** Путь к шаблону (`.md`/`.mdz`). */
  template: string
  /** Значения полей: скаляр или список (`$[…]`). */
  values: TemplateValues
  /** Команда runz: бинарь и префикс аргументов (`['runz']`, `[node, script]`). */
  runz: string[]
  signal?: AbortSignal | undefined
  timeoutMs: number
  /** Окружение процесса; по умолчанию `process.env` (GUI-хосту нужен свой PATH до runz/node). */
  env?: NodeJS.ProcessEnv | undefined
  /** Строка вывода по мере появления — как у {@link RunFileOpts.onLine}. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

/**
 * Запуск файла как есть (open-spec §6 «Запуск»): `runz <файл> <args…> --runz-json`
 * без материализации — документ исполняется сам, аргументы CLI перекрывают его
 * атрибуты. Строки stdout/stderr приходят по мере вывода.
 */
export interface RunFileOpts {
  /** Путь к документу runz. */
  file: string
  /** Аргументы CLI после файла (`--prompt=кот`). */
  args?: string[]
  runz: string[]
  signal?: AbortSignal | undefined
  /** Таймаут, мс; `0` — без таймаута (задачи, jobs-spec §2). */
  timeoutMs: number
  env?: NodeJS.ProcessEnv | undefined
  /** Рабочий каталог процесса; default — каталог файла. */
  cwd?: string
  /**
   * Строка вывода. Последняя строка stdout — JSON-результат `--runz-json`: её
   * разбирает {@link parseResult}, сюда она не приходит.
   */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
  /** Пауза между SIGTERM и SIGKILL при отмене/таймауте; default 5 с (задачи — 10 с). */
  killGraceMs?: number
  /** pid процесса runz сразу после запуска — задачи пишут его в реестр. */
  onSpawn?: (pid: number) => void
  /**
   * Не runz, а произвольная команда (задача-команда jobs): `[...runz, file, ...args]` без
   * `--runz-json`; итог — код выхода (0 — ok), все строки stdout — вывод.
   */
  raw?: boolean
}

const KILL_GRACE_MS = 5_000
const STDERR_TAIL = 4_000

/**
 * Живые запуски процесса-хоста. Хост может выйти посреди генерации (закрыли
 * окно exz, sidecar завершился) — `finally` тогда не случится: без этой уборки
 * файл запуска остался бы рядом с шаблоном, а runz — висеть сиротой с GPU.
 */
const temps = new Set<string>()
const children = new Set<ReturnType<typeof spawn>>()
let exitHook = false

/**
 * Уборка при выходе хоста: гасим живые runz и удаляем ТОЛЬКО свои временные
 * файлы запуска. Файл, переданный в {@link runFile}, — чужой (документ
 * пользователя), его не трогаем никогда (раньше общий реестр стирал
 * его при выходе, если в процессе до этого звался runTemplate).
 */
function ensureExitHook(): void {
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const child of children) signalTree(child, 'SIGTERM')
    for (const file of temps) rmSync(file, { force: true })
  })
}

/** runz запускается своей группой процессов (кроме Windows): отмена гасит и детей `$shell`. */
const GROUP = process.platform !== 'win32'

/** Метасимволы cmd: экранируются `^` (схема cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Аргумент для `cmd /s /c "…"`: кавычки по правилам CRT, затем `^` перед метасимволами. */
function cmdArg(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`.replace(CMD_META, '^$1')
  return doubleEscape ? a.replace(CMD_META, '^$1') : a
}

export interface SpawnCommand {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/**
 * Чем запустить `runz`. На Windows `runz` из PATH — `runz.cmd`:
 * `spawn` без оболочки его не находит (ENOENT), а `.cmd` напрямую нода не
 * запускает (EINVAL). Поэтому не-`.exe` идёт через `cmd.exe /d /s /c` одной
 * строкой: каждый аргумент в кавычках, метасимволы — через `^`, у `.cmd`-шима
 * дважды (шим передаёт `%*` в `cmd` ещё раз). `shell: true` с интерполяцией не
 * используем. `[node, runz.ts]` и прочие `.exe` — напрямую, как на POSIX.
 */
export function spawnCommand(runz: string[], args: string[], platform: NodeJS.Platform = process.platform): SpawnCommand {
  const [bin = 'runz', ...pre] = runz
  const argv = [...pre, ...args]
  if (platform !== 'win32' || /\.(exe|com)$/i.test(bin)) return { command: bin, args: argv }
  const shim = !/\.[^\\/.]+$/.test(bin) || /\.(cmd|bat)$/i.test(bin)
  const line = [bin.replace(CMD_META, '^$1'), ...argv.map((a) => cmdArg(a, shim))].join(' ')
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

/**
 * Погасить дерево на Windows: `taskkill /T /F` по pid — только этого процесса
 * и его детей, не по имени. Сигналов там нет, а `child.kill` убил бы один
 * `cmd.exe`, оставив runz под ним.
 */
function killTreeWin(pid: number): void {
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/**
 * Сигнал процессу runz и его детям: `$shell`-блок держит stdout внуком (`sleep`),
 * и одному runz SIGTERM оставил бы его сиротой, а `close` ждал бы его конца.
 */
function signalTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid !== undefined && child.exitCode === null) {
    killTreeWin(child.pid)
    return
  }
  if (GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // группы уже нет — добьём сам процесс
    }
  }
  child.kill(signal)
}

function track(runFile: string): void {
  temps.add(runFile)
  ensureExitHook()
}

export async function runTemplate(opts: RunOpts): Promise<RunResult> {
  const started = Date.now()
  const text = readFileSync(opts.template, 'utf8')
  // Рядом с шаблоном: его относительные `$[[…]]` и пути резолвятся как у оригинала.
  const ext = extname(opts.template) || '.md'
  const runFile = join(
    dirname(opts.template),
    `.${basename(opts.template, ext)}.run-${randomBytes(4).toString('hex')}${ext}`,
  )
  writeFileSync(runFile, materialize(text, opts.values))
  track(runFile)
  try {
    return await spawnRunz(opts, runFile, started)
  } finally {
    temps.delete(runFile)
    rmSync(runFile, { force: true })
  }
}

/** `runz <файл> <args…> --runz-json` со строками вывода; файл не копируется. */
export function runFile(opts: RunFileOpts): Promise<RunResult> {
  return spawnRunz(opts, opts.file, Date.now(), opts.args ?? [])
}

type Parsed = Omit<RunResult, 'ms' | 'aborted' | 'timedOut' | 'stderr'>

/**
 * Построчный разбор потока. stdout держит до следующей строки только строку,
 * похожую на JSON-результат (объект): она может оказаться итогом `--runz-json`,
 * а он — не вывод скрипта. Обычная строка уходит сразу — иначе `line 1` долгого
 * шага приходила бы только со следующей строкой.
 */
function lineSplitter(emit: (line: string) => void, holdLast: boolean): { push(chunk: string): void; end(): string } {
  let buf = ''
  let held: string | null = null
  const out = (line: string): void => {
    if (!holdLast) return emit(line)
    if (held !== null) emit(held)
    held = null
    if (isResultLine(line)) held = line
    else emit(line)
  }
  return {
    push(chunk) {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        out(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
    },
    /** Хвост без перевода строки; у stdout — вместе с удержанной строкой, если та не результат. */
    end() {
      if (buf !== '') out(buf.replace(/\r$/, ''))
      buf = ''
      const last = held ?? ''
      held = null
      return last
    },
  }
}

function spawnRunz(
  opts: Pick<RunFileOpts, 'runz' | 'signal' | 'timeoutMs' | 'env' | 'cwd' | 'onLine' | 'killGraceMs' | 'onSpawn' | 'raw'>,
  runFile: string,
  started: number,
  args: string[] = [],
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let aborted = false
    let timedOut = false
    let settled = false
    const done = (r: Parsed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, ms: Date.now() - started, aborted, timedOut, stderr: stderr.slice(-STDERR_TAIL) })
    }

    let child: ReturnType<typeof spawn>
    try {
      const cmd = spawnCommand(opts.runz, opts.raw ? [runFile, ...args] : [runFile, ...args, '--runz-json'])
      child = spawn(cmd.command, cmd.args, {
        windowsVerbatimArguments: cmd.windowsVerbatimArguments ?? false,
        cwd: opts.cwd ?? dirname(runFile),
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: GROUP,
      })
    } catch (err) {
      done({ ok: false, outputs: [], output: `runz failed to start: ${(err as Error).message}`, exitCode: null })
      return
    }

    children.add(child)
    ensureExitHook()
    if (child.pid !== undefined) opts.onSpawn?.(child.pid)
    child.once('close', () => children.delete(child))
    child.once('error', () => children.delete(child))

    const kill = () => {
      signalTree(child, 'SIGTERM')
      setTimeout(() => signalTree(child, 'SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS).unref()
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    // Без таймаута (задачи): 0 или не число — таймера нет; setTimeout(Infinity) сработал бы сразу.
    const timer =
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, opts.timeoutMs)
        : undefined
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const onLine = opts.onLine
    const outLines = onLine ? lineSplitter((l) => onLine('stdout', l), !opts.raw) : null
    const errLines = onLine ? lineSplitter((l) => onLine('stderr', l), false) : null
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      stdout += c
      outLines?.push(c)
    })
    child.stderr?.setEncoding('utf8').on('data', (c: string) => {
      stderr += c
      errLines?.push(c)
      if (stderr.length > STDERR_TAIL * 4) stderr = stderr.slice(-STDERR_TAIL * 2)
    })
    child.on('error', (err) => done({ ok: false, outputs: [], output: `runz failed to start: ${err.message}`, exitCode: null }))
    child.on('close', (code) => {
      errLines?.end()
      const parsed: Parsed = opts.raw ? { ok: code === 0, outputs: [], output: stdout.trimEnd().split('\n').slice(-40).join('\n'), exitCode: code } : parseResult(stdout, code)
      // Последняя строка не JSON — это вывод скрипта, а не результат: отдать её тоже.
      const last = outLines?.end() ?? ''
      if (onLine && last !== '' && !isResultLine(last)) onLine('stdout', last)
      done(parsed)
    })
  })
}

/** Артефакт `ScriptResult.outputs`, проверенный по форме; чужое — null. */
function toArtifact(o: unknown): ScriptArtifact | null {
  if (!o || typeof o !== 'object') return null
  const a = o as { type?: unknown; text?: unknown; path?: unknown; meta?: unknown; name?: unknown }
  const name = typeof a.name === 'string' && a.name !== '' ? { name: a.name } : {}
  if (a.type === 'text' && typeof a.text === 'string') return { type: 'text', text: a.text, ...name }
  if (a.type === 'file' && typeof a.path === 'string') return { type: 'file', path: a.path, ...name }
  if (a.type === 'image' && typeof a.path === 'string') {
    return a.meta && typeof a.meta === 'object'
      ? { type: 'image', path: a.path, meta: a.meta as Record<string, unknown>, ...name }
      : { type: 'image', path: a.path, ...name }
  }
  return null
}

function isResultLine(line: string): boolean {
  try {
    const v = JSON.parse(line) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/** Последняя непустая строка stdout — `ScriptResult` (`--runz-json`). */
export function parseResult(stdout: string, exitCode: number | null): Parsed {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  let result: { output?: unknown; exitCode?: unknown; outputs?: unknown } | undefined
  try {
    result = JSON.parse(line)
  } catch {
    result = undefined
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, outputs: [], output: stdout.trim() || 'runz: no JSON result', exitCode }
  }
  const outputs: ScriptArtifact[] = []
  if (Array.isArray(result.outputs)) {
    for (const o of result.outputs) {
      const a = toArtifact(o)
      if (a) outputs.push(a)
    }
  }
  const code = typeof result.exitCode === 'number' ? result.exitCode : exitCode
  return {
    ok: (code ?? 0) === 0,
    outputs,
    output: typeof result.output === 'string' ? result.output : '',
    exitCode: code,
  }
}
