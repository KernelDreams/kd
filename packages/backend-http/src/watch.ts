/**
 * Слежение за каталогами вне главного потока.
 *
 * 22.10 lab nr завис на 1,5 ч: главный поток стоял в `FSEventWrap::Start → uv_fs_event_start →
 * uv_sem_wait` — libuv на macOS ждёт поток CF-loop FSEvents, и после сотни create/close
 * наблюдателей подряд дожидается его вечно. Порт принимает, ответов нет, лог молчит.
 *
 * Поэтому `fs.watch` живёт в одном `worker_threads`-потоке на процесс: его цикл libuv свой, и
 * если FSEvents встанет — встанет он, а не HTTP. Zero-dep (DECISIONS 22.10: хост-агент
 * берёт тот же код на хостах; `@parcel/watcher` не нужен).
 *
 *   • открытие не ответило за `timeoutMs` (2 с) — отказ, поток считается повисшим: его
 *     наблюдатели получают `onError`, следующий запрос поднимает новый поток (не больше
 *     `maxRespawns` раз за жизнь процесса — дальше слежения нет);
 *   • не больше `max` наблюдателей одновременно; сверх — отказ;
 *   • каждый отказ — одна строка в лог; панель без слежения живёт по фокусу и Ctrl+R.
 */

import { Worker } from 'node:worker_threads'
import { MAX_DIRS, SKIP_DIRS } from './watch-tree.js'

export interface WatchSink {
  /** Имя изменившегося файла относительно корня (`''` — «перечитай всё»). */
  onEvent(name: string): void
  /** Наблюдатель умер (каталог удалён, поток повис) — событий больше не будет. */
  onError(): void
}

export interface WatchHandle {
  /** Открыт; отказ — `code: watch_limit | watch_failed`, строка в лог уже есть. */
  ready: Promise<void>
  /** Можно звать и до `ready`: слот освобождается сразу. */
  close(): void
}

export interface WatchPoolOptions {
  /** Сколько ждать открытия наблюдателя; default 2000 мс. */
  timeoutMs?: number
  /** Наблюдателей одновременно; default 128. */
  max?: number
  /** Сколько раз поднимать поток заново после зависания; default 3. */
  maxRespawns?: number
  /** Одна строка на отказ; default `console.warn`. */
  log?: (line: string) => void
  /** Тесты: код потока вместо встроенного. */
  workerSource?: string
}

export interface WatchPool {
  open(path: string, recursive: boolean, sink: WatchSink): WatchHandle
  /** Открытых наблюдателей (и открываемых). */
  size(): number
  /** Остановить поток (тесты, выход). */
  close(): Promise<void>
}

/** Поток: `open/close` по id, события копятся 50 мс и уходят пачкой. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { watch, readdir, stat } = require('node:fs')
const { join, relative } = require('node:path')
const SKIP = new Set(${JSON.stringify(SKIP_DIRS)})
const MAX_DIRS = ${MAX_DIRS}
// Linux: recursive в Node — синхронный обход и вотч на каждый файл (server 30.10: 1.6 млн). Тот же обход, что watchTree.
function watchLinuxTree(root, onEvent, onError) {
  const dirs = new Map()
  let closed = false
  const drop = (dir) => {
    for (const [d, w] of dirs) if (d === dir || d.startsWith(dir + '/')) { try { w.close() } catch {} dirs.delete(d) }
  }
  const add = (dir, done) => {
    if (closed || dirs.has(dir) || dirs.size >= MAX_DIRS) return done()
    let w
    try {
      w = watch(dir, (_ev, name) => {
        if (!name) return onEvent('')
        const path = join(dir, String(name))
        onEvent(relative(root, path))
        stat(path, (e, s) => {
          if (e) drop(path)
          else if (s.isDirectory() && !SKIP.has(String(name))) add(path, () => {})
        })
      })
    } catch (e) {
      if (dir === root) throw e
      return done()
    }
    w.on('error', () => (dir === root ? onError() : drop(dir)))
    dirs.set(dir, w)
    readdir(dir, { withFileTypes: true }, (_e, items) => {
      const subs = (items || []).filter((it) => it.isDirectory() && !SKIP.has(it.name))
      const next = () => (subs.length ? add(join(dir, subs.shift().name), next) : done())
      next()
    })
  }
  add(root, () => {})
  return { close() { closed = true; for (const w of dirs.values()) try { w.close() } catch {} dirs.clear() } }
}
const ws = new Map()
let batch = new Map()
let timer = null
const CAP = 1000
function flush() {
  timer = null
  const out = []
  for (const [id, names] of batch) out.push([id, names === null ? [''] : [...names]])
  batch = new Map()
  if (out.length) parentPort.postMessage({ op: 'events', out })
}
function push(id, name) {
  let names = batch.get(id)
  if (names === undefined) batch.set(id, (names = new Set()))
  if (names !== null) {
    names.add(name)
    if (names.size > CAP) batch.set(id, null)
  }
  if (!timer) timer = setTimeout(flush, 50)
}
parentPort.on('message', (m) => {
  if (m.op === 'open') {
    try {
      const fail = () => {
        ws.delete(m.id)
        try { w.close() } catch {}
        parentPort.postMessage({ op: 'error', id: m.id })
      }
      const onEvent = (name) => { if (ws.has(m.id)) push(m.id, name) }
      const tree = m.recursive && process.platform === 'linux'
      const w = tree ? watchLinuxTree(m.path, onEvent, fail) : watch(m.path, { recursive: m.recursive }, (_ev, name) => onEvent(name ? String(name) : ''))
      if (!tree) w.on('error', fail)
      ws.set(m.id, w)
      parentPort.postMessage({ op: 'opened', id: m.id })
    } catch (e) {
      parentPort.postMessage({ op: 'failed', id: m.id, message: String(e && e.message || e) })
    }
  } else if (m.op === 'close') {
    const w = ws.get(m.id)
    ws.delete(m.id)
    batch.delete(m.id)
    if (w) try { w.close() } catch {}
  }
})
`

type Msg =
  | { op: 'opened' | 'error'; id: number }
  | { op: 'failed'; id: number; message: string }
  | { op: 'events'; out: [number, string[]][] }

interface Slot {
  sink: WatchSink
  /** Открытие ждёт ответа потока. */
  opening: { ok: () => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null
  closed: boolean
}

interface Thread {
  worker: Worker
  slots: Map<number, Slot>
  dead: boolean
}

export function createWatchPool(opts: WatchPoolOptions = {}): WatchPool {
  const timeoutMs = opts.timeoutMs ?? 2000
  const max = opts.max ?? 128
  const maxRespawns = opts.maxRespawns ?? 3
  const log = opts.log ?? ((line: string) => console.warn(line))
  const source = opts.workerSource ?? WORKER_SOURCE
  let thread: Thread | null = null
  let spawned = 0
  let nextId = 1
  let live = 0

  function spawn(): Thread | null {
    if (thread && !thread.dead) return thread
    if (spawned > maxRespawns) return null
    spawned++
    const worker = new Worker(source, { eval: true })
    worker.unref()
    const t: Thread = { worker, slots: new Map(), dead: false }
    worker.on('message', (m: Msg) => {
      if (m.op === 'events') {
        for (const [id, names] of m.out) {
          const s = t.slots.get(id)
          if (!s || s.closed || s.opening) continue
          for (const n of names) {
            try {
              s.sink.onEvent(n)
            } catch {
              // подписчик упал — остальным всё равно
            }
          }
        }
        return
      }
      const s = t.slots.get(m.id)
      if (!s) return
      if (m.op === 'opened') {
        if (s.opening) {
          clearTimeout(s.opening.timer)
          const o = s.opening
          s.opening = null
          o.ok()
        }
      } else if (m.op === 'failed') {
        drop(t, m.id)
        if (s.opening) {
          clearTimeout(s.opening.timer)
          s.opening.bad(Object.assign(new Error(m.message), { code: 'watch_failed' }))
          s.opening = null
        }
      } else if (m.op === 'error') {
        drop(t, m.id)
        if (!s.closed) s.sink.onError()
      }
    })
    const die = (why: string): void => {
      if (t.dead) return
      kill(t, why)
    }
    worker.on('error', (e) => die(`поток упал: ${e.message}`))
    worker.on('exit', () => die('поток вышел'))
    thread = t
    return t
  }

  function drop(t: Thread, id: number): void {
    const s = t.slots.get(id)
    if (!s) return
    t.slots.delete(id)
    live--
    s.closed = true
  }

  /** Поток повис или умер: всем его наблюдателям — `onError`, следующий `open` поднимет новый. */
  function kill(t: Thread, why: string): void {
    t.dead = true
    if (thread === t) thread = null
    log(`[files.watch] ${why} — без слежения (фокус и Ctrl+R), сброшено: ${t.slots.size}${spawned > maxRespawns ? '; поток больше не поднимаем до перезапуска' : ''}`)
    for (const [id, s] of [...t.slots]) {
      drop(t, id)
      if (s.opening) {
        clearTimeout(s.opening.timer)
        s.opening.bad(Object.assign(new Error(why), { code: 'watch_failed' }))
        s.opening = null
      } else s.sink.onError()
    }
    // Повисший в uv_sem_wait поток terminate может и не остановить — он unref и процесс не держит.
    t.worker.terminate().catch(() => {})
  }

  return {
    open(path, recursive, sink) {
      const refuse = (code: string, message: string): WatchHandle => {
        const ready = Promise.reject(Object.assign(new Error(message), { code }))
        ready.catch(() => {})
        return { ready, close() {} }
      }
      if (live >= max) {
        log(`[files.watch] лимит ${max} наблюдателей: ${path} — без слежения`)
        return refuse('watch_limit', `лимит наблюдателей ${max}`)
      }
      const t = spawn()
      if (!t) return refuse('watch_failed', 'слежение выключено: поток повисал')
      const id = nextId++
      const slot: Slot = { sink, opening: null, closed: false }
      t.slots.set(id, slot)
      live++
      const ready = new Promise<void>((ok, bad) => {
        slot.opening = {
          ok,
          bad,
          timer: setTimeout(() => {
            if (slot.opening) kill(t, `не открылся за ${timeoutMs} мс: ${path}`)
          }, timeoutMs),
        }
      })
      ready.catch(() => {})
      t.worker.postMessage({ op: 'open', id, path, recursive })
      return {
        ready,
        close() {
          if (slot.closed) return
          drop(t, id)
          if (slot.opening) {
            clearTimeout(slot.opening.timer)
            slot.opening.bad(Object.assign(new Error('закрыт до открытия'), { code: 'watch_closed' }))
            slot.opening = null
          }
          if (!t.dead) t.worker.postMessage({ op: 'close', id })
        },
      }
    },
    size: () => live,
    async close() {
      const t = thread
      thread = null
      if (!t) return
      t.dead = true
      for (const [id, s] of [...t.slots]) {
        drop(t, id)
        if (s.opening) {
          clearTimeout(s.opening.timer)
          s.opening.bad(Object.assign(new Error('пул закрыт'), { code: 'watch_failed' }))
        }
      }
      await t.worker.terminate().catch(() => 0)
    },
  }
}

let shared: WatchPool | null = null
/** Один поток слежения на процесс (лимит — тоже на процесс). */
export function sharedWatchPool(): WatchPool {
  return (shared ??= createWatchPool())
}
