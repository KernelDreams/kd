/** Типы nr-pty: терминал, его состояние по меткам OSC 133 (§3), ответы `run`/`read` (§4). */

/**
 * Состояние терминала:
 * - `unknown` — сервер только поднялся, состояние ещё не восстановлено (`run` отвечает «занят»);
 * - `prompt` — промпт, строка ввода (возможно, пустая — проверяется по курсору);
 * - `input` — человек набирает (было нажатие после промпта);
 * - `running` — команда идёт (метка `C`, ещё нет `D`);
 * - `exited` — шелл кончился, сессии нет.
 */
export type TerminalState = 'unknown' | 'prompt' | 'input' | 'running' | 'exited'

export interface TerminalInfo {
  id: string
  /** Сессия tmux (`nr-<id>`). */
  session: string
  state: TerminalState
  /** Каталог шелла (`pane_current_path`). */
  cwd?: string
  /** Что сейчас на переднем плане (`pane_current_command`). */
  command?: string
  /** Клиентов tmux (вкладок) подключено. */
  attached: number
  /** Последняя законченная команда: код. */
  lastCode?: number
}

export type RunMode = 'insert' | 'execute'

export interface RunInput {
  /** Терминал; нет — последний активный. */
  terminal?: string
  command: string
  /** `execute` — Enter жмёт агент; `insert` — команда в строке, Enter жмёт человек. По умолчанию `execute`. */
  mode?: RunMode
  /** Сколько ждать конца команды, с. По умолчанию 120 (execute) / 600 (insert). */
  timeout?: number
  /** Сколько ждать пустого промпта, с. По умолчанию 15. */
  wait?: number
}

/**
 * Ответ `run`:
 * - `done` — команда кончилась: вывод между `C` и `D`, код из `D`;
 * - `busy` — промпт не пуст (человек набирает) или идёт команда — агент ничего не ввёл;
 * - `pending` — insert: команда стоит в строке, Enter человек не нажал до таймаута;
 * - `running` — команда идёт дольше таймаута (вывод — что успело прийти).
 */
export interface RunResult {
  status: 'done' | 'busy' | 'pending' | 'running'
  terminal: string
  code?: number
  output?: string
  /** Вывод обрезан с начала (хвост). */
  truncated?: boolean
  reason?: string
  ms?: number
}

export interface ReadInput {
  terminal?: string
  /** Последних строк экрана и истории, по умолчанию 50, не больше 2000. */
  lines?: number
}

export interface ReadResult {
  terminal: string
  state: TerminalState
  text: string
  cwd?: string
}
