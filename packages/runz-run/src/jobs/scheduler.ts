/**
 * Планировщик задач (jobs-spec §2–§3): один проход {@link tick} под замком
 * реестра сверяет живость (`running` с мёртвым pid → `lost`/`cancelled`),
 * поднимает `lost` при `resume_lost` и запускает `queued`, пока свободны общий
 * слот и слоты всех ключей задачи.
 *
 * Проход делают все, кому есть что менять: постановка (`start`), конец задачи
 * (обёртка), резидентный цикл {@link scheduler} стенда — один на машину по
 * `<jobs>/.scheduler`. Двойного запуска нет: проход целиком под `<jobs>/.lock`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendLog, FINAL, jobsDir, listIds, pidAlive, readJob, tryLock, withLock, writeJob } from './registry.js'
import type { JobInfo } from './registry.js'
import { loadJobsConfig, type JobsConfig } from './recipe.js'

export interface RunnerOpts {
  /** Каталог реестра; default `RUNZ_JOBS_DIR` / `~/.runz/jobs`. */
  dir?: string
  /** Лимиты; default — `$jobs` конфига runz на каждый проход (правка конфига видна без рестарта). */
  config?: JobsConfig
  /** Команда runz для обёртки; default `runz` (+ PATH до ~/.local/bin, Homebrew). */
  runz?: string[]
}

/** Отмена, на которую обёртка не ответила за это время, добивается SIGKILL. */
const CANCEL_KILL_MS = 15_000

/** Этот модуль на диске: он же — точка входа обёртки (см. {@link wrapperMain}). */
const SELF = fileURLToPath(import.meta.url)

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Скрипт обёртки — сам этот модуль: в бандле (сайдкар exz вендорит пакет одним
 * файлом) рядом нет ни `cli.js`, ни `wrap.js`, а этот файл есть всегда. Из
 * исходников (тесты vitest, `.ts`) — собранный в `dist`.
 */
export function wrapScript(): string {
  if (!SELF.endsWith('.ts')) return SELF
  return fileURLToPath(new URL('../../dist/jobs/scheduler.js', import.meta.url))
}

/**
 * `node <модуль> job-wrap <id>`: обработчики сигналов — сразу (отмена может
 * прийти раньше, чем загрузится обёртка), обёртка — динамическим импортом.
 */
export function wrapperMain(id: string): void {
  const early = new AbortController()
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => early.abort())
  import('./wrap.js')
    .then(({ runWrapper }) => runWrapper(id, undefined, early.signal))
    .then(
      (code) => process.exit(code),
      (e: unknown) => {
        process.stderr.write(`job-wrap: ${(e as Error).message}\n`)
        process.exit(1)
      },
    )
}

if (process.argv[2] === 'job-wrap' && process.argv[3] && process.argv[1] && real(process.argv[1]) === real(SELF)) {
  wrapperMain(process.argv[3])
}

/** PATH для GUI-процесса (exz из Finder): runz и node — явно. */
export function runEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Предупреждения ноды (DEP0205 хука runz) — шум в логе и в колонке «шаг».
    NODE_NO_WARNINGS: '1',
    PATH: [dirname(process.execPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '']
      .filter(Boolean)
      .join(delimiter),
  }
}

/** Сигнал группе процессов (обёртка — лидер своей группы), иначе процессу. */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // процесса уже нет
    }
  }
}

const now = (): string => new Date().toISOString()

const SCOPE_ARGV = ['systemd-run', '--user', '--scope', '--quiet', '--collect']
let scopeOk: boolean | undefined

/** Процесс живёт в cgroup юнита systemd `*.service` (стенд, хаб, сервис хоста). */
export function inServiceCgroup(text?: string): boolean {
  let t = text
  if (t === undefined) {
    try {
      t = readFileSync('/proc/self/cgroup', 'utf8')
    } catch {
      return false
    }
  }
  return t.split('\n').some((l) => /\.service\/?$/.test(l.trim()))
}

/**
 * Префикс запуска обёртки вне cgroup сервиса. `detached` даёт свою группу и сессию,
 * но не свой cgroup: у юнитов systemd `KillMode=control-group`, и рестарт стенда
 * убивал обёртку вместе со стендом — задача кончалась `cancelled`, хотя её никто
 * не отменял (10.11). `systemd-run --scope` делает exec команды в своём
 * scope (pid — тот же). Не linux, не под сервисом, нет systemd-run / user-шины —
 * как раньше. `RUNZ_JOBS_SCOPE=0` — выключить.
 */
export function serviceScope(): string[] {
  if (process.platform !== 'linux' || process.env.RUNZ_JOBS_SCOPE === '0') return []
  if (process.env.RUNZ_JOBS_SCOPE !== '1' && !inServiceCgroup()) return []
  if (scopeOk === undefined) {
    const r = spawnSync(SCOPE_ARGV[0]!, [...SCOPE_ARGV.slice(1), 'true'], { stdio: 'ignore', timeout: 5_000 })
    scopeOk = r.status === 0
  }
  return scopeOk ? SCOPE_ARGV : []
}

/**
 * Запуск задачи обёрткой: отдельная сессия и группа (`detached`), stdio отвязан —
 * родитель (стенд, CLI) может умереть, лог пишет обёртка. Вызывать под замком.
 */
export function launch(dir: string, job: JobInfo, runz?: string[]): JobInfo {
  const env = runEnv()
  env.RUNZ_JOBS_DIR = dir
  if (runz) env.RUNZ_JOBS_RUNZ = JSON.stringify(runz)
  const scope = serviceScope()
  const argv = [...scope, process.execPath, wrapScript(), 'job-wrap', job.id]
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: existsSync(job.cwd) ? job.cwd : dir,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  const next: JobInfo = { ...job, status: 'running', started: now() }
  if (child.pid !== undefined) next.pid = child.pid
  delete next.ended
  delete next.exit
  delete next.child
  delete next.cancel
  delete next.output
  delete next.error
  writeJob(dir, next)
  appendLog(dir, job.id, { kind: 'start', pid: child.pid ?? null })
  return next
}

/** Занятость слотов идущими задачами: общий счёт и по ключам. */
function usage(running: JobInfo[]): { total: number; byKey: Map<string, number> } {
  const byKey = new Map<string, number>()
  for (const j of running) for (const k of new Set(j.keys)) byKey.set(k, (byKey.get(k) ?? 0) + 1)
  return { total: running.length, byKey }
}

export function fits(job: JobInfo, use: { total: number; byKey: Map<string, number> }, cfg: JobsConfig): boolean {
  if (use.total >= cfg.max) return false
  for (const k of new Set(job.keys)) {
    const limit = cfg.limits[k]
    if (limit !== undefined && (use.byKey.get(k) ?? 0) >= limit) return false
  }
  return true
}

export interface TickResult {
  launched: string[]
  lost: string[]
  resumed: string[]
}

/** Один проход планировщика (см. модуль). */
export async function tick(opts: RunnerOpts = {}): Promise<TickResult> {
  const dir = jobsDir(opts.dir)
  const cfg = opts.config ?? loadJobsConfig()
  return withLock(dir, () => {
    const res: TickResult = { launched: [], lost: [], resumed: [] }
    const running: JobInfo[] = []
    const queued: JobInfo[] = []
    for (const id of listIds(dir)) {
      let j = readJob(dir, id)
      // Задачи пула раздаёт центр (compute-pool-spec §2): ни живость по pid, ни запуск.
      if (!j || j.pool) continue
      if (j.status === 'running') {
        if (!pidAlive(j.pid)) {
          // Обёртка умерла, не записав конец: kill -9, машина, сбой.
          const status = j.cancel ? 'cancelled' : 'lost'
          j = { ...j, status, ended: now() }
          writeJob(dir, j)
          appendLog(dir, id, { kind: status === 'lost' ? 'lost' : 'end', status })
          if (status === 'lost') res.lost.push(id)
        } else {
          if (j.cancel && Date.now() - Date.parse(j.cancel) > CANCEL_KILL_MS) {
            signalGroup(j.child, 'SIGKILL')
            signalGroup(j.pid, 'SIGKILL')
          }
          running.push(j)
          continue
        }
      }
      if (j.status === 'lost' && cfg.resumeLost) {
        j = { ...j, status: 'queued', resumed: (j.resumed ?? 0) + 1 }
        delete j.ended
        writeJob(dir, j)
        appendLog(dir, id, { kind: 'resume', status: 'queued' })
        res.resumed.push(id)
      }
      if (j.status === 'queued') queued.push(j)
    }
    const use = usage(running)
    for (const j of queued) {
      if (!fits(j, use, cfg)) continue
      launch(dir, j, opts.runz)
      res.launched.push(j.id)
      use.total++
      for (const k of new Set(j.keys)) use.byKey.set(k, (use.byKey.get(k) ?? 0) + 1)
    }
    return res
  })
}

export interface Scheduler {
  /** Этот процесс — резидентный планировщик машины (держит `.scheduler`). */
  readonly active: boolean
  stop(): void
}

/**
 * Резидентный цикл (процесс стенда): держит `<jobs>/.scheduler` (один на машину;
 * держатель умер — замок забирает следующий), проход по таймеру и по изменению
 * реестра. Не держатель только ждёт своей очереди.
 */
/** Циклы этого процесса по каталогу: два сервиса одного процесса (jobs, forms) делят один. */
const loops = new Map<string, Scheduler>()

export function scheduler(opts: RunnerOpts & { intervalMs?: number; onError?: (e: unknown) => void } = {}): Scheduler {
  const dir = jobsDir(opts.dir)
  const existing = loops.get(dir)
  if (existing) return existing
  const s = startLoop(dir, opts)
  loops.set(dir, s)
  return s
}

function startLoop(dir: string, opts: RunnerOpts & { intervalMs?: number; onError?: (e: unknown) => void }): Scheduler {
  mkdirSync(dir, { recursive: true })
  const mark = join(dir, '.scheduler')
  const intervalMs = opts.intervalMs ?? 2_000
  let active = false
  let stopped = false
  let busy = false
  let again = false
  let watcher: FSWatcher | null = null

  const own = (): boolean => {
    if (active) {
      // Замок могли снять руками или перехватить после зависания — сверить.
      try {
        if (Number(readFileSync(mark, 'utf8').trim()) === process.pid) {
          writeFileSync(mark, `${process.pid}\n`) // mtime — признак жизни
          return true
        }
      } catch {
        // файла нет
      }
      active = false
    }
    if (tryLock(mark)) active = true
    return active
  }

  const run = async (): Promise<void> => {
    if (stopped) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      if (own()) await tick(opts)
    } catch (e) {
      opts.onError?.(e)
    } finally {
      busy = false
      if (again && !stopped) {
        again = false
        void run()
      }
    }
  }

  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  try {
    watcher = watch(dir, { persistent: false }, (_ev, name) => {
      if (name && !String(name).startsWith('.')) void run()
    })
  } catch {
    watcher = null
  }
  void run()

  return {
    get active() {
      return active
    },
    stop() {
      loops.delete(dir)
      stopped = true
      clearInterval(timer)
      watcher?.close()
      if (active) {
        try {
          if (Number(readFileSync(mark, 'utf8').trim()) === process.pid) rmSync(mark, { force: true })
        } catch {
          // уже снят
        }
      }
      active = false
    },
  }
}

export { FINAL }
