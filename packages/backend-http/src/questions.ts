/**
 * Вопросы прогонов через хаб (kd-cli-spec §9): прогон, у которого есть человек (терминал или окно),
 * дублирует вопрос сюда — и человек видит его там, где он сейчас (nrchat «Ждёт тебя», телефон через
 * уведомление). Кто ответил первым — тот и ответил: ответ хаба спрашивающий забирает опросом и кладёт
 * в свой ящик. Ядро не знает, кто спрашивает (kd, агент, скрипт) — только запись и её ответ.
 *
 * Запись `{id, question, options, default, deadline, from, host, created, answer?, by?, answeredAt?}` —
 * файлом `<dir>/<id>.json` (переживает рестарт; стенды контура видят одни записи). Срок вышел —
 * вопрос из списка уходит (спрашивающий уже взял умолчание), файл чистится следующим проходом.
 *
 * Сервис `questions` (`withQuestionsService`): `ask` / `list` / `get` / `answer` / `cancel`.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceEvent, ServicesCapability, ServicesHost } from '@kerneldreams/ui-protocol'

export const QUESTIONS_SERVICE_ID = 'questions'
/** Отвеченное и просроченное лежит ещё столько — спрашивающий успевает забрать ответ. */
const KEEP_MS = 10 * 60_000
/** Срок вопроса без своего — 10 мин (как у ящика kd). */
const DEFAULT_TTL_MS = 10 * 60_000
/** Потолок срока: вопрос прогона не висит сутками. */
const MAX_TTL_MS = 24 * 3600_000

export interface HubQuestion {
  id: string
  question: string
  options: string[]
  default: string
  /** ISO: после — спрашивающий берёт умолчание, вопрос из списка уходит. */
  deadline: string
  /** Кто спрашивает: `kd agent`, имя тула, рецепт. */
  from: string
  /** Машина спрашивающего. */
  host?: string
  created: string
  answer?: string
  by?: 'human'
  answeredAt?: string
}

export interface QuestionsOptions {
  dir: string
  /** Уведомление о новом вопросе (расширение хоста: Telegram и т.п.); нет — только список. */
  notify?: (text: string) => void | Promise<void>
  now?: () => number
}

export interface Questions {
  readonly methods: readonly string[]
  call(method: string, args: unknown): Promise<unknown>
  ask(q: { id?: string; question: string; options?: string[]; default: string; deadline?: string; from?: string; host?: string }): HubQuestion
  list(): HubQuestion[]
  get(id: string): HubQuestion | null
  answer(id: string, answer: string): HubQuestion
  cancel(id: string): boolean
}

const bad = (m: string): Error => Object.assign(new Error(`questions: ${m}`), { code: 'bad_request' })
const ID = /^[\w.-]{1,80}$/

export function createQuestions(o: QuestionsOptions): Questions {
  const now = o.now ?? Date.now
  const file = (id: string): string => join(o.dir, `${id}.json`)
  const read = (id: string): HubQuestion | null => {
    try {
      return JSON.parse(readFileSync(file(id), 'utf8')) as HubQuestion
    } catch {
      return null
    }
  }
  const write = (q: HubQuestion): void => {
    mkdirSync(o.dir, { recursive: true })
    const tmp = `${file(q.id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(q, null, 2))
    renameSync(tmp, file(q.id))
  }
  const all = (): HubQuestion[] => {
    if (!existsSync(o.dir)) return []
    const out: HubQuestion[] = []
    for (const f of readdirSync(o.dir)) {
      if (!f.endsWith('.json')) continue
      const q = read(f.slice(0, -5))
      if (!q) continue
      // Старое (отвечено или просрочено давно) — чистится тут же.
      const end = Math.max(Date.parse(q.answeredAt ?? '') || 0, Date.parse(q.deadline) || 0)
      if (now() - end > KEEP_MS) {
        rmSync(file(q.id), { force: true })
        continue
      }
      out.push(q)
    }
    return out
  }
  const api: Questions = {
    methods: ['ask', 'list', 'get', 'answer', 'cancel'],
    ask(input) {
      const question = String(input.question ?? '').trim()
      if (!question) throw bad('нет текста вопроса')
      if (typeof input.default !== 'string') throw bad('нужно умолчание (default): прогон не ждёт без него')
      const id = input.id ?? `${now().toString(36)}-${randomBytes(3).toString('hex')}`
      if (!ID.test(id)) throw bad(`id «${id}» — только буквы, цифры, «.-_»`)
      const d = input.deadline ? Date.parse(input.deadline) : now() + DEFAULT_TTL_MS
      if (!Number.isFinite(d)) throw bad(`срок «${input.deadline}» — не дата ISO`)
      const q: HubQuestion = {
        id,
        question,
        options: (input.options ?? []).map(String),
        default: input.default,
        deadline: new Date(Math.min(d, now() + MAX_TTL_MS)).toISOString(),
        from: input.from?.trim() || 'kd',
        ...(input.host ? { host: input.host } : {}),
        created: new Date(now()).toISOString(),
      }
      write(q)
      if (o.notify) {
        const opts = q.options.length ? ` [${q.options.join(' / ')}]` : ''
        void Promise.resolve(o.notify(`❓ ${q.from}${q.host ? ` (${q.host})` : ''}: ${q.question}${opts} — по умолчанию «${q.default}», ответ в nrchat «Ждёт тебя»`)).catch(() => undefined)
      }
      return q
    },
    list() {
      const t = now()
      return all()
        .filter((q) => q.answer === undefined && Date.parse(q.deadline) > t)
        .sort((a, b) => a.deadline.localeCompare(b.deadline))
    },
    get(id) {
      if (!ID.test(id)) throw bad(`id «${id}»`)
      return read(id)
    },
    answer(id, answer) {
      const q = api.get(id)
      if (!q) throw Object.assign(new Error(`questions: вопроса ${id} нет — уже снят или срок вышел`), { code: 'not_found' })
      if (q.answer !== undefined) return q
      if (Date.parse(q.deadline) <= now()) throw Object.assign(new Error(`questions: срок вопроса ${id} вышел — прогон взял умолчание «${q.default}»`), { code: 'conflict' })
      const done: HubQuestion = { ...q, answer: String(answer), by: 'human', answeredAt: new Date(now()).toISOString() }
      write(done)
      return done
    },
    cancel(id) {
      if (!ID.test(id)) throw bad(`id «${id}»`)
      if (!existsSync(file(id))) return false
      rmSync(file(id), { force: true })
      return true
    },
    async call(method, args) {
      const a = (args ?? {}) as Record<string, unknown>
      const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
      switch (method) {
        case 'ask':
          return api.ask({
            ...(str('id') ? { id: str('id') } : {}),
            question: str('question'),
            ...(Array.isArray(a.options) ? { options: a.options.map(String) } : {}),
            default: typeof a.default === 'string' ? a.default : (undefined as unknown as string),
            ...(str('deadline') ? { deadline: str('deadline') } : {}),
            ...(str('from') ? { from: str('from') } : {}),
            ...(str('host') ? { host: str('host') } : {}),
          })
        case 'list':
          return api.list()
        case 'get':
          return api.get(str('id'))
        case 'answer':
          return api.answer(str('id'), str('answer'))
        case 'cancel':
          return { ok: api.cancel(str('id')) }
        default:
          throw Object.assign(new Error(`questions: нет метода ${method}`), { code: 'not_supported' })
      }
    },
  }
  return api
}

/** Хост сервисов стенда + встроенный сервис `questions` (как `wake`). */
export function withQuestionsService(host: ServicesHost | undefined, q: Questions): ServicesHost {
  const none = (plugin: string, method: string): AsyncIterable<ServiceEvent> => ({
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(Object.assign(new Error(`services.${plugin}.${method}: нет стрима`), { code: 'not_supported' })) }
    },
  })
  return {
    async call(plugin, method, args) {
      if (plugin === QUESTIONS_SERVICE_ID) return q.call(method, args)
      if (!host) throw Object.assign(new Error(`services.${plugin}: нет сервиса`), { code: 'not_supported' })
      return host.call(plugin, method, args)
    },
    stream(plugin, method, args) {
      if (plugin === QUESTIONS_SERVICE_ID || !host) return none(plugin, method)
      return host.stream(plugin, method, args)
    },
    async capability(): Promise<ServicesCapability> {
      const ext = host ? await host.capability().catch(() => ({})) : {}
      return { ...ext, [QUESTIONS_SERVICE_ID]: { methods: [...q.methods], streams: [] } }
    },
    async close() {
      await host?.close()
    },
  }
}
