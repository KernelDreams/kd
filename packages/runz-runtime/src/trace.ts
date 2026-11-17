/**
 * @kerneldreams/runz-runtime — след прогона `run.trace.jsonl` (pipeline-run-spec §2.1).
 *
 * runz пишет след сам, рецепты не правятся: строка файла — событие
 * `{t, ev, step?, part?, ms?, model?, tokens_in?, tokens_out?, cost?, out?, ok?, error?}`,
 * `ev` — `run.start` · `step.start` · `step.end` · `llm` · `run.end`.
 *
 *   - шаги блокнота и `helpers.run(id)` (вложенный `runFn`) — `step.start`/`step.end`;
 *     верхний `fn` (`$run`, `## $handler`) — сам прогон, шагом не считается;
 *   - `helpers.llm` / сессии `helpers.agent` — `llm` с текущим шагом и частью;
 *   - `helpers.step(id, {part?, out?, icon?, title?})` → `end()` — шаг внутри одного тела
 *     (bot-fix, стол стендов); третьим аргументом можно отдать функцию — шаг вокруг неё.
 *
 * Где: `$out` прогона (от cwd запуска, как у рецептов) — иначе `<папка документа>/.runz/runs/<id>/`.
 * Файл создаётся по первому событию шага или модели: прогон без шагов (`--run=help`) следа не
 * оставляет. Прошлый след той же папки переименовывается в `run.trace.<время>.jsonl`.
 * `RUNZ_TRACE=off` — не писать; `RUNZ_TRACE_POINTER=<файл>` — записать туда путь следа
 * (задачи jobs узнают так `JobInfo.trace`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const TRACE_FILE = 'run.trace.jsonl'

export type TraceEventName = 'run.start' | 'step.start' | 'step.end' | 'llm' | 'run.end'

export interface TraceEvent {
  t: string
  ev: TraceEventName
  step?: string
  part?: string
  ms?: number
  model?: string
  tokens_in?: number
  tokens_out?: number
  cost?: number
  out?: string
  ok?: boolean
  error?: string
  /** `run.start`: документ и id прогона. */
  doc?: string
  run?: string
  /** `step.start` из `helpers.step`: картинка и подпись шага (pipeline-run-spec §3.4). */
  icon?: string
  title?: string
}

export interface StepOptions {
  part?: string
  out?: string
  icon?: string
  title?: string
}

/** Конец шага `helpers.step`: можно дописать `out` / ошибку. Повторный вызов — без эффекта. */
export type StepEnd = (opts?: { out?: string; error?: unknown }) => void

/** Где мы: шаг и часть — для событий `llm` и вложенных шагов. */
interface Scope {
  step?: string
  part?: string
}

const scope = new AsyncLocalStorage<Scope>()
/** Сборщик usage одного вызова модели: обёртка провайдера кладёт сюда кадр `done`. */
const usageSlot = new AsyncLocalStorage<{ input?: number; output?: number; cost?: number }>()

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Время в имени файла: `2026-11-10T12-58-03`. */
const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace(/:/g, '-')

export interface TraceOptions {
  /** Документ прогона (путь). */
  doc: string | null
  /** Папка документа — `.runz/runs/<id>/`, если нет `out`. */
  baseDir: string
  /** `$out` цепочки (как задал рецепт). */
  out?: string
  /** cwd запуска — от него `out` (как у рецептов bot-fix). */
  cwd?: string
  env?: Record<string, string | undefined>
  now?: () => Date
}

export class RunTrace {
  readonly file: string | null
  readonly id: string
  private started = false
  private readonly t0: number
  private readonly now: () => Date
  private readonly pointer?: string
  private readonly doc: string | null
  /** Ручные шаги `helpers.step` без функции: событие `llm` приписывается последнему открытому. */
  private readonly open: Scope[] = []

  constructor(o: TraceOptions) {
    const env = o.env ?? process.env
    this.now = o.now ?? (() => new Date())
    const d = this.now()
    this.t0 = d.getTime()
    this.id = stamp(d)
    this.doc = o.doc
    this.pointer = env.RUNZ_TRACE_POINTER || undefined
    if (env.RUNZ_TRACE === 'off' || env.RUNZ_TRACE === '0') {
      this.file = null
      return
    }
    const dir = o.out ? resolve(o.cwd ?? process.cwd(), o.out) : join(o.baseDir, '.runz', 'runs', this.id)
    this.file = join(dir, TRACE_FILE)
  }

  /** Пишется ли след (файл создан). */
  get active(): boolean {
    return this.started
  }

  private write(ev: TraceEvent): void {
    if (!this.file) return
    try {
      if (!this.started) {
        this.started = true
        mkdirSync(dirname(this.file), { recursive: true })
        if (existsSync(this.file)) renameSync(this.file, this.file.replace(/\.jsonl$/, `.${this.id}.jsonl`))
        const start: TraceEvent = { t: new Date(this.t0).toISOString(), ev: 'run.start', run: this.id }
        if (this.doc) start.doc = this.doc
        writeFileSync(this.file, JSON.stringify(start) + '\n')
        if (this.pointer) {
          try {
            mkdirSync(dirname(this.pointer), { recursive: true })
            writeFileSync(this.pointer, this.file + '\n')
          } catch {
            // указатель — подсказка задаче, не причина ронять прогон
          }
        }
      }
      if (ev.ev !== 'run.start') appendFileSync(this.file, JSON.stringify(ev) + '\n')
    } catch {
      // след — наблюдение: сбой записи не роняет прогон
    }
  }

  private emit(ev: Omit<TraceEvent, 't'>): void {
    const out: TraceEvent = { t: this.now().toISOString(), ...ev }
    for (const k of Object.keys(out) as (keyof TraceEvent)[]) if (out[k] === undefined) delete out[k]
    this.write(out)
  }

  /** Текущий шаг и часть (ALS → последний открытый ручной шаг). */
  current(): Scope {
    const s = scope.getStore()
    const manual = this.open[this.open.length - 1]
    if (manual && (!s || s.step === undefined || s.step === manual.step)) return { ...s, ...manual }
    return s ?? {}
  }

  /** Шаг вокруг функции: `step.start` → fn → `step.end` (ok / error). */
  async step<T>(id: string, fn: () => Promise<T>, opts: StepOptions = {}): Promise<T> {
    const parent = this.current()
    const part = opts.part ?? (parent.step === id ? parent.part : undefined)
    const t0 = Date.now()
    this.emit({ ev: 'step.start', step: id, part, icon: opts.icon, title: opts.title })
    try {
      const r = await scope.run({ step: id, part }, fn)
      this.emit({ ev: 'step.end', step: id, part, ms: Date.now() - t0, ok: true, out: opts.out ?? outOf(r) })
      return r
    } catch (e) {
      this.emit({ ev: 'step.end', step: id, part, ms: Date.now() - t0, ok: false, error: errorText(e) })
      throw e
    }
  }

  /** `helpers.step(id, opts)` → `end()`; с функцией третьим аргументом — шаг вокруг неё. */
  manual(id: string, opts: StepOptions = {}): StepEnd {
    const t0 = Date.now()
    const entry: Scope = { step: id, part: opts.part }
    this.open.push(entry)
    this.emit({ ev: 'step.start', step: id, part: opts.part, icon: opts.icon, title: opts.title })
    let done = false
    return (end = {}) => {
      if (done) return
      done = true
      const i = this.open.lastIndexOf(entry)
      if (i >= 0) this.open.splice(i, 1)
      const error = end.error === undefined ? undefined : errorText(end.error)
      this.emit({ ev: 'step.end', step: id, part: opts.part, ms: Date.now() - t0, ok: error === undefined, error, out: end.out ?? opts.out })
    }
  }

  /** Вызов модели: `llm` с шагом и частью, usage — из кадра провайдера, если пришёл. */
  async llm<T>(model: string | undefined, fn: () => Promise<T>, usageOf?: (r: T) => { input?: number; output?: number; cost?: number } | undefined): Promise<T> {
    const where = this.current()
    const t0 = Date.now()
    const slot: { input?: number; output?: number; cost?: number } = {}
    let error: string | undefined
    let r: T | undefined
    try {
      r = await usageSlot.run(slot, fn)
      return r
    } catch (e) {
      error = errorText(e)
      throw e
    } finally {
      const u = { ...slot, ...(r !== undefined && usageOf ? usageOf(r) : undefined) }
      this.emit({
        ev: 'llm',
        step: where.step,
        part: where.part,
        ms: Date.now() - t0,
        model: model || undefined,
        tokens_in: u.input || undefined,
        tokens_out: u.output || undefined,
        cost: u.cost || undefined,
        ...(error ? { ok: false, error } : {}),
      })
    }
  }

  /** Конец прогона — только если след начат (были шаги или модель). */
  end(ok: boolean, error?: unknown): void {
    if (!this.started) return
    this.emit({ ev: 'run.end', ms: this.now().getTime() - this.t0, ok, error: error === undefined ? undefined : errorText(error) })
  }
}

/** `out` из результата шага: первый файл `outputs`, если есть. */
function outOf(r: unknown): string | undefined {
  const outputs = (r as { outputs?: { path?: unknown }[] } | null)?.outputs
  if (!Array.isArray(outputs)) return undefined
  const p = outputs.find((o) => typeof o?.path === 'string')?.path
  return typeof p === 'string' ? p : undefined
}

/**
 * Обёртка стрима провайдера: кадры `done` с `usage` (OpenAI-гейт отдаёт по `include_usage`)
 * — в сборщик текущего вызова `RunTrace.llm`. Чанки не меняются.
 */
export function traceStream<C extends { type: string }>(stream: (req: never) => AsyncIterable<C>): (req: never) => AsyncIterable<C> {
  return async function* (req: never) {
    for await (const chunk of stream(req)) {
      if (chunk.type === 'done') {
        const slot = usageSlot.getStore()
        const u = (chunk as { usage?: { input_tokens?: number; output_tokens?: number; cost?: number } }).usage
        if (slot && u) {
          if (u.input_tokens) slot.input = u.input_tokens
          if (u.output_tokens) slot.output = u.output_tokens
          if (u.cost) slot.cost = u.cost
        }
      }
      yield chunk
    }
  }
}
