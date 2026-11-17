/**
 * Поиск по пространству (`workspace.files.search`, протокол v1.28).
 *
 * Два пути с одним ответом: ripgrep, если он есть в PATH (быстро, параллельно),
 * иначе обход каталогов на node. Правила запроса (подстрока/regex, регистр,
 * glob, лимит) — `compileFileSearch` протокола: rg только находит кандидатов,
 * каждую строку перепроверяет тот же матчер, так что regex — JS-диалект, а
 * игнор — правила пространства (`.git`, `node_modules`, `.gitignore`, корзина).
 */

import { spawn, spawnSync } from 'node:child_process'
import { open, readdir, lstat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { FileSearchHit, FileSearchMatcher, FileSearchQuery } from '@kerneldreams/ui-protocol'
import { WORKSPACE_TRASH_DIR } from '@kerneldreams/ui-protocol'

/** Файл больше — не ищется (минифицированные бандлы, дампы). */
export const SEARCH_MAX_FILE_BYTES = 2_000_000
/** Дольше — отдать найденное (rg убивается). */
const SEARCH_TIMEOUT_MS = 15_000

export interface SearchEnv {
  /** Настоящий путь корня. */
  root: string
  /** Игнор пространства (`FileEntry.ignored`). */
  ignored(path: string, isDir: boolean): boolean
  /** Вложенная репа, спрятанная `.gitignore` родителя: rg ищет в ней явным путём. */
  hiddenRepo?(dir: string): boolean
  /** Метка временных файлов атомарной записи — не ищутся. */
  tmpMark: string
  /** `rg`: путь, `false` — не звать (тест node-обхода), нет — искать в PATH. */
  rg?: string | false
}

export async function searchWorkspace(env: SearchEnv, q: FileSearchQuery, m: FileSearchMatcher): Promise<FileSearchHit[]> {
  const rg = env.rg === false ? undefined : (env.rg ?? findRg())
  let hits: FileSearchHit[] | undefined
  if (rg) hits = await searchRg(rg, env, q, m).catch(() => undefined)
  hits ??= await searchNode(env, m)
  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
  return hits.slice(0, m.limit)
}

/**
 * Куда ставят rg, кроме PATH: сервис под launchd/systemd живёт с урезанным
 * PATH и без них молча ушёл бы в обход на node (в разы медленнее).
 */
const RG_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin']

let rgCache: string | null | undefined
/** `rg` из PATH либо стандартных мест (кэш на процесс); нет — `undefined`. */
export function findRg(): string | undefined {
  if (rgCache !== undefined) return rgCache ?? undefined
  rgCache = null
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...RG_FALLBACK_DIRS]) {
    if (!dir) continue
    const bin = join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg')
    if (existsSync(bin) && spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) {
      rgCache = bin
      break
    }
  }
  return rgCache ?? undefined
}

/** Глубже не ищем спрятанные репы: зонтичные папки держат их на 1–2 уровнях. */
const HIDDEN_REPO_DEPTH = 3

/**
 * Вложенные репы, которые прячет `.gitignore` родителя (зонтик nrlib с
 * пакетами-репами): обход каталогов по правилам пространства до
 * {@link HIDDEN_REPO_DEPTH}. rg их пропустил бы — получают явным путём.
 */
async function hiddenRepos(env: SearchEnv): Promise<string[]> {
  if (!env.hiddenRepo) return []
  const out: string[] = []
  let level = ['']
  for (let depth = 1; depth <= HIDDEN_REPO_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries
      try {
        entries = await readdir(dir === '' ? env.root : join(env.root, ...dir.split('/')), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const path = dir === '' ? e.name : `${dir}/${e.name}`
        if (env.ignored(path, true)) continue
        if (env.hiddenRepo(path)) out.push(path)
        next.push(path)
      }
    }
    level = next
  }
  return out
}

async function searchRg(rg: string, env: SearchEnv, q: FileSearchQuery, m: FileSearchMatcher): Promise<FileSearchHit[]> {
  const roots = ['.', ...(await hiddenRepos(env))]
  const hits = await runRg(rg, roots, env, q, m)
  if (roots.length === 1) return hits
  const seen = new Set<string>()
  return hits.filter((h) => {
    const key = `${h.path}:${h.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * ripgrep `--json`: кандидаты строк; путь и строка перепроверяются правилами
 * пространства. Код 2 (битый regex для rust-диалекта и т.п.) — reject, тогда
 * ищет node-обход.
 */
function runRg(rg: string, roots: string[], env: SearchEnv, q: FileSearchQuery, m: FileSearchMatcher): Promise<FileSearchHit[]> {
  const args = ['--json', '--hidden', '--no-require-git', '--no-ignore-global', '--max-filesize', String(SEARCH_MAX_FILE_BYTES)]
  for (const g of ['!.git', '!node_modules', `!/${WORKSPACE_TRASH_DIR}`, `!*${env.tmpMark}*`]) args.push('--glob', g)
  if (!q.case) args.push('--ignore-case')
  if (!q.regex) args.push('--fixed-strings')
  args.push('--regexp', q.query, '--', ...roots)
  return new Promise((resolve, reject) => {
    const hits: FileSearchHit[] = []
    const child = spawn(rg, args, { cwd: env.root, stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      resolve(hits)
    }
    const timer = setTimeout(finish, SEARCH_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (done) return
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const hit = rgHit(line, env, m)
        // Запас над лимитом: порядок rg параллельный, сортируем потом.
        if (hit) hits.push(hit)
        if (hits.length >= m.limit * 2) return finish()
      }
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (done) return
      if (code === 2 && hits.length === 0) {
        done = true
        clearTimeout(timer)
        reject(new Error('rg: exit 2'))
        return
      }
      finish()
    })
  })
}

function rgHit(json: string, env: SearchEnv, m: FileSearchMatcher): FileSearchHit | undefined {
  let ev: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
  try {
    ev = JSON.parse(json) as typeof ev
  } catch {
    return undefined
  }
  if (ev.type !== 'match') return undefined
  const raw = ev.data?.path?.text
  const text = ev.data?.lines?.text
  const lineNo = ev.data?.line_number
  if (raw === undefined || text === undefined || lineNo === undefined) return undefined
  const path = raw.replace(/^\.\//, '').split('\\').join('/')
  if (!m.accepts(path) || env.ignored(path, false)) return undefined
  const line = text.replace(/\r?\n$/, '')
  const at = m.match(line)
  return at < 0 ? undefined : m.hit(path, lineNo, line, at)
}

/** Обход на node: каталоги по правилам игнора, симлинки не раскрываются, бинарное мимо. */
async function searchNode(env: SearchEnv, m: FileSearchMatcher): Promise<FileSearchHit[]> {
  const hits: FileSearchHit[] = []
  const started = Date.now()
  const queue: string[] = ['']
  while (queue.length > 0 && hits.length < m.limit && Date.now() - started < SEARCH_TIMEOUT_MS) {
    const dir = queue.shift()!
    let names: string[]
    try {
      names = (await readdir(dir === '' ? env.root : join(env.root, ...dir.split('/')))).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (name.includes(env.tmpMark)) continue
      const path = dir === '' ? name : `${dir}/${name}`
      const abs = join(env.root, ...path.split('/'))
      let st
      try {
        st = await lstat(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!env.ignored(path, true)) queue.push(path)
        continue
      }
      if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES || !m.accepts(path) || env.ignored(path, false)) continue
      const text = await readText(abs)
      if (text === undefined) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && hits.length < m.limit; i++) {
        const at = m.match(lines[i]!)
        if (at >= 0) hits.push(m.hit(path, i + 1, lines[i]!, at))
      }
      if (hits.length >= m.limit) break
    }
  }
  return hits
}

/** Текст файла; NUL в начале — бинарный, `undefined`. */
async function readText(abs: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(abs, 'r')
    const data = await handle.readFile()
    const head = data.subarray(0, 8192)
    if (head.includes(0)) return undefined
    return new TextDecoder('utf-8').decode(data)
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
