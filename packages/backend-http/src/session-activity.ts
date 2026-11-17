/**
 * Активность сессий (v1.69, nr-ui-protocol `activity.ts`): поток встроенного сервиса
 * `nr.sessions`/`activity` — «в сессии начался / кончился ран», «лента изменилась без рана».
 * Открытая вкладка подцепляется к рану, которого не начинала (будильник, хост задач, другое
 * устройство), и дочитывает ленту — без перезагрузки.
 *
 * `withSessionActivity(backend)` смотрит раны, что идут через `backend.run` (их события
 * проходят мимо — ничего не копит), и правки ленты `messages.*`; поток отдаёт сервисом
 * (`services.stream/subscribe`), заявляет его в `capabilities().services`. Внешний слой
 * перекрывает внутренний: хаб отдаёт ленту всех движков, а не встроенного.
 */

import {
  SESSION_ACTIVITY_EVENT,
  SESSION_ACTIVITY_SERVICE,
  SESSION_ACTIVITY_STREAM,
  isParallelRun,
} from '@kerneldreams/ui-protocol'
import { isImpersonateRun } from './impersonate-run.js'
import type {
  AnyRunEvent,
  Capabilities,
  ProtocolBackend,
  RunStartInput,
  ServiceEvent,
  SessionActivity,
} from '@kerneldreams/ui-protocol'

const ACTIVITY = Symbol.for('nr.sessionActivity')

export interface ActivityFeed {
  emit(a: Omit<SessionActivity, 'at'> & { at?: string }): void
  /** Вечная подписка: кадры до `return()` потребителя. */
  stream(filter?: (a: SessionActivity) => boolean | Promise<boolean>): AsyncIterable<ServiceEvent>
  /** Подписчиков сейчас (тесты, диагностика). */
  size(): number
}

export function createActivityFeed(now: () => number = Date.now): ActivityFeed {
  const subs = new Set<(a: SessionActivity) => void>()
  return {
    emit(a) {
      const full: SessionActivity = { ...a, at: a.at ?? new Date(now()).toISOString() }
      for (const s of subs) s(full)
    },
    size: () => subs.size,
    stream(filter) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ServiceEvent> {
          const queue: ServiceEvent[] = []
          let wake: (() => void) | null = null
          let closed = false
          const sub = (a: SessionActivity): void => {
            void (async () => {
              if (filter && !(await Promise.resolve(filter(a)).catch(() => false))) return
              if (closed) return
              // Сигнал, не журнал: отставший подписчик держит не больше 500 кадров.
              if (queue.length >= 500) queue.shift()
              queue.push({ name: SESSION_ACTIVITY_EVENT, payload: a })
              wake?.()
            })()
          }
          subs.add(sub)
          const close = (): void => {
            closed = true
            subs.delete(sub)
            wake?.()
          }
          return {
            async next() {
              for (;;) {
                if (queue.length) return { done: false, value: queue.shift()! }
                if (closed) return { done: true, value: undefined }
                await new Promise<void>((r) => (wake = r))
                wake = null
              }
            },
            async return() {
              close()
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
  }
}

/** Слой уже отдаёт поток активности — второй раз не вешаем (внешний перекрывает внутренний). */
export function activityFeedOf(backend: ProtocolBackend): ActivityFeed | undefined {
  return (backend as unknown as Record<symbol, ActivityFeed | undefined>)[ACTIVITY]
}

const MESSAGE_OPS = ['append', 'edit', 'delete', 'hide', 'swipe'] as const

export interface SessionActivityOpts {
  feed?: ActivityFeed
  now?: () => number
  /** Кто видит событие (гейт пользователей): нет — все подписчики. */
  visible?: (sessionId: string) => boolean | Promise<boolean>
}

/**
 * Обёртка: раны и правки ленты, идущие через `backend`, → поток активности. Живая (Proxy):
 * группы бэкенда читаются на каждом обращении, как у `withRunAttach`.
 */
export function withSessionActivity(backend: ProtocolBackend, opts: SessionActivityOpts = {}): ProtocolBackend {
  // Слой под нами уже смотрит раны (хаб под гейтом, стенд под обёрткой) — его лента общая,
  // второй раз раны не смотрим: иначе подписчик получит каждый сигнал дважды.
  const inherited = activityFeedOf(backend)
  const feed = opts.feed ?? inherited ?? createActivityFeed(opts.now)
  const observe = inherited === undefined

  function run(sid: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
    const inner = backend.run(sid, input)
    // Служебная команда (v1.47) — не ход сессии: ленту не трогает.
    if (isParallelRun(input) || isImpersonateRun(input)) return inner
    const headless = input.headless === true ? { headless: true } : {}
    return {
      [Symbol.asyncIterator]() {
        const it = inner[Symbol.asyncIterator]()
        let runId: string | undefined
        let ended = false
        const end = (): void => {
          if (ended || runId === undefined) return
          ended = true
          feed.emit({ id: sid, kind: 'run_end', runId, ...headless })
        }
        return {
          async next() {
            try {
              const r = await it.next()
              if (r.done) end()
              else if (r.value.type === 'run_start' && runId === undefined && typeof r.value.runId === 'string') {
                runId = r.value.runId
                feed.emit({ id: sid, kind: 'run_start', runId, ...headless })
              } else if (r.value.type === 'run_end') end()
              return r
            } catch (err) {
              end()
              throw err
            }
          },
          async return(v?: unknown) {
            // Потребитель ушёл — ран (у `withRunAttach`) идёт дальше; конец увидит подписка.
            return it.return ? it.return(v as never) : { done: true as const, value: undefined as never }
          },
        }
      },
    }
  }

  const messagesOver = (): ProtocolBackend['messages'] | undefined => {
    const group = backend.messages
    if (!group) return undefined
    return new Proxy(group, {
      get(t, prop) {
        const v = Reflect.get(t, prop)
        if (typeof v !== 'function') return v
        if (!(MESSAGE_OPS as readonly PropertyKey[]).includes(prop)) return v.bind(t)
        return async (sid: string, ...rest: unknown[]) => {
          const out = await (v as (...a: unknown[]) => Promise<unknown>).call(t, sid, ...rest)
          feed.emit({ id: sid, kind: 'messages' })
          return out
        }
      },
    })
  }

  const ownStream = (plugin: string, method: string): boolean => plugin === SESSION_ACTIVITY_SERVICE && method === SESSION_ACTIVITY_STREAM
  const servicesOver = (): NonNullable<ProtocolBackend['services']> => {
    const group = backend.services
    const filter = opts.visible ? (a: SessionActivity) => opts.visible!(a.id) : undefined
    const call = (plugin: string, method: string, args?: unknown): Promise<unknown> => {
      if (plugin === SESSION_ACTIVITY_SERVICE) return Promise.reject(Object.assign(new Error(`${plugin}: метода ${method} нет`), { code: 'not_supported', name: 'NotSupportedError' }))
      if (!group) return Promise.reject(Object.assign(new Error(`services.call: сервиса ${plugin} нет`), { code: 'not_supported', name: 'NotSupportedError' }))
      return group.call(plugin, method, args)
    }
    const stream = (plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> => {
      if (ownStream(plugin, method)) return feed.stream(filter)
      if (!group) throw Object.assign(new Error(`services.stream: сервиса ${plugin} нет`), { code: 'not_supported', name: 'NotSupportedError' })
      return group.stream(plugin, method, args)
    }
    const out: NonNullable<ProtocolBackend['services']> = { call, stream }
    if (group?.url) out.url = group.url.bind(group)
    if (group?.subscribe) {
      const sub = group.subscribe.bind(group)
      out.subscribe = (plugin, method, args) => (ownStream(plugin, method) ? feed.stream(filter) : sub(plugin, method, args))
    }
    return out
  }

  const over: Record<PropertyKey, unknown> = {
    [ACTIVITY]: feed,
    ...(observe ? { run } : {}),
    async capabilities(): Promise<Capabilities> {
      const caps = await backend.capabilities()
      return { ...caps, services: { ...caps.services, [SESSION_ACTIVITY_SERVICE]: { methods: [], streams: [SESSION_ACTIVITY_STREAM] } } }
    },
  }
  const wrapped: ProtocolBackend = new Proxy({} as ProtocolBackend, {
    get(_t, prop) {
      if (prop in over) return over[prop]
      if (prop === 'messages' && observe) return messagesOver()
      if (prop === 'services') return servicesOver()
      const v = Reflect.get(backend, prop)
      return typeof v === 'function' ? v.bind(backend) : v
    },
    has: (_t, prop) => prop in over || prop === 'services' || prop in backend,
    ownKeys: () => [...new Set([...Reflect.ownKeys(backend), 'run', 'capabilities', 'services'])],
    getOwnPropertyDescriptor: (_t, prop): PropertyDescriptor => ({ configurable: true, enumerable: prop !== ACTIVITY, writable: false, value: (wrapped as unknown as Record<PropertyKey, unknown>)[prop] }),
  })
  return wrapped
}
