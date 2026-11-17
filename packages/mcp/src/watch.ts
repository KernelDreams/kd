/**
 * Слежение агента вне главного потока — образец `backend-http/src/watch.ts`: `fs.watch` на macOS
 * может навсегда повиснуть в `uv_sem_wait` (FSEvents), и тогда встаёт весь цикл процесса. Здесь `fs.watch`
 * живёт в одном `worker_threads`-потоке: повис он — встаёт слежение, а HTTP и тулы отвечают.
 *
 * Открытие не ответило за `timeoutMs` — поток считается повисшим, его наблюдателям `onError`, следующий
 * `watchDir` поднимает новый (не больше `maxRespawns`); сверх `max` наблюдателей — отказ (`onError` сразу).
 * Код потока — строкой (`eval: true`): в бинаре bun нет файла рядом.
 */

import { Worker } from 'node:worker_threads'

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { watch } = require('node:fs')
const ws = new Map()
parentPort.on('message', (m) => {
  if (m.op === 'open') {
    try {
      const w = watch(m.path, { recursive: m.recursive }, (_ev, name) => { if (ws.has(m.id)) parentPort.postMessage({ op: 'event', id: m.id, name: name ? String(name) : '' }) })
      w.on('error', () => {
        ws.delete(m.id)
        try { w.close() } catch {}
        parentPort.postMessage({ op: 'error', id: m.id })
      })
      ws.set(m.id, w)
      parentPort.postMessage({ op: 'opened', id: m.id })
    } catch (e) {
      parentPort.postMessage({ op: 'error', id: m.id })
    }
  } else if (m.op === 'close') {
    const w = ws.get(m.id)
    ws.delete(m.id)
    if (w) try { w.close() } catch {}
  }
})
`

interface Slot {
  onName: (name: string) => void
  onError: () => void
  opening: ReturnType<typeof setTimeout> | null
}

interface Thread {
  worker: Worker
  slots: Map<number, Slot>
  dead: boolean
}

export interface WatchThreadOptions {
  timeoutMs?: number
  max?: number
  maxRespawns?: number
  log?: (line: string) => void
}

export type WatchDir = (nativePath: string, recursive: boolean, onName: (name: string) => void, onError: () => void) => { close(): void }

export interface WatchThread {
  watchDir: WatchDir
  size(): number
  close(): Promise<void>
}

export function createWatchThread(opts: WatchThreadOptions = {}): WatchThread {
  const timeoutMs = opts.timeoutMs ?? 2000
  const max = opts.max ?? 256
  const maxRespawns = opts.maxRespawns ?? 3
  const log = opts.log ?? ((line: string) => console.warn(line))
  let thread: Thread | null = null
  let spawned = 0
  let nextId = 1

  const live = (): number => thread?.slots.size ?? 0

  function kill(t: Thread, why: string): void {
    if (t.dead) return
    t.dead = true
    if (thread === t) thread = null
    log(`[watch] ${why} — слежение сброшено: ${t.slots.size}`)
    for (const [, s] of t.slots) {
      if (s.opening) clearTimeout(s.opening)
      s.onError()
    }
    t.slots.clear()
    t.worker.terminate().catch(() => {})
  }

  function spawn(): Thread | null {
    if (thread && !thread.dead) return thread
    if (spawned > maxRespawns) return null
    spawned++
    const worker = new Worker(WORKER_SOURCE, { eval: true })
    worker.unref()
    const t: Thread = { worker, slots: new Map(), dead: false }
    worker.on('message', (m: { op: string; id: number; name?: string }) => {
      const s = t.slots.get(m.id)
      if (!s) return
      if (m.op === 'opened') {
        if (s.opening) clearTimeout(s.opening)
        s.opening = null
      } else if (m.op === 'event') {
        try {
          s.onName(m.name ?? '')
        } catch {
          // подписчик упал
        }
      } else if (m.op === 'error') {
        if (s.opening) clearTimeout(s.opening)
        t.slots.delete(m.id)
        s.onError()
      }
    })
    worker.on('error', (e) => kill(t, `поток упал: ${e.message}`))
    worker.on('exit', () => kill(t, 'поток вышел'))
    thread = t
    return t
  }

  return {
    watchDir(path, recursive, onName, onError) {
      const t = live() >= max ? null : spawn()
      if (!t) {
        log(`[watch] ${path}: ${live() >= max ? `лимит ${max}` : 'поток повисал'} — без слежения`)
        queueMicrotask(onError)
        return { close() {} }
      }
      const id = nextId++
      const slot: Slot = { onName, onError, opening: null }
      slot.opening = setTimeout(() => kill(t, `не открылся за ${timeoutMs} мс: ${path}`), timeoutMs)
      slot.opening.unref?.()
      t.slots.set(id, slot)
      t.worker.postMessage({ op: 'open', id, path, recursive })
      return {
        close() {
          if (!t.slots.delete(id)) return
          if (slot.opening) clearTimeout(slot.opening)
          if (!t.dead) t.worker.postMessage({ op: 'close', id })
        },
      }
    },
    size: live,
    async close() {
      const t = thread
      thread = null
      if (!t) return
      t.dead = true
      t.slots.clear()
      await t.worker.terminate().catch(() => 0)
    },
  }
}
