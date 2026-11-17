/**
 * `--ui` у любого тула (kd-cli-spec §9): прогон не-агента в окне — та же сессия `.mds`, что у
 * агента (папка сессий копии для папки вызова). Прогон идёт генерацией обычного бэкенда сессии:
 * реплика человека — команда целиком, ход — диагностика тула (stderr) рассуждением, шаги документа
 * — узлами вызова с результатом, вывод — текстом ответа, файлы-выходы — списком. Лента видна в
 * `<nr-chat>` вживую и остаётся файлом.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GenChunk, GenerateRequest } from '@kerneldreams/backend-http'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { cwdKey } from '../complete-values.js'
import { openWindow, type WindowHandle } from './window.js'

export interface RunOutcome {
  code: number
  output?: string
  artifacts?: unknown[]
}

/** Очередь чанков: пишет прогон, читает генерация. */
class Feed {
  private items: GenChunk[] = []
  private wake: (() => void) | null = null
  private done = false
  push(c: GenChunk): void {
    this.items.push(c)
    this.wake?.()
  }
  end(): void {
    this.done = true
    this.wake?.()
  }
  async *drain(): AsyncIterable<GenChunk> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!
      if (this.done) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

interface StepNode {
  status: string
  body: string
}

/** Шаги из файла состояния прогона (`%step <id> {status}` с JSON в фенсе). */
function readSteps(file: string): Map<string, StepNode> {
  const out = new Map<string, StepNode>()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  const parts = text.split(/^(?=%step )/m).slice(1)
  for (const p of parts) {
    const head = p.split('\n')[0]!
    const id = /^%step\s+(\S+)/.exec(head)?.[1]
    if (!id) continue
    const status = /status["']?\s*:\s*["']?(\w+)/.exec(head)?.[1] ?? 'running'
    out.set(id, { status, body: p.slice(head.length + 1).replace(/^````json\n|\n````\s*$/g, '').trim() })
  }
  return out
}

export interface RunWindowOptions {
  /** Данные копии (папка сессий). */
  dataDir: string
  /** Общий слой — ящик вопросов. */
  home: string
  cwd: string
  /** Команда целиком (`kd forge play …`) — реплика человека. */
  command: string
  title: string
  /** Файл состояния прогона документа с шагами, если есть. */
  stateFile?: string
  /** Открыть браузер (нет — только адрес). */
  open?: boolean
  /** Ждать закрытия окна после прогона (Ctrl+C); тесты — нет. */
  hold?: () => Promise<void>
  log: (m: string) => void
}

/**
 * Исполнить `exec` в окне. `exec` получает `progress` — строку хода (stderr тула идёт туда сам,
 * пока прогон в окне). Возвращает итог прогона и файл сессии.
 */
export async function runInWindow(o: RunWindowOptions, exec: (progress: (line: string) => void) => Promise<RunOutcome>): Promise<RunOutcome & { session: string; url: string }> {
  const { createStoreBackend, withRunAttach } = await import('@kerneldreams/backend-http')
  const { createNrChatStore } = await import('@kerneldreams/chat-store/nr-chat')
  const dir = join(o.dataDir, 'sessions', cwdKey(o.cwd))
  mkdirSync(dir, { recursive: true })
  const store = createNrChatStore({ dir })
  let started = false
  let result: RunOutcome = { code: 1 }
  const generate = (req: GenerateRequest): AsyncIterable<GenChunk> => {
    if (started) {
      // Окно прогона — не чат: вторая реплика не исполняет тул заново.
      return (async function* () {
        yield { type: 'note', text: 'это окно прогона тула; повторить — той же командой в терминале, поговорить — kd agent' } as GenChunk
      })()
    }
    started = true
    const feed = new Feed()
    const progress = (line: string): void => feed.push({ type: 'thinking', delta: line.endsWith('\n') ? line : `${line}\n` })
    const seen = new Map<string, string>()
    const pollSteps = (): void => {
      if (!o.stateFile || !existsSync(o.stateFile)) return
      for (const [id, st] of readSteps(o.stateFile)) {
        const prev = seen.get(id)
        if (prev === st.status) continue
        if (!prev) feed.push({ type: 'tool_call', callId: `step-${id}`, name: id, args: {} })
        if (st.status === 'done') feed.push({ type: 'tool_result', callId: `step-${id}`, name: id, text: st.body || 'готово' })
        seen.set(id, st.status)
      }
    }
    const timer = setInterval(pollSteps, 300)
    void (async () => {
      try {
        result = await exec(progress)
        pollSteps()
        // Шаги, которые кончились вместе с прогоном (файл состояния снят удачей), — закрыть.
        for (const [id, s] of seen) if (s !== 'done') feed.push({ type: result.code === 0 ? 'tool_result' : 'tool_error', callId: `step-${id}`, name: id, ...(result.code === 0 ? { text: 'готово' } : { message: `прогон кончился с кодом ${result.code}` }) } as GenChunk)
        const files = result.artifacts?.length ? `\n\nфайлы:\n${result.artifacts.map((f) => `- ${f}`).join('\n')}` : ''
        const text = (result.output ?? '').trim()
        feed.push({ type: 'text', delta: `${text || (result.code === 0 ? 'готово' : '')}${files}` || `код ${result.code}` })
        if (result.code !== 0) feed.push({ type: 'note', text: `kd: код выхода ${result.code}` })
      } catch (err) {
        result = { code: 1 }
        feed.push({ type: 'note', text: `kd: тул упал — ${(err as Error).message}` })
      } finally {
        clearInterval(timer)
        feed.end()
      }
    })()
    void req
    return feed.drain()
  }
  // Ран живёт в процессе, окно подписывается на него (sessions.attach): та же обёртка, что у serveBackend.
  const backend: ProtocolBackend = withRunAttach(createStoreBackend({ store, generate, name: 'kd' }))
  const created = (await backend.sessions.create({ title: o.title, meta: { workspace: { cwd: o.cwd } } } as never)) as unknown as { id: string }
  const sid = created.id
  let win: WindowHandle | undefined
  try {
    win = await openWindow(backend, { home: o.home, title: o.title, cwd: o.cwd, session: sid, ...(o.open === false ? { open: false } : {}) })
    o.log(`kd: окно ${win.url}`)
    for await (const ev of backend.run(sid, { userMessage: o.command } as never)) void ev
    const file = join(dir, `${sid}.mds`)
    if (o.hold) {
      o.log('kd: окно открыто — Ctrl+C закрыть')
      await o.hold()
    }
    return { ...result, session: existsSync(file) ? file : dir, url: win.url }
  } finally {
    await win?.close()
  }
}

export const runTitle = (tool: string, cwd: string): string => `${tool} · ${basename(cwd)}`
