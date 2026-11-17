/**
 * Лёгкая точка входа подсказок `kd __complete <слова>` (kd-cli-spec §6): без рантайма и nrd —
 * только кэш каталога и файловая система, ответ из кэша до 50 мс. Строка ответа — `значение\tописание`.
 * Последнее слово — то, что дописывается (может быть пустым).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CompletionCache, CachedTool, CachedField } from './node/cache.js'
import { spawn, spawnSync } from 'node:child_process'
import { DATA_KINDS, localValues, netValues, type NetOptions } from './complete-values.js'

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Папка данных копии без разбора mdz: `kd-copy.mdz` читается регулярками. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.KD_HOME || join(homedir(), '.kd')
  const root = env.KD_COPY_DIR || KIT_ROOT
  let text = ''
  try {
    text = readFileSync(join(root, 'kd-copy.mdz'), 'utf8')
  } catch {
    return home
  }
  const mode = /^\$mode:\s*(\S+)/m.exec(text)?.[1] === 'portable' ? 'portable' : 'installed'
  const data = /^\$data:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const id = /^\$id:\s*(\S+)/m.exec(text)?.[1] ?? 'app'
  if (data) return isAbsolute(data) ? data : resolve(root, data)
  return mode === 'portable' ? join(root, 'data') : join(home, 'apps-data', id)
}

const KIND_BY_EXT: Record<string, string> = { png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', mp3: 'audio', wav: 'audio', mp4: 'video', mov: 'video', pdf: 'pdf', md: 'text', mdz: 'text', mds: 'session' }

function files(cwd: string, cur: string, kind?: string): string[] {
  const dirPart = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : ''
  const base = cur.slice(dirPart.length)
  const dir = resolve(cwd, dirPart.startsWith('~/') ? join(homedir(), dirPart.slice(2)) : dirPart || '.')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const n of names) {
    if (!n.startsWith(base) || (n.startsWith('.') && !base.startsWith('.'))) continue
    let isDir = false
    try {
      isDir = statSync(join(dir, n)).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(`${dirPart}${n}/`)
    else if (!kind || kind === 'file' || KIND_BY_EXT[extname(n).slice(1).toLowerCase()] === kind || (kind === 'doc' && /\.(md|mdz|mdd)$/i.test(n))) out.push(`${dirPart}${n}`)
    if (out.length > 200) break
  }
  return out
}

const applies = (f: { for?: string[] }, action: string | undefined): boolean => !f.for || !f.for.length || (action !== undefined && f.for.includes(action))

/** Вид значений поля: `$kind`, иначе имя поля, если оно — вид данных (`--model=`). */
export const valueKind = (f: CachedField): string | undefined => (f.kind && (DATA_KINDS as readonly string[]).includes(f.kind) ? f.kind : (DATA_KINDS as readonly string[]).includes(f.name) ? f.name : f.kind)

/** Что дописывается значением: вид данных и префикс строки (`--model=`). */
export interface ValueAsk {
  kind: string
  prefix: string
  cur: string
}

function toolWords(t: CachedTool, prev: string[], cur: string, cwd: string, ask: ValueAsk[] = [], values: CompletionCache['values'] = []): string[] {
  const actions = new Set(t.actions.map((a) => a.name))
  const action = prev.find((w) => actions.has(w)) ?? t.actions.find((a) => a.default)?.name
  if (cur.startsWith('--')) {
    const eq = cur.indexOf('=')
    if (eq > 0) {
      const f = t.fields.find((x) => x.name === cur.slice(2, eq))
      const v = cur.slice(eq + 1)
      if (!f) return []
      if (f.enum) return f.enum.filter((e) => e.startsWith(v)).map((e) => `--${f.name}=${e}`)
      if (f.kind === 'file' || f.kind === 'image' || f.kind === 'doc') return files(cwd, v, f.kind).map((p) => `--${f.name}=${p}`)
      const k = valueKind(f)
      if (!k) return []
      ask.push({ kind: k, prefix: `--${f.name}=`, cur: v })
      return localValues(values, k, cwd).filter((x) => x.startsWith(v)).map((x) => `--${f.name}=${x}`)
    }
    return t.fields
      .filter((f) => applies(f, action) && `--${f.name}`.startsWith(cur))
      .map((f) => `--${f.name}${f.type === 'boolean' ? '' : '='}\t${f.title ?? ''}${f.default !== undefined && f.default !== '' && f.default !== false ? ` (по умолчанию ${String(f.default)})` : ''}`)
  }
  const out: string[] = []
  if (!prev.some((w) => actions.has(w))) for (const a of t.actions) if (a.name.startsWith(cur)) out.push(`${a.name}\t${a.title ?? ''}`)
  // Следующее позиционное поле с видом данных — его значения.
  const used = prev.filter((w) => !w.startsWith('-') && !actions.has(w)).length
  const posField = t.fields.filter((f) => applies(f, action) && (f.pos !== undefined || f.rest)).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99))[used]
  const pk = posField && valueKind(posField)
  if (pk && !cur.startsWith('-')) {
    ask.push({ kind: pk, prefix: '', cur })
    out.push(...localValues(values, pk, cwd).filter((x) => x.startsWith(cur)))
  }
  const wantsFile = t.fields.some((f) => applies(f, action) && (f.kind === 'file' || f.kind === 'image' || f.kind === 'doc') && (f.pos !== undefined || f.rest))
  if (wantsFile || !t.actions.length) out.push(...files(cwd, cur, t.fields.find((f) => f.kind === 'image')?.kind))
  return out
}

function objectWords(c: CompletionCache, word: string, cur: string, cwd: string): string[] {
  const kinds = new Set<string>()
  for (const r of c.rules) {
    try {
      const m = new RegExp(`^(?:${r.pattern})$`, 'u').exec(word)
      if (m) {
        kinds.add(r.id)
        if (r.kind) kinds.add(r.kind)
      }
    } catch {
      // битый шаблон
    }
  }
  try {
    if (statSync(resolve(cwd, word)).isFile()) {
      kinds.add('file')
      const k = KIND_BY_EXT[extname(word).slice(1).toLowerCase()]
      if (k) kinds.add(k)
    }
  } catch {
    // не файл
  }
  const seen = new Set<string>()
  return c.actions.filter((a) => kinds.has(a.for) && a.word.startsWith(cur) && !seen.has(a.word) && seen.add(a.word)).map((a) => `${a.word}\t${a.title ?? ''}`)
}

/** Подсказки для слов после `kd` (последнее — дописываемое). `ask` — куда дописать запросы значений с сети. */
export function complete(words: string[], cache: CompletionCache | null, cwd: string, ask: ValueAsk[] = []): string[] {
  const cur = words[words.length - 1] ?? ''
  const prev = words.slice(0, -1).filter((w) => !['--dry', '--json', '-v', '--verbose'].includes(w) || words.indexOf(w) > 0)
  const svc = ['--dry', '--json', '-v', '--help']
  if (prev.length === 0) {
    if (cur.startsWith('-')) return svc.filter((s) => s.startsWith(cur))
    const tools = cache ? Object.entries(cache.tools).filter(([n]) => n.startsWith(cur)).map(([n, t]) => `${n}\t${t.description}`) : []
    // Объекты первым словом: значения видов, у которых есть правило объекта (`kd AB-1<Tab>`).
    const objs: string[] = []
    if (cache && cur) {
      const kinds = new Set(cache.rules.map((r) => r.kind).filter((k): k is string => !!k))
      for (const k of kinds) {
        if (!(cache.values ?? []).some((s) => s.kind === k)) continue
        ask.push({ kind: k, prefix: '', cur })
        objs.push(...localValues(cache.values, k, cwd).filter((x) => x.startsWith(cur)))
      }
    }
    return [...tools.sort(), ...objs, ...files(cwd, cur)]
  }
  if (!cache) return []
  const first = prev[0]!
  const t = cache.tools[first]
  if (t) return toolWords(t, prev.slice(1), cur, cwd, ask, cache.values ?? [])
  return objectWords(cache, first, cur, cwd)
}

/** Подсказки с данными сети (до 300 мс сверх кэша, §6). */
export async function completeAll(words: string[], cache: CompletionCache | null, cwd: string, cacheDir: string, env: NodeJS.ProcessEnv = process.env, opts: NetOptions = {}): Promise<string[]> {
  const ask: ValueAsk[] = []
  const out = complete(words, cache, cwd, ask)
  if (!cache?.values?.length || !ask.length) return out
  const seen = new Set(out.map((l) => l.split('\t')[0]))
  for (const a of ask) {
    const net = await netValues(cache.values, a.kind, cacheDir, env, opts)
    for (const v of net) {
      const line = `${a.prefix}${v}`
      if (v.startsWith(a.cur) && !seen.has(line.split('\t')[0])) {
        seen.add(line.split('\t')[0])
        out.push(line)
      }
    }
  }
  return out
}

/** Метка файла как у кэша (`node/cache.ts`, `fileMark`): время правки и размер; нет файла — `-`. */
function fileMark(p: string): string {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** Файлы настроек слоёв не те, с которыми собран кэш (кэш без меток — старый, тоже пересобрать). */
export function staleSettings(cache: CompletionCache): boolean {
  if (!cache.files) return true
  return Object.entries(cache.files).some(([f, mark]) => fileMark(f) !== mark)
}

/** Вход: `kd __complete <слова…>`; печать строк, код 0 всегда. */
export async function runComplete(argv: string[]): Promise<void> {
  let shell = 'raw'
  if (argv[0]?.startsWith('--shell=')) shell = argv.shift()!.slice(8)
  let cache: CompletionCache | null = null
  const cacheDir = join(dataDir(), 'cache')
  try {
    cache = JSON.parse(readFileSync(join(cacheDir, 'catalog.json'), 'utf8')) as CompletionCache
  } catch {
    cache = null
  }
  // Настройки слоёв поменялись (`settings.mdz`, файл `$layers`) — кэш пересобирается полным входом до ответа:
  // один раз после правки, дальше снова из кэша.
  if (cache && staleSettings(cache) && !process.env.KD_COMPLETE_NO_REFRESH) {
    try {
      spawnSync(process.execPath, [fileURLToPath(new URL('../bin/kd.mjs', import.meta.url))], { stdio: 'ignore', timeout: 10_000 })
      cache = JSON.parse(readFileSync(join(cacheDir, 'catalog.json'), 'utf8')) as CompletionCache
    } catch {
      // не вышло — отвечаем из того, что есть
    }
  }
  // Обновление в стороне: тот же вход с `--refresh=<вид>`, ответ сети ждётся дольше, пишется в кэш.
  if (shell.startsWith('refresh=')) {
    if (cache?.values) await netValues(cache.values, shell.slice(8), cacheDir, process.env, { force: true, budget: 15_000 })
    return
  }
  const refresh = (kind: string): void => {
    if (process.env.KD_COMPLETE_NO_REFRESH) return
    try {
      spawn(process.execPath, [fileURLToPath(new URL('../bin/kd.mjs', import.meta.url)), '__complete', `--shell=refresh=${kind}`], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // не вышло — подсказка в следующий раз
    }
  }
  let out = await completeAll(argv, cache, process.cwd(), cacheDir, process.env, { refresh })
  if (shell === 'zsh') out = out.map((l) => {
    const [v, d] = l.split('\t')
    return `${v!.replace(/[\\:]/g, '\\$&')}${d ? `:${d}` : ''}`
  })
  else if (shell === 'bash') out = out.map((l) => l.split('\t')[0]!)
  if (out.length) process.stdout.write(out.join('\n') + '\n')
}
