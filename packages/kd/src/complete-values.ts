/**
 * Значения из данных для Tab (kd-cli-spec §6): модели, машины, боты, задачи, сессии, скиллы.
 * Без рантайма и nrd — источники уже разобраны полным входом в кэш каталога (`values`).
 *
 * Источник — блок `## $complete <вид>` в настройках или конфиге слоя:
 * - `$list` — готовый список;
 * - `$dir` (+ `$ext`) — имена в папке (`{cwd}` — папка вызова в виде имени папки сессий);
 * - `$blocks` + `$section` — имена блоков `## $<section> <имя>` файла;
 * - `$url` (+ `$method`, `$body`, `$headers`, `$path`, `$value`, `$label`, `$ttl`) — с сети,
 *   ответ до 300 мс (не успел — подсказки нет), удачный ответ живёт в кэше `$ttl` секунд.
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ValueSource {
  kind: string
  list?: string[]
  dir?: string
  ext?: string
  blocks?: string
  section?: string
  url?: string
  method?: string
  body?: string
  headers?: Record<string, string>
  /** Путь до массива: `result.content.0.text.items`; строка-JSON по дороге разбирается сама. */
  path?: string
  value?: string
  label?: string
  /** Секунды жизни ответа сети в кэше (по умолчанию 600). */
  ttl?: number
}

/** Виды, у которых имя поля само говорит, откуда значения (`--model=`, `--host=`). */
export const DATA_KINDS = ['model', 'host', 'bot', 'task', 'session', 'skill'] as const

/** Бюджет сети (§6). */
export const NET_BUDGET_MS = 300

const expand = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** Имя папки сессий для папки вызова (как у `kd agent`). */
export const cwdKey = (cwd: string): string => resolve(cwd).replace(/^\/+/, '').replace(/[\\/:]+/g, '__') || 'root'

function fromDir(s: ValueSource, cwd: string): string[] {
  const dir = expand(s.dir!.replace('{cwd}', cwdKey(cwd)))
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const exts = s.ext ? s.ext.split(',').map((e) => e.trim()).filter(Boolean) : []
  const out: Array<{ n: string; t: number }> = []
  for (const n of names) {
    if (n.startsWith('.')) continue
    const ext = exts.find((e) => n.endsWith(e))
    if (exts.length && !ext) continue
    let t = 0
    try {
      t = statSync(join(dir, n)).mtimeMs
    } catch {
      continue
    }
    out.push({ n: ext ? n.slice(0, -ext.length) : n, t })
  }
  // Свежие первыми: последняя сессия, последний бот.
  return out.sort((a, b) => b.t - a.t).map((x) => x.n)
}

function fromBlocks(s: ValueSource): string[] {
  let text = ''
  try {
    text = readFileSync(expand(s.blocks!), 'utf8')
  } catch {
    return []
  }
  const re = new RegExp(`^## \\$${(s.section ?? '').replace(/[^\w-]/g, '')}\\s+(\\S+)`, 'gm')
  return [...text.matchAll(re)].map((m) => m[1]!)
}

/** Локальные значения вида (без сети). */
export function localValues(sources: ValueSource[], kind: string, cwd: string): string[] {
  const out: string[] = []
  for (const s of sources) {
    if (s.kind !== kind) continue
    if (s.list) out.push(...s.list)
    if (s.dir) out.push(...fromDir(s, cwd))
    if (s.blocks) out.push(...fromBlocks(s))
  }
  return [...new Set(out)]
}

/** Шаг пути по ответу: строка-JSON и SSE (`data:`) разбираются по дороге. */
function step(v: unknown): unknown {
  if (typeof v !== 'string') return v
  let t = v.trim()
  if (/^(event|data):/m.test(t)) t = t.split('\n').filter((l) => l.startsWith('data:')).at(-1)?.slice(5).trim() ?? ''
  if (!/^[[{]/.test(t)) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
  }
}

export function pick(body: unknown, path: string | undefined, value = 'id', label?: string): string[] {
  let cur: unknown = step(body)
  for (const k of (path ?? '').split('.').filter(Boolean)) {
    cur = step(cur)
    if (cur == null || typeof cur !== 'object') return []
    cur = (cur as Record<string, unknown>)[k]
  }
  cur = step(cur)
  if (!Array.isArray(cur)) return []
  return cur
    .map((x) => {
      if (typeof x === 'string') return x
      if (!x || typeof x !== 'object') return ''
      const o = x as Record<string, unknown>
      // Имя поля или шаблон из полей: `{project_key}-{number}`.
      const get = (k: string): unknown => (k.includes('{') ? k.replace(/\{([\w.-]+)\}/g, (_, f: string) => String(o[f] ?? '')) : o[k])
      const v = get(value)
      if (v == null || v === '') return ''
      const l = label ? get(label) : undefined
      return l ? `${String(v)}\t${String(l).replace(/\s+/g, ' ').slice(0, 80)}` : String(v)
    })
    .filter(Boolean)
}

const envSub = (s: string, env: NodeJS.ProcessEnv): string => s.replace(/\$\{env\.([A-Za-z0-9_]+)\}/g, (_, k: string) => env[k] ?? '')

export interface NetOptions {
  budget?: number
  /** Позвать, когда ответ сети протух или не успел: обновить кэш в стороне, для следующего Tab. */
  refresh?: (kind: string) => void
  /** Мимо кэша (само обновление). */
  force?: boolean
}

/**
 * Значения вида с сети. Свежий кэш (`$ttl`) — сразу; протухший — сразу и обновление в стороне;
 * кэша нет — запрос до бюджета, не успел — пусто и обновление в стороне.
 */
export async function netValues(sources: ValueSource[], kind: string, cacheDir: string, env: NodeJS.ProcessEnv = process.env, opts: NetOptions = {}): Promise<string[]> {
  const nets = sources.filter((s) => s.kind === kind && s.url)
  if (!nets.length) return []
  const deadline = Date.now() + (opts.budget ?? NET_BUDGET_MS)
  let stale = false
  const results = await Promise.all(
    nets.map(async (s, i) => {
      const file = join(cacheDir, `values-${kind.replace(/\W/g, '_')}-${i}.json`)
      if (!opts.force) try {
        const c = JSON.parse(readFileSync(file, 'utf8')) as { url: string; at: number; items: string[] }
        if (c.url === s.url) {
          if (Date.now() - c.at >= (s.ttl ?? 600) * 1000) stale = true
          return c.items
        }
      } catch {
        // кэша нет
      }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), Math.max(0, deadline - Date.now()))
      try {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = envSub(v, env)
        const res = await fetch(envSub(s.url!, env), { method: s.method ?? (s.body ? 'POST' : 'GET'), headers, ...(s.body ? { body: s.body } : {}), signal: ctl.signal })
        if (!res.ok) return []
        const items = pick(await res.text(), s.path, s.value, s.label)
        try {
          const tmp = `${file}.${process.pid}.tmp`
          writeFileSync(tmp, JSON.stringify({ url: s.url, at: Date.now(), items }), { mode: 0o600 })
          renameSync(tmp, file)
        } catch {
          // кэш не записался — не беда
        }
        return items
      } catch {
        stale = true
        return []
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  if (stale) opts.refresh?.(kind)
  return [...new Set(results.flat())]
}
