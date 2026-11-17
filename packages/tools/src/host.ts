/**
 * Контракт процессов (из хост-контракта backend-nr): `exec`/`process`
 * ходят в {@link ProcessRegistry}, `find`/`grep` — в ускоритель {@link ExecHost}.
 * Реализация для Node — `@kerneldreams/tools/node`; в браузере их нет, и
 * тулы процессов просто не собираются.
 */

export interface ExecHost {
  /** Реестр фоновых процессов хоста: `sh -c`, вывод с курсором, kill группы. */
  processes: ProcessRegistry
  /**
   * Быстрый поиск внешним бинарём (`rg`/`fd` из PATH). Нет метода или бинаря —
   * `find`/`grep` идут своей реализацией над `fs`.
   */
  which?(bin: string): string | undefined
  /** Строки вывода процесса `bin args`; `stop` — убить. Для `rg`/`fd`. */
  lines?(bin: string, args: string[], signal: AbortSignal, onLine: (line: string, stop: () => void) => void): Promise<{ code: number | null; stderr: string; stopped: boolean }>
}

export type ProcStatus = 'running' | 'exited' | 'killed'

export interface ProcInfo {
  id: string
  sessionId: string
  command: string
  cwd: string
  pid?: number
  status: ProcStatus
  exitCode?: number | null
  signal?: string | null
  startedAt: number
  endedAt?: number
  /** Ушёл в фон (вывод читается `process poll`). */
  background: boolean
}

export interface ProcStartOptions {
  sessionId: string
  command: string
  cwd: string
  env?: Record<string, string>
  /** Время жизни, мс; 0/нет — без лимита. */
  timeoutMs?: number
  /**
   * Пароль по требованию процесса: хост ставит `SUDO_ASKPASS` на
   * хелпер, который спрашивает это — `sudo`/`ssh-askpass`-клиенты получают
   * пароль из окна чата. Пароль идёт процессу и нигде больше: не в вывод, не
   * в данные тула. `undefined`/throw — отказ (хелпер выходит с ошибкой).
   */
  askpass?: (prompt: string) => Promise<string | undefined>
  /** Отмена рана — kill (процессы, переживающие ран, — только при нормальном конце рана). */
  signal?: AbortSignal
}

/**
 * Реестр процессов `exec` (tools-spec §2). Живые процессы — по природе в
 * памяти хоста, который их запустил («только Node»).
 */
export interface ProcessRegistry {
  /** Чем исполняется команда — для описания тула модели: `sh -c` (по умолчанию) или `cmd.exe /c` (Windows). */
  shell?: string
  start(opts: ProcStartOptions): ProcInfo
  get(id: string): ProcInfo | undefined
  list(sessionId?: string): ProcInfo[]
  /** Ждать конца не дольше `ms` (или до отмены). true — завершился. */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<boolean>
  /** Ждать конца ИЛИ нового вывода не дольше `ms`. */
  waitOutput(id: string, ms: number, signal?: AbortSignal): Promise<void>
  /** Весь буфер (хвост) и сдвиг к концу курсора чтения. */
  output(id: string): { text: string; dropped: number }
  /** Вывод с курсора poll; курсор — в конец. */
  read(id: string): { text: string; skipped: number }
  markBackground(id: string): void
  write(id: string, input: string): boolean
  kill(id: string, signal?: string): boolean
  /** Забыть завершившийся процесс. */
  remove(id: string): void
  killSession(sessionId: string): number
  killAll(): number
}
