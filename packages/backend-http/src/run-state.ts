/**
 * Состояние ранов store-backend над `KvStore`: «сессия занята»
 * (busy) и ответы на `ask`, пришедшие раньше, чем ран стал их ждать. Ядро не
 * держит это в `Map` процесса: хост без общей памяти между запросами (Worker)
 * отдаёт свой kv, Node — kv в памяти через тот же интерфейс.
 *
 * Только в процессе, где ран исполняется (по природе, не кэш): его
 * `AbortController` (cancel) и ожидающие промисы `ask` — живые объекты рана.
 * Ответ, пришедший в другой процесс, ложится в kv; ран с внешним kv
 * подбирает его опросом (`pollMs`).
 */

import { err, ok, type KvStore } from '@kerneldreams/nrd/contracts'

/** busy-запись живёт столько без продления; ран продлевает её, пока идёт. */
export const RUN_TTL_MS = 120_000
const RUN_HEARTBEAT_MS = 30_000
/** Ответ на ask ждёт ран не дольше. */
const ANSWER_TTL_MS = 3_600_000

/** `KvStore` в памяти процесса — дефолт Node и тестов (TTL по часам процесса). */
export function createMemoryKv(now: () => number = Date.now): KvStore {
  const data = new Map<string, { value: string; expires?: number }>()
  const alive = (key: string): { value: string; expires?: number } | undefined => {
    const e = data.get(key)
    if (e?.expires !== undefined && e.expires <= now()) {
      data.delete(key)
      return undefined
    }
    return e
  }
  return {
    async get<T>(key: string) {
      const e = alive(key)
      return ok(e ? (JSON.parse(e.value) as T) : undefined)
    },
    async set(key, value, opts) {
      if (value === undefined) return err(new Error(`kv: undefined под ключом ${key}`))
      data.set(key, { value: JSON.stringify(value), ...(opts?.ttlMs !== undefined ? { expires: now() + opts.ttlMs } : {}) })
      return ok(undefined)
    },
    async delete(key) {
      data.delete(key)
      return ok(undefined)
    },
    async list(prefix) {
      return ok([...data.keys()].filter((k) => k.startsWith(prefix) && alive(k)).sort())
    },
  }
}

async function kvGet<T>(kv: KvStore, key: string): Promise<T | undefined> {
  const r = await kv.get<T>(key)
  if (!r.ok) throw r.error
  return r.value
}

async function kvDo(p: Promise<{ ok: true; value: unknown } | { ok: false; error: Error }>): Promise<void> {
  const r = await p
  if (!r.ok) throw r.error
}

const runKey = (sid: string): string => `runs/${sid}`
const answerKey = (sid: string, askId: string): string => `asks/${sid}/${askId}`

export interface RunRecord {
  runId: string
  startedAt: number
}

/** Реестр ранов: один живой ран на сессию (§3). */
export interface RunRegistry {
  busy(sid: string): Promise<boolean>
  /** Занять сессию; уже занята — `false`. Возвращённый `end` — освободить. */
  begin(sid: string, runId: string): Promise<{ end(): Promise<void> } | undefined>
}

export function createRunRegistry(kv: KvStore): RunRegistry {
  // Захват — по очереди внутри процесса: между get и set kv нет атомарности.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  return {
    busy: async (sid) => (await kvGet<RunRecord>(kv, runKey(sid))) !== undefined,
    begin: (sid, runId) =>
      serial(async () => {
        if ((await kvGet<RunRecord>(kv, runKey(sid))) !== undefined) return undefined
        const rec: RunRecord = { runId, startedAt: Date.now() }
        await kvDo(kv.set(runKey(sid), rec, { ttlMs: RUN_TTL_MS }))
        const beat = setInterval(() => void kv.set(runKey(sid), rec, { ttlMs: RUN_TTL_MS }), RUN_HEARTBEAT_MS)
        ;(beat as { unref?: () => void }).unref?.()
        return {
          async end() {
            clearInterval(beat)
            const cur = await kvGet<RunRecord>(kv, runKey(sid)).catch(() => undefined)
            if (cur?.runId === runId) await kvDo(kv.delete(runKey(sid)))
          },
        }
      }),
  }
}

/** Ожидания ответов на ask одного рана: ответ мог прийти раньше, чем его стали ждать. */
export interface AskState {
  wait(askId: string): Promise<unknown>
  answer(askId: string, answer: unknown): Promise<void>
  close(): void
}

export interface AskStateOptions {
  sid: string
  kv: KvStore
  signal: AbortSignal
  /** Опрос kv за ответом из другого процесса, мс; нет — только локальные ответы и ранние из kv. */
  pollMs?: number
}

export function createAskState(opts: AskStateOptions): AskState {
  const { sid, kv, signal } = opts
  const waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setInterval> }>()
  const abortError = (): Error => Object.assign(new Error('backend-store: ран отменён'), { name: 'AbortError' })
  const settle = (askId: string): { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined => {
    const w = waiters.get(askId)
    if (!w) return undefined
    waiters.delete(askId)
    if (w.timer) clearInterval(w.timer)
    return w
  }
  const rejectAll = (): void => {
    for (const id of [...waiters.keys()]) settle(id)?.reject(abortError())
  }
  signal.addEventListener('abort', rejectAll, { once: true })
  /** Ранний ответ из kv: забрать и удалить. */
  const takeEarly = async (askId: string): Promise<{ answer: unknown } | undefined> => {
    const box = await kvGet<{ answer: unknown }>(kv, answerKey(sid, askId)).catch(() => undefined)
    if (box) await kv.delete(answerKey(sid, askId))
    return box
  }
  return {
    async wait(askId) {
      const early = await takeEarly(askId)
      if (early) return early.answer
      if (signal.aborted) throw abortError()
      return new Promise((resolve, reject) => {
        const w: { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setInterval> } = { resolve, reject }
        if (opts.pollMs) {
          w.timer = setInterval(() => {
            void takeEarly(askId).then((box) => {
              if (box) settle(askId)?.resolve(box.answer)
            })
          }, opts.pollMs)
          ;(w.timer as { unref?: () => void }).unref?.()
        }
        waiters.set(askId, w)
      })
    },
    async answer(askId, answer) {
      const w = settle(askId)
      if (w) w.resolve(answer)
      else await kvDo(kv.set(answerKey(sid, askId), { answer: answer ?? null }, { ttlMs: ANSWER_TTL_MS }))
    },
    close() {
      signal.removeEventListener('abort', rejectAll)
      rejectAll()
    },
  }
}

/** Ответ на ask рана, который идёт в другом процессе: в kv, ран заберёт опросом. */
export async function answerRemote(kv: KvStore, sid: string, askId: string, answer: unknown): Promise<boolean> {
  if ((await kvGet<RunRecord>(kv, runKey(sid))) === undefined) return false
  await kvDo(kv.set(answerKey(sid, askId), { answer: answer ?? null }, { ttlMs: ANSWER_TTL_MS }))
  return true
}

// ────────────────────────────────────────────────────────────────────────────
// Живость исполнителей тулов сессии
// ────────────────────────────────────────────────────────────────────────────

/** Как часто исполнитель (фронт, виджет) отмечается живым. */
export const SESSION_TOOLS_HEARTBEAT_MS = 10_000
/** Отметка старше — исполнитель мёртв, его тулы в ран не идут (3 пропущенных удара). */
export const SESSION_TOOLS_TTL_MS = 3 * SESSION_TOOLS_HEARTBEAT_MS

/** Ключ исполнителя декларации: артефакт-владелец, иначе имя тула. */
export const aliveKeyOf = (decl: { name: string; artifactId?: string }): string => decl.artifactId ?? decl.name

const aliveKvKey = (sid: string): string => `alive/${sid}`

/**
 * Отметки `sessionMeta.toolsAlive` (патч меты `{toolsAlive: {ключ: ts}}`) —
 * в kv, не в документ сессии: удар раз в 10 с не пишет файл и не упирается в
 * `busy` рана. Время — сервера (часы клиента не сверяются); `null` — снять ключ.
 */
export interface AliveRegistry {
  mark(sid: string, marks: Record<string, unknown>): Promise<void>
  /** Декларация жива: отметки не было никогда (старый клиент) или она свежее TTL. */
  live(sid: string): Promise<(decl: { name: string; artifactId?: string }) => boolean>
}

export function createAliveRegistry(kv: KvStore, now: () => number = Date.now, ttlMs = SESSION_TOOLS_TTL_MS): AliveRegistry {
  return {
    async mark(sid, marks) {
      const cur = (await kvGet<Record<string, number>>(kv, aliveKvKey(sid))) ?? {}
      const t = now()
      for (const [key, v] of Object.entries(marks)) {
        if (v === null) delete cur[key]
        else cur[key] = t
      }
      // Запись живёт дольше TTL: протухшая отметка отличается от «не было никогда».
      await kvDo(kv.set(aliveKvKey(sid), cur, { ttlMs: 7 * 24 * 3600_000 }))
    },
    async live(sid) {
      const marks = (await kvGet<Record<string, number>>(kv, aliveKvKey(sid))) ?? {}
      const t = now()
      return (decl) => {
        const at = marks[aliveKeyOf(decl)]
        return at === undefined || t - at <= ttlMs
      }
    },
  }
}
