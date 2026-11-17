/**
 * Контракт провода Tauri: имена команды и события, форма вызова, ответа и
 * кадра стрима, коды ошибок, байты в base64.
 *
 * Делится между хостом (sidecar) и клиентом (webview) — стороны обязаны
 * эволюционировать синхронно (backends-spec §3), поэтому форма описана один раз.
 * Норматив — docs/TRANSPORT.md.
 */

import { NOT_SUPPORTED_CODE } from '@kerneldreams/ui-protocol'
import type { AnyRunEvent, Envelope, ServiceEvent, WorkspaceUpdateEvent } from '@kerneldreams/ui-protocol'

/** Tauri-команда: `invoke('protocol_call', {method, args})`. */
export const PROTOCOL_CALL_COMMAND = 'protocol_call'

/** Tauri-событие, которым едут кадры стримов (run, watch) и `reset`. */
export const PROTOCOL_EVENT = 'protocol_event'

/**
 * Вход команды: имя операции `ProtocolBackend` через точку (`sessions.fork`,
 * `workspace.files.read`) и позиционные аргументы метода. У стримящих операций
 * (`run`, `workspace.files.watch`, `services.stream`) последний аргумент — id
 * стрима от клиента.
 */
export interface ProtocolCall {
  method: string
  args?: unknown[]
}

/**
 * Ответ команды — Envelope §4 с кодом, как у backend-http. Ошибка операции —
 * `ok:false` в ответе, а не reject invoke: reject значит «провод сломан».
 */
export interface WireEnvelope<T = unknown> extends Envelope<T> {
  code?: string
}

/** Кадр события `protocol_event`. */
export type ProtocolEventPayload =
  /** Событие стрима: `AnyRunEvent` у `run`, `WorkspaceUpdateEvent` у watch, `ServiceEvent` у `services.stream`. */
  | { stream: string; type: 'event'; event: AnyRunEvent | WorkspaceUpdateEvent | ServiceEvent }
  /** Стрим кончился со стороны хоста. У `run` без `run_end` перед ним — обрыв. */
  | { stream: string; type: 'end' }
  /** Хост потерян целиком (sidecar перезапущен): все стримы оборваны. Шлёт оболочка. */
  | { type: 'reset' }

/** Операция не заявлена в capabilities (backends-spec §2). */
export const CODE_NOT_SUPPORTED = NOT_SUPPORTED_CODE
/** Операции с таким именем нет. */
export const CODE_NOT_FOUND = 'not_found'
/** Сессия занята живым раном (один активный run на сессию). */
export const CODE_BUSY = 'busy'
/** Аргументы не годятся. */
export const CODE_BAD_REQUEST = 'bad_request'
/** Провод порвался — синтетический код клиента (§3.2). */
export const CODE_CONNECTION_LOST = 'connection_lost'

/** Имя операции закрытия стрима: `stream.close(streamId)`. */
export const STREAM_CLOSE_METHOD = 'stream.close'

/** Байты → base64 (btoa есть и в webview, и в node). */
export function bytesToBase64(data: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 → байты; битый — `undefined`, решает вызывающий. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  let bin: string
  try {
    bin = atob(text)
  } catch {
    return undefined
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Текст ошибки: Error → message, прочее → String(). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
