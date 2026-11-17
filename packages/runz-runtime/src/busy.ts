/**
 * Ответ «занято» (429 / 503) от провайдера — ждать и повторять, а не падать (kd-cli-spec §7).
 * Лимит держит тот, кто стоит перед ресурсом (гейт, сервер модели); рантайм — клиент: пауза
 * нарастает (`Retry-After` сильнее), общий потолок ожидания — `$wait_max` (секунды или `15m`,
 * по умолчанию 15 мин; `RUNZ_WAIT_MAX` в окружении). Дальше — ошибка «прерван» (`exitCode: 4`):
 * прогон сохраняет состояние, продолжение — той же командой. Повтор — только до первого куска
 * ответа: начатый ответ не переигрывается.
 */

export const DEFAULT_WAIT_MAX_MS = 15 * 60_000

/** `90`, `90s`, `15m`, `1h` → мс; пусто или мусор — `undefined`. */
export function parseWait(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000
  if (typeof v !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(v)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
}

/** Ошибка — «занято»? */
export function isBusy(e: unknown): boolean {
  const x = e as { status?: number; code?: string; message?: string } | null
  if (!x) return false
  if (x.status === 429 || x.status === 503) return true
  if (x.code === 'rate_limit') return true
  return typeof x.message === 'string' && /\b(HTTP )?(429|503)\b|rate.?limit|too many requests|overloaded/i.test(x.message)
}

/** Ошибка «прерван с сохранённым состоянием» — код выхода 4. */
export class InterruptedError extends Error {
  readonly exitCode = 4
  readonly code = 'interrupted'
  constructor(message: string, readonly reason: unknown) {
    super(message)
    this.name = 'InterruptedError'
  }
}

export interface BusyOptions {
  waitMaxMs?: number
  /** Первая пауза; дальше ×2 до `maxPauseMs`. */
  firstPauseMs?: number
  maxPauseMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Сообщение о паузе (stderr прогона). */
  onWait?: (ms: number, attempt: number, err: unknown) => void
}

type Stream<Req, Chunk> = (req: Req) => AsyncIterable<Chunk>

/** Обёртка стрима: «занято» до первого куска — пауза и повтор, за потолком — {@link InterruptedError}. */
export function busyRetry<Req, Chunk>(stream: Stream<Req, Chunk>, o: BusyOptions = {}): Stream<Req, Chunk> {
  const waitMax = o.waitMaxMs ?? parseWait(process.env.RUNZ_WAIT_MAX) ?? DEFAULT_WAIT_MAX_MS
  const first = o.firstPauseMs ?? 2000
  const maxPause = o.maxPauseMs ?? 60_000
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  return async function* (req: Req): AsyncIterable<Chunk> {
    let waited = 0
    for (let attempt = 0; ; attempt++) {
      let started = false
      try {
        for await (const chunk of stream(req)) {
          const c = chunk as { type?: string; error?: unknown }
          if (!started && c?.type === 'error' && isBusy(c.error ?? c)) throw c.error ?? c
          started = true
          yield chunk
        }
        return
      } catch (err) {
        if (started || !isBusy(err)) throw err
        const hinted = (err as { retryAfter?: number }).retryAfter
        let pause = hinted && hinted > 0 ? hinted * 1000 : Math.min(first * 2 ** attempt, maxPause)
        if (waited + pause > waitMax) pause = waitMax - waited
        if (pause <= 0) throw new InterruptedError(`провайдер занят дольше потолка ожидания (${Math.round(waitMax / 1000)} с): ${(err as Error).message ?? String(err)}`, err)
        o.onWait?.(pause, attempt + 1, err)
        await sleep(pause)
        waited += pause
      }
    }
  }
}
