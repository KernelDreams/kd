/**
 * Автоархив служебных сессий задач (session-archive-spec §2): исполнитель и приёмщик
 * (`kind: run | review` с `task`) задачи со статусом `done` / `cancelled` уходят в архив сами —
 * `archived: <дата>`, `archivedBy: 'auto'`. Неважно, кто поставил статус: проход опрашивает
 * статусы задач, у которых есть неархивные служебные сессии. Вернули руками (`archived: false`) —
 * не трогает; разговоры, ствол, RP, пробы — не трогает. Пишется только мета.
 *
 * Работает поверх любого `ProtocolBackend` (хаб — все движки разом); статусы — снаружи
 * (`status`, у стенда — сервис `tasks` → Projektor).
 */

import type { ProtocolBackend, SessionInfo } from '@kerneldreams/ui-protocol'
import { archivePatch } from '@kerneldreams/ui-protocol'

/** Статусы задач, при которых служебные сессии уходят в архив. */
export const AUTOARCHIVE_STATUSES: readonly string[] = ['done', 'cancelled', 'canceled']

export interface AutoArchiveOptions {
  backend: ProtocolBackend
  /** Статусы задач пачкой: ref → `{status}`; нет ключа — задача неизвестна (сессию не трогать). */
  status(refs: string[]): Promise<Record<string, { status?: string } | undefined>>
  /** Период прохода, мс (по умолчанию 3 мин). */
  intervalMs?: number
  log?: (m: string) => void
}

export interface AutoArchive {
  /** Один проход: сколько сессий ушло в архив. */
  once(): Promise<{ archived: string[]; checked: number }>
  start(): void
  stop(): void
}

/** Кандидат автоархива: служебная сессия задачи, ни разу не архивная и не возвращённая руками. */
export function autoArchiveCandidate(s: SessionInfo): boolean {
  return (s.kind === 'run' || s.kind === 'review') && !!s.task?.issue && s.archived === undefined
}

export function createAutoArchive(opts: AutoArchiveOptions): AutoArchive {
  const log = opts.log ?? (() => {})
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<{ archived: string[]; checked: number }> | undefined

  async function pass(): Promise<{ archived: string[]; checked: number }> {
    const meta = opts.backend.meta
    if (!meta) return { archived: [], checked: 0 }
    const list = await opts.backend.sessions.list({ archived: true, all: true }).catch(() => opts.backend.sessions.list({ archived: true }))
    const todo = list.filter(autoArchiveCandidate)
    if (!todo.length) return { archived: [], checked: 0 }
    const ref = (s: SessionInfo): string => s.task!.issue.toUpperCase()
    const refs = [...new Set(todo.map(ref))]
    const statuses = await opts.status(refs)
    const closed = new Set(refs.filter((r) => AUTOARCHIVE_STATUSES.includes((statuses[r]?.status ?? '').toLowerCase())))
    const archived: string[] = []
    for (const s of todo) {
      if (!closed.has(ref(s))) continue
      // Идущий ход — мимо: следующий проход доберёт.
      if (s.run) continue
      try {
        await meta.patch(s.id, archivePatch(true, 'auto'))
        archived.push(s.id)
      } catch (err) {
        log(`автоархив: ${s.id} (${s.task!.issue}) — ${(err as Error)?.message ?? err}`)
      }
    }
    if (archived.length) log(`автоархив: в архив ${archived.length} служебных сессий (${[...closed].join(', ')})`)
    return { archived, checked: refs.length }
  }

  const auto: AutoArchive = {
    once() {
      running ??= pass().finally(() => {
        running = undefined
      })
      return running
    },
    start() {
      if (timer) return
      const tick = (): void => void auto.once().catch((err: unknown) => log(`автоархив: проход упал — ${(err as Error)?.message ?? err}`))
      setTimeout(tick, 5_000).unref?.()
      timer = setInterval(tick, opts.intervalMs ?? 180_000)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
  return auto
}
