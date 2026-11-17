/**
 * createMemoryBridge — Tauri без Tauri: `invoke`/`listen` поверх
 * createProtocolHost в том же процессе.
 *
 * Для loopback-тестов и dev-сборок фронта: всё, что едет через мост, проходит
 * JSON (как IPC Tauri — `undefined` в позиционных аргументах становится `null`,
 * Uint8Array не пролезет) и доставляется асинхронно, ответ вызова — позже
 * кадров того же тика: клиент обязан это переживать.
 */

import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import type { InvokeFn, ListenFn } from './client.js'
import { createProtocolHost, type ProtocolHost } from './host.js'
import { PROTOCOL_CALL_COMMAND, PROTOCOL_EVENT, type ProtocolCall, type ProtocolEventPayload } from './wire.js'

export interface MemoryBridgeOpts {
  /** Задержка ответа `invoke`, мс. Default 1 — кадры стрима успевают раньше ответа. */
  replyDelayMs?: number
}

export interface MemoryBridge {
  invoke: InvokeFn
  listen: ListenFn
  /** Хост, в который смотрит мост. */
  host: ProtocolHost
  /** Все кадры, ушедшие в окно (копии после JSON). */
  frames: ProtocolEventPayload[]
  /** Имитация смерти sidecar: хост закрыт, окну — `reset`, invoke дальше отказывает. */
  kill(): void
}

export function createMemoryBridge(backend: ProtocolBackend, opts: MemoryBridgeOpts = {}): MemoryBridge {
  const replyDelayMs = opts.replyDelayMs ?? 1
  const listeners = new Map<number, { event: string; handler: (e: { payload: unknown }) => void }>()
  const frames: ProtocolEventPayload[] = []
  let listenerSeq = 0
  let dead = false

  function dispatch(event: string, payload: ProtocolEventPayload): void {
    const copy = json(payload)
    frames.push(copy)
    // Как IPC: доставка не в стеке emit.
    queueMicrotask(() => {
      for (const l of [...listeners.values()]) if (l.event === event) l.handler({ payload: json(copy) })
    })
  }

  const host = createProtocolHost(backend, {
    emit: (payload) => {
      if (dead) throw new Error('bridge is dead')
      dispatch(PROTOCOL_EVENT, payload)
    },
  })

  return {
    host,
    frames,

    async invoke(cmd, args) {
      if (dead) throw new Error('sidecar is gone')
      if (cmd !== PROTOCOL_CALL_COMMAND) throw new Error(`unknown command ${cmd}`)
      const reply = await host.call(json(args ?? {}) as unknown as ProtocolCall)
      await new Promise((r) => setTimeout(r, replyDelayMs))
      if (dead) throw new Error('sidecar is gone')
      return json(reply)
    },

    async listen(event, handler) {
      const id = ++listenerSeq
      listeners.set(id, { event, handler })
      return () => {
        listeners.delete(id)
      }
    },

    kill() {
      if (dead) return
      host.close()
      dead = true
      dispatch(PROTOCOL_EVENT, { type: 'reset' })
    },
  }
}

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}
