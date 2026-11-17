/**
 * Ящик вопросов (kd-cli-spec §8, §9): файлы `<общий слой>/inbox/`. Пишет спрашивающий процесс,
 * показывают все лица, что сейчас открыты (терминал прогона, окна `kd ui`, помощник), плюс
 * системное уведомление от самого процесса. Резидента нет.
 *
 * Вопрос: `<id>.mdz` — `$question`, `$options`, `$default`, `$deadline` (ISO), `$pid`, `$from`.
 * Ответ: `<id>.answer` рядом (кто первый). Человека нет — ни терминала, ни открытого окна
 * (окна отмечаются файлами `inbox/.faces/<pid>`) — срок ноль: берётся умолчание.
 * Прогон вопросом не блокируется: срок всегда конечен.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export interface Question {
  id: string
  question: string
  options: string[]
  default: string
  deadline: string
  pid: number
  from: string
}

export interface Answer {
  answer: string
  /** `human` — ответил человек; `default` — взято умолчание (срок вышел или человека нет). */
  by: 'human' | 'default'
}

export const inboxDir = (home: string): string => join(home, 'inbox')
const facesDir = (home: string): string => join(inboxDir(home), '.faces')

const q = (s: string): string => JSON.stringify(s)

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Отметить открытое лицо (окно `kd ui`); снять — вернувшейся функцией. Отметка живёт, пока жив процесс. */
export function registerFace(home: string, kind: string): () => void {
  mkdirSync(facesDir(home), { recursive: true })
  const f = join(facesDir(home), String(process.pid))
  writeFileSync(f, kind)
  return () => rmSync(f, { force: true })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Открытые окна сейчас (мёртвые отметки чистятся). */
export function openFaces(home: string): number {
  let n = 0
  try {
    for (const f of readdirSync(facesDir(home))) {
      const pid = Number(f)
      if (Number.isInteger(pid) && alive(pid)) n++
      else rmSync(join(facesDir(home), f), { force: true })
    }
  } catch {
    // нет папки — нет окон
  }
  return n
}

export function listQuestions(home: string): Question[] {
  const dir = inboxDir(home)
  if (!existsSync(dir)) return []
  const out: Question[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mdz')) continue
    try {
      const text = readFileSync(join(dir, f), 'utf8')
      const get = (k: string): string => {
        const m = new RegExp(`^\\$${k}:\\s*(.*)$`, 'm').exec(text)?.[1] ?? ''
        try {
          return m.startsWith('"') ? (JSON.parse(m) as string) : m
        } catch {
          return m
        }
      }
      if (existsSync(join(dir, f.replace(/\.mdz$/, '.answer')))) continue
      const optsRaw = get('options')
      out.push({ id: f.replace(/\.mdz$/, ''), question: get('question'), options: optsRaw ? (JSON.parse(optsRaw) as string[]) : [], default: get('default'), deadline: get('deadline'), pid: Number(get('pid')), from: get('from') })
    } catch {
      // битый вопрос — пропуск
    }
  }
  return out.sort((a, b) => a.deadline.localeCompare(b.deadline))
}

/** Ответить на вопрос (любое лицо). */
export function answerQuestion(home: string, id: string, answer: string): boolean {
  if (!/^[\w.-]+$/.test(id)) return false
  const f = join(inboxDir(home), `${id}.mdz`)
  if (!existsSync(f)) return false
  writeAtomic(join(inboxDir(home), `${id}.answer`), answer)
  return true
}

function notify(title: string, body: string): void {
  try {
    const p =
      process.platform === 'darwin'
        ? spawn('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`], { stdio: 'ignore', detached: true })
        : process.platform === 'linux'
          ? spawn('notify-send', [title, body], { stdio: 'ignore', detached: true })
          : null
    p?.on('error', () => {})
    p?.unref()
  } catch {
    // уведомления нет — не беда
  }
}

/**
 * Хаб для вопросов (§9): `$hub` настроек kd (адрес API хаба, `…/api`) и `$hub_key` (ключ, если хаб с ключом);
 * перебивают `KD_HUB` / `KD_HUB_KEY`. Нет — вопросы только файлами.
 */
export interface HubTarget {
  url: string
  key?: string
}

export function hubOf(settings: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): HubTarget | undefined {
  const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const url = pick(env.KD_HUB) || pick(settings.hub)
  if (!url || /^(off|no|false)$/i.test(url)) return undefined
  const key = pick(env.KD_HUB_KEY) || pick(settings.hub_key)
  return { url: url.replace(/\/+$/, ''), ...(key ? { key } : {}) }
}

/** Вызов встроенного сервиса хаба `questions` (`POST <hub>/services/questions/<метод>`). */
async function hubCall<T>(hub: HubTarget, method: string, args: Record<string, unknown>, timeoutMs = 4000): Promise<T> {
  const res = await fetch(`${hub.url}/services/questions/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(hub.key ? { authorization: `Bearer ${hub.key}` } : {}) },
    body: JSON.stringify({ args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string }
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
  return body.result as T
}

export interface AskOptions {
  /** Хаб: вопрос дублируется туда (nrchat «Ждёт тебя», уведомление на телефон), ответ оттуда — в ящик. */
  hub?: HubTarget
  /** Что не так с хабом (недоступен) — одной строкой; прогон идёт дальше файлами. */
  warn?: (text: string) => void
  /** Шаг опроса ответа хаба. */
  hubPollMs?: number
  question: string
  options?: string[]
  default: string
  /** Срок, мс (по умолчанию 10 мин); человека нет — ноль. */
  timeoutMs?: number
  from?: string
  /** Терминал прогона, если он есть: вопрос там же. */
  terminal?: (text: string) => Promise<string>
  /** Шаг ожидания ответа файлом. */
  pollMs?: number
}

/** Задать вопрос: ответ человека (терминал, окно) или умолчание по сроку. Прогон не блокируется дольше срока. */
export async function ask(home: string, o: AskOptions): Promise<Answer> {
  const human = !!o.terminal || openFaces(home) > 0
  if (!human) return { answer: o.default, by: 'default' }
  const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  const dir = inboxDir(home)
  mkdirSync(dir, { recursive: true })
  const timeout = o.timeoutMs ?? 10 * 60_000
  const deadline = new Date(Date.now() + timeout).toISOString()
  const file = join(dir, `${id}.mdz`)
  const answerFile = join(dir, `${id}.answer`)
  writeAtomic(file, [`$question: ${q(o.question)}`, `$options: ${JSON.stringify(o.options ?? [])}`, `$default: ${q(o.default)}`, `$deadline: ${deadline}`, `$pid: ${process.pid}`, `$from: ${q(o.from ?? 'kd')}`, ''].join('\n'))
  notify(`kd: вопрос${o.from ? ` (${o.from})` : ''}`, o.question)
  // Есть хаб — вопрос дублируется туда: человек увидит его там, где он сейчас. Хаб недоступен — только файлы.
  let onHub = false
  if (o.hub) {
    try {
      await hubCall(o.hub, 'ask', { id, question: o.question, options: o.options ?? [], default: o.default, deadline, from: o.from ?? 'kd', host: hostname() })
      onHub = true
    } catch (err) {
      o.warn?.(`kd: хаб ${o.hub.url} не принял вопрос (${(err as Error).message}) — вопрос только в ящике ${dir}`)
    }
  }
  let done = false
  const cleanup = (): void => {
    done = true
    rmSync(file, { force: true })
    rmSync(answerFile, { force: true })
    if (onHub && o.hub) void hubCall(o.hub, 'cancel', { id }).catch(() => undefined)
  }
  let lastHub = 0
  const fromHub = async (): Promise<string | undefined> => {
    if (!onHub || !o.hub || Date.now() - lastHub < (o.hubPollMs ?? 1500)) return undefined
    lastHub = Date.now()
    try {
      const r = await hubCall<{ answer?: string } | null>(o.hub, 'get', { id })
      return typeof r?.answer === 'string' ? r.answer : undefined
    } catch {
      return undefined
    }
  }
  const byFile = (async (): Promise<Answer> => {
    const step = o.pollMs ?? 300
    while (!done && Date.now() < Date.parse(deadline)) {
      const viaHub = await fromHub()
      if (viaHub !== undefined && !done) {
        // Ответ из хаба — в ящик: остальные лица (окна, терминал) видят, что вопрос закрыт.
        writeAtomic(answerFile, viaHub)
        return { answer: viaHub.trim() || o.default, by: 'human' }
      }
      if (existsSync(answerFile)) {
        try {
          if (statSync(answerFile).size >= 0) return { answer: readFileSync(answerFile, 'utf8').trim() || o.default, by: 'human' }
        } catch {
          // гонка с записью — следующий круг
        }
      }
      await new Promise((r) => setTimeout(r, step))
    }
    return { answer: o.default, by: 'default' }
  })()
  const byTerminal = o.terminal
    ? o.terminal(`${o.question}${o.options?.length ? ` [${o.options.join('/')}]` : ''} (по умолчанию: ${o.default}; срок ${Math.round(timeout / 1000)} с): `).then((a): Answer => ({ answer: a.trim() || o.default, by: a.trim() ? 'human' : 'default' }))
    : new Promise<Answer>(() => {})
  try {
    return await Promise.race([byFile, byTerminal])
  } finally {
    cleanup()
  }
}
