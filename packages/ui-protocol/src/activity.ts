/**
 * Активность сессий (v1.69): открытая вкладка узнаёт, что в сессии начался ран,
 * которого она не начинала (будильник хаба, хост задач, другое устройство), или что в ленту
 * дописали без рана (`messages.append`), — и сама подцепляется к рану (`sessions.attach`) или
 * дочитывает ленту. Без перезагрузки страницы.
 *
 * Провод — поток встроенного сервиса хаба: `services.subscribe ?? services.stream`
 * (`SESSION_ACTIVITY_SERVICE`, `SESSION_ACTIVITY_STREAM`), кадр `ServiceEvent{name: 'activity',
 * payload: SessionActivity}`. Так сигнал едет любым транспортом и мультиплексом подписок
 * (v1.68) одним соединением на вкладку, без новой операции `ProtocolBackend`.
 * Capability — дескриптор сервиса в `capabilities.services[SESSION_ACTIVITY_SERVICE]`
 * со стримом `SESSION_ACTIVITY_STREAM`; нет — фронт живёт как раньше (опрос списка).
 *
 * Заявляет его тот слой, через который идут раны процесса: `withRunAttach` (стенд) и хаб
 * (`createHub` — раны всех движков). Внешний слой перекрывает внутренний: хаб отдаёт свою
 * ленту, а не ленту встроенного движка.
 */

import type { Capabilities } from './types.js'

/** id встроенного сервиса активности (не плагин: имя с точкой плагину не дать). */
export const SESSION_ACTIVITY_SERVICE = 'nr.sessions'
/** Стрим сервиса: вечная подписка, кадры {@link SESSION_ACTIVITY_EVENT}. */
export const SESSION_ACTIVITY_STREAM = 'activity'
/** Имя кадра стрима. */
export const SESSION_ACTIVITY_EVENT = 'activity'

/**
 * Что случилось в сессии:
 * - `run_start` — начался ран (любой: свой, чужой, безголовый); подписчик без своего рана
 *   зовёт `sessions.attach`;
 * - `run_end` — ран кончился; подписчик, не подключённый к нему, дочитывает ленту;
 * - `messages` — лента изменилась без рана (`messages.append/edit/delete/hide/swipe`).
 */
export type SessionActivityKind = 'run_start' | 'run_end' | 'messages'

export interface SessionActivity {
  id: string
  kind: SessionActivityKind
  runId?: string
  /** ISO-время события на сервере. */
  at: string
  /** Ран безголовый (будильник, хост задач) — человека у сессии не было. */
  headless?: boolean
}

export function isSessionActivity(v: unknown): v is SessionActivity {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return typeof a.id === 'string' && (a.kind === 'run_start' || a.kind === 'run_end' || a.kind === 'messages') && typeof a.at === 'string'
}

/** Бэкенд отдаёт поток активности сессий. */
export function canSessionActivity(caps: Capabilities | null | undefined): boolean {
  return caps?.services?.[SESSION_ACTIVITY_SERVICE]?.streams?.includes(SESSION_ACTIVITY_STREAM) === true
}
