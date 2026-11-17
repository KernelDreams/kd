/**
 * Терминал глазами агента (спека §2–4): хвост файла, куда `tmux pipe-pane -O` пишет сырой вывод
 * панели (метки OSC 133 доходят только так — через attach tmux перерисовывает экран сам), состояние
 * по меткам, ожидание пустого промпта, вывод команды между `C` и `D`.
 *
 * `pipe-pane` пишет в файл процессом `cat`, который живёт вместе с сессией: рестарт сервера вывод
 * не теряет, новый процесс дочитывает файл и восстанавливает состояние по хвосту и `pane_current_command`.
 */

import { closeSync, fstatSync, ftruncateSync, openSync, readSync, watch, type FSWatcher } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { cook, Osc133Parser, tail, type StreamEvent } from './osc.js'
import { isMissing, shQuote, type Tmux } from './tmux.js'
import type { RunInput, RunResult, TerminalInfo, TerminalState } from './types.js'

/** Хвост вывода команды агенту: строк и символов. */
const OUT_LINES = 400
const OUT_CHARS = 40_000
/** Сырой вывод идущей команды в памяти — не больше (держим хвост). */
const RAW_CAP = 2 * 1024 * 1024
/** Файл потока больше — обнуляем между командами (`cat >>` пишет с O_APPEND, продолжит с нуля). */
const LOG_ROTATE = 8 * 1024 * 1024
/** При восстановлении читаем столько с конца файла, чтобы найти последние метки. */
const RESTORE_TAIL = 256 * 1024

/** Окно после нажатия человека, мс. */
const HUMAN_GRACE_MS = 400

/**
 * Не набор: ответы терминала — DA1/DA2 (`CSI ? … c`, `CSI > … c`), DSR/CPR (`CSI … n|R`), фокус (`CSI I|O`),
 * OSC, DCS; отчёты мыши (`mouse on` tmux) — SGR `CSI < b;x;y M|m` и X10 `CSI M` + 3 байта.
 */
const TERMINAL_REPLY = /\x1b\[[?>=]?[\d;]*[cnR]|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g

export function isHumanInput(data: string): boolean {
  return data.replace(TERMINAL_REPLY, '') !== ''
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', '-zsh', '-bash', '-sh', 'login'])

interface Finished {
  seq: number
  code?: number
  raw: string
}

export class Terminal {
  readonly session: string
  /** Цель tmux: точное имя сессии (`nr-a` не совпадёт с `nr-ab`). */
  private readonly target: string
  state: TerminalState = 'unknown'
  lastCode: number | undefined
  /** Счётчик меток `C`: команда агента — первая `C` после его ввода. */
  private seq = 0
  private raw = ''
  private finished: Finished | null = null
  private parser = new Osc133Parser()
  private decoder = new StringDecoder('utf8')
  private fd: number | null = null
  private offset = 0
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private waiters = new Set<() => void>()
  private listeners = new Set<(state: TerminalState) => void>()
  /** Курсор и текст строки промпта на метке `B`: пустой ли ввод — сравнением. */
  private promptAt: { x: number; text: string } | null = null
  private promptProbe: Promise<void> | null = null
  /** Одна команда агента за раз. */
  private lock: Promise<unknown> = Promise.resolve()
  lastActive = Date.now()
  /** Последнее нажатие человека: эхо до экрана доходит не сразу — в это окно промпт не считается пустым. */
  private lastHuman = 0

  constructor(
    readonly id: string,
    private readonly tmux: Tmux,
    readonly logFile: string,
    private readonly log: (m: string) => void,
  ) {
    this.session = `nr-${id}`
    this.target = `=nr-${id}:`
  }

  // ── поток ────────────────────────────────────────────────────────────────

  /**
   * Подключить поток: `pipe-pane` в файл (если ещё не висит) и хвост файла. `fresh` — сессия
   * только что создана: читать с начала. Иначе — восстановить состояние по хвосту файла.
   */
  async start(fresh: boolean): Promise<void> {
    const piping = (await this.display('#{pane_pipe}')).trim() === '1'
    if (fresh || !piping) {
      // Новый файл (O_TRUNC через `>`): старый поток прежней сессии с тем же id не нужен.
      if (fresh) closeSync(openSync(this.logFile, 'w', 0o600))
      await this.tmux.run(['pipe-pane', '-O', '-t', this.target, `exec cat >> ${shQuote(this.logFile)}`])
    }
    this.fd = openSync(this.logFile, 'a+', 0o600)
    const size = fstatSync(this.fd).size
    if (fresh) {
      this.offset = 0
    } else {
      // Восстановление (§2): последние метки из хвоста файла, потом — сверка с тем, что на переднем плане.
      const from = Math.max(0, size - RESTORE_TAIL)
      const buf = Buffer.alloc(size - from)
      readSync(this.fd, buf, 0, buf.length, from)
      this.offset = size
      let state: TerminalState = 'unknown'
      for (const ev of new Osc133Parser().feed(buf.toString('utf8'))) {
        if (ev.type !== 'mark') continue
        if (ev.kind === 'C') state = 'running'
        else if (ev.kind === 'A' || ev.kind === 'B' || ev.kind === 'D') state = 'prompt'
        if (ev.kind === 'D' && ev.code !== undefined) this.lastCode = ev.code
      }
      const fg = await this.foreground()
      const shell = fg !== '' && SHELLS.has(fg)
      // Меток нет (шелл без хуков) или они расходятся с передним планом — верим переднему плану.
      if (state === 'unknown' || (state === 'running' && shell) || (state === 'prompt' && !shell)) state = shell ? 'prompt' : 'running'
      this.setState(state)
      if (state === 'prompt') await this.probePrompt()
    }
    this.watcher = watch(this.logFile, () => this.pump())
    this.watcher.on('error', () => {})
    this.timer = setInterval(() => this.pump(), 1000)
    this.timer.unref()
    this.pump()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.fd !== null) closeSync(this.fd)
    this.fd = null
    for (const w of this.waiters) w()
  }

  /** Дочитать файл потока. */
  pump(): void {
    if (this.fd === null) return
    let size: number
    try {
      size = fstatSync(this.fd).size
    } catch {
      return
    }
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return
    const buf = Buffer.alloc(Math.min(size - this.offset, 1024 * 1024))
    const n = readSync(this.fd, buf, 0, buf.length, this.offset)
    this.offset += n
    const text = this.decoder.write(buf.subarray(0, n))
    if (text) for (const ev of this.parser.feed(text)) this.onEvent(ev)
    if (this.offset < size) setImmediate(() => this.pump())
    else this.maybeRotate()
  }

  private maybeRotate(): void {
    if (this.fd === null || this.offset < LOG_ROTATE || this.state === 'running') return
    try {
      ftruncateSync(this.fd, 0)
      this.offset = 0
    } catch (err) {
      this.log(`${this.session}: обнулить поток: ${String(err)}`)
    }
  }

  private onEvent(ev: StreamEvent): void {
    if (ev.type === 'text') {
      if (this.state === 'running') {
        this.raw += ev.data
        if (this.raw.length > RAW_CAP) this.raw = this.raw.slice(-RAW_CAP / 2)
      }
      return
    }
    switch (ev.kind) {
      case 'A':
        this.promptAt = null
        this.setState('prompt')
        break
      case 'B':
        this.setState('prompt')
        void this.probePrompt()
        break
      case 'C':
        this.seq++
        this.raw = ''
        this.promptAt = null
        this.setState('running')
        break
      case 'D':
        if (this.state === 'running' || this.raw) {
          this.finished = { seq: this.seq, ...(ev.code !== undefined ? { code: ev.code } : {}), raw: this.raw }
        }
        if (ev.code !== undefined) this.lastCode = ev.code
        this.raw = ''
        this.setState('prompt')
        break
    }
    this.wake()
  }

  private setState(s: TerminalState): void {
    if (this.state === s) return
    this.state = s
    for (const l of this.listeners) l(s)
  }

  onState(fn: (state: TerminalState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private wake(): void {
    for (const w of [...this.waiters]) w()
  }

  /** Ждать, пока `ok()` не станет истинным (проверка на каждом событии и раз в 100 мс), не дольше `ms`. */
  private until(ok: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      let checking = false
      const finish = (v: boolean) => {
        if (done) return
        done = true
        this.waiters.delete(check)
        clearInterval(poll)
        clearTimeout(timeout)
        resolve(v)
      }
      const check = () => {
        if (done || checking) return
        checking = true
        Promise.resolve(ok())
          .then((v) => {
            checking = false
            if (v) finish(true)
            else if (this.fd === null) finish(false)
          })
          .catch(() => {
            checking = false
          })
      }
      const poll = setInterval(() => {
        this.pump()
        check()
      }, 100)
      const timeout = setTimeout(() => finish(false), ms)
      this.waiters.add(check)
      check()
    })
  }

  // ── человек ──────────────────────────────────────────────────────────────

  /**
   * Байты из вкладки: нажатия человека — после промпта «идёт ввод». Автоответы терминала на запросы
   * tmux (DA, отчёт курсора, фокус, OSC-ответы) — не ввод: их xterm шлёт сам при подключении.
   */
  noteInput(data: string): void {
    if (!isHumanInput(data)) return
    this.lastActive = this.lastHuman = Date.now()
    if (this.state === 'prompt') this.setState('input')
  }

  // ── промпт ───────────────────────────────────────────────────────────────

  /** Запомнить курсор и строку промпта сразу после метки `B`. */
  private probePrompt(): Promise<void> {
    const p = (async () => {
      try {
        const at = await this.cursor()
        if (at) this.promptAt = { x: at.x, text: at.line.slice(0, at.x) }
      } catch {
        this.promptAt = null
      }
    })()
    this.promptProbe = p
    return p
  }

  private async cursor(): Promise<{ x: number; y: number; line: string } | null> {
    const pos = (await this.display('#{cursor_x} #{cursor_y}')).trim().split(' ')
    const x = Number(pos[0])
    const y = Number(pos[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const line = (await this.tmux.run(['capture-pane', '-p', '-t', this.target, '-S', String(y), '-E', String(y)])).replace(/\n$/, '')
    return { x, y, line }
  }

  /**
   * Промпт пуст: метка `B` была, курсор там же, где после неё, строка до курсора — тот же промпт,
   * после курсора — пусто. Человек стёр набранное — снова пусто, состояние возвращается в `prompt`.
   */
  async promptEmpty(): Promise<boolean> {
    if (this.state !== 'prompt' && this.state !== 'input') return false
    if (Date.now() - this.lastHuman < HUMAN_GRACE_MS) return false
    if (this.promptProbe) await this.promptProbe
    if (!this.promptAt) return this.state === 'prompt'
    const at = await this.cursor()
    if (!at) return false
    const empty = at.x === this.promptAt.x && at.line.slice(0, at.x) === this.promptAt.text && at.line.slice(at.x).trim() === ''
    if (empty && this.state === 'input') this.setState('prompt')
    return empty
  }

  // ── агент ────────────────────────────────────────────────────────────────

  /** §4: дождаться пустого промпта, ввести команду, дождаться `C`…`D`. Команды агента — по одной. */
  run(input: RunInput): Promise<RunResult> {
    const next = this.lock.then(() => this.runNow(input))
    this.lock = next.catch(() => {})
    return next
  }

  private async runNow(input: RunInput): Promise<RunResult> {
    const t0 = Date.now()
    const mode = input.mode ?? 'execute'
    const base = { terminal: this.id }
    const waitMs = Math.max(0, input.wait ?? 15) * 1000
    // свежий терминал: шелл ещё не показал первый промпт — ждём его в пределах того же срока, а не отказываем сразу
    if (this.state === 'unknown') await this.until(async () => this.state !== 'unknown', waitMs)
    if (this.state === 'unknown') return { ...base, status: 'busy', reason: 'терминал ещё не готов: шелл не показал промпт (запуск или восстановление после перезапуска сервера)' }
    if (this.state === 'exited') return { ...base, status: 'busy', reason: 'шелл терминала кончился' }
    const free = await this.until(() => this.promptEmpty(), waitMs)
    if (!free) {
      const reason = this.state === 'running' ? 'в терминале идёт команда' : 'терминал занят человеком: в строке набран текст'
      return { ...base, status: 'busy', reason }
    }
    const command = input.command.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    const before = this.seq
    this.lastActive = Date.now()
    await this.tmux.run(['send-keys', '-t', this.target, '-l', '--', command])
    if (mode === 'execute') await this.tmux.run(['send-keys', '-t', this.target, 'Enter'])
    else this.setState('input')
    const limitMs = Math.max(1, input.timeout ?? (mode === 'insert' ? 600 : 120)) * 1000
    const started = await this.until(() => this.seq > before, limitMs)
    if (!started) {
      if (mode === 'insert') return { ...base, status: 'pending', reason: 'команда стоит в строке, Enter не нажат', ms: Date.now() - t0 }
      return { ...base, status: 'running', reason: 'команда не стартовала (нет метки C)', ms: Date.now() - t0 }
    }
    const mine = before + 1
    const ended = await this.until(() => (this.finished?.seq ?? 0) >= mine, Math.max(0, limitMs - (Date.now() - t0)))
    if (!ended || !this.finished) {
      const out = tail(cook(this.raw), OUT_LINES, OUT_CHARS)
      return { ...base, status: 'running', output: out.text, ...(out.cut ? { truncated: true } : {}), reason: 'команда ещё идёт', ms: Date.now() - t0 }
    }
    const fin = this.finished
    const out = tail(cook(fin.raw), OUT_LINES, OUT_CHARS)
    return {
      ...base,
      status: 'done',
      ...(fin.code !== undefined ? { code: fin.code } : {}),
      output: out.text,
      ...(out.cut ? { truncated: true } : {}),
      ...(fin.seq !== mine ? { reason: 'после команды агента успела пройти ещё одна — вывод последней' } : {}),
      ms: Date.now() - t0,
    }
  }

  /** §4 `terminal.read`: последние строки экрана и истории, без escape-последовательностей. */
  async read(lines: number): Promise<string> {
    const n = Math.max(1, Math.min(2000, Math.floor(lines)))
    const text = await this.tmux.run(['capture-pane', '-p', '-J', '-t', this.target, '-S', String(-n)])
    const all = text.split('\n').map((l) => l.trimEnd())
    while (all.length && all[all.length - 1] === '') all.pop()
    return all.slice(-n).join('\n')
  }

  async info(attached = 0): Promise<TerminalInfo> {
    const [command, ...rest] = (await this.display('#{pane_current_command}|||#{pane_current_path}')).replace(/\n$/, '').split('|||')
    const cwd = rest.join('|||')
    return {
      id: this.id,
      session: this.session,
      state: this.state,
      ...(cwd ? { cwd } : {}),
      ...(command ? { command } : {}),
      attached,
      ...(this.lastCode !== undefined ? { lastCode: this.lastCode } : {}),
    }
  }

  private async foreground(): Promise<string> {
    return (await this.display('#{pane_current_command}')).trim()
  }

  private async display(fmt: string): Promise<string> {
    try {
      return await this.tmux.run(['display-message', '-p', '-t', this.target, fmt])
    } catch (err) {
      if (isMissing(err)) {
        this.setState('exited')
        return ''
      }
      throw err
    }
  }
}
