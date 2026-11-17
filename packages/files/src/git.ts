/**
 * Git панели (этап 3, nr-far.dev/specs/git-spec.md §2): разбор вывода git и сводка по папкам — чистые
 * функции, без процессов. Команды гоняет сервис плагина на хосте панели (`exec` хоста), сюда приходит текст.
 *
 *   status  — `git status --porcelain=v2 -z --branch`
 *   log     — `git log -z --format=` {@link LOG_FORMAT}
 *   blame   — `git blame --porcelain`
 *   файлы   — `git diff --name-status -z` (коммит, «ветка против master», stash)
 *   ветки   — `git for-each-ref --format=` {@link BRANCH_FORMAT}
 *   stash   — `git stash list --format=` {@link STASH_FORMAT}
 */

import type { Decoration, DecorationProvider, DecorationTone } from './collection/index.js'

/** Буква статуса в колонке `git`: изменён, новый, удалён, переименован, не под git, игнор, конфликт. */
export type GitCode = 'M' | 'A' | 'D' | 'R' | '?' | '!' | 'U'

export interface GitFile {
  /** Путь от корня репы (`/`-разделители); каталог не под git — с `/` на конце. */
  path: string
  /** Прежний путь (переименование). */
  orig?: string
  code: GitCode
  /** Изменение в индексе (X) и в рабочей копии (Y) porcelain: `.` — нет. */
  index: string
  work: string
}

export interface GitBranchInfo {
  /** Имя ветки; `null` — HEAD отцеплен. */
  head: string | null
  oid: string | null
  upstream?: string
  ahead: number
  behind: number
}

export interface GitStatus {
  branch: GitBranchInfo
  files: GitFile[]
}

const TONE: Record<GitCode, DecorationTone> = { M: 'modified', A: 'added', D: 'deleted', R: 'modified', '?': 'untracked', '!': 'ignored', U: 'conflict' }
const TITLE: Record<GitCode, string> = { M: 'изменён', A: 'новый', D: 'удалён', R: 'переименован', '?': 'не под git', '!': 'игнорируется', U: 'конфликт' }
/** «Худший» статус — больше. */
const RANK: Record<GitCode, number> = { U: 7, D: 6, M: 5, R: 4, A: 3, '?': 2, '!': 1 }

export const gitTone = (c: GitCode): DecorationTone => TONE[c]
export const gitTitle = (c: GitCode): string => TITLE[c]
export const gitWorse = (a: GitCode | undefined, b: GitCode): GitCode => (a && RANK[a] >= RANK[b] ? a : b)

/** Буква по паре XY porcelain (без конфликта). */
export function codeOfXY(x: string, y: string): GitCode {
  const both = `${x}${y}`
  if (both.includes('D')) return 'D'
  if (x === 'R' || x === 'C') return 'R'
  if (x === 'A') return 'A'
  return 'M'
}

/** Разбор `git status --porcelain=v2 -z --branch` (и `--ignored`). */
export function parseStatus(out: string): GitStatus {
  const branch: GitBranchInfo = { head: null, oid: null, ahead: 0, behind: 0 }
  const files: GitFile[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!
    if (line === '') continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      const v = rest.join(' ')
      if (key === 'branch.oid') branch.oid = v === '(initial)' ? null : v
      else if (key === 'branch.head') branch.head = v === '(detached)' ? null : v
      else if (key === 'branch.upstream') branch.upstream = v
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(v)
        if (m) {
          branch.ahead = Number(m[1])
          branch.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '?' || kind === '!') {
      files.push({ path: line.slice(2), code: kind, index: kind, work: kind })
    } else if (kind === '1') {
      const f = line.split(' ')
      const xy = f[1] ?? '..'
      files.push({ path: f.slice(8).join(' '), code: codeOfXY(xy[0]!, xy[1]!), index: xy[0]!, work: xy[1]! })
    } else if (kind === '2') {
      const f = line.split(' ')
      const xy = f[1] ?? '..'
      const orig = parts[++i] ?? ''
      files.push({ path: f.slice(9).join(' '), orig, code: codeOfXY(xy[0]!, xy[1]!), index: xy[0]!, work: xy[1]! })
    } else if (kind === 'u') {
      const f = line.split(' ')
      const xy = f[1] ?? 'UU'
      files.push({ path: f.slice(10).join(' '), code: 'U', index: xy[0]!, work: xy[1]! })
    }
  }
  return { branch, files }
}

/** Путь каталога от корня репы: `''` — корень; вне репы — `null`. */
export function repoRel(root: string, abs: string): string | null {
  const r = root.replace(/\/+$/, '')
  if (abs === r || abs === `${r}/`) return ''
  if (r === '') return abs.replace(/^\/+/, '')
  return abs.startsWith(`${r}/`) ? abs.slice(r.length + 1).replace(/\/+$/, '') : null
}

/**
 * Пометки записей каталога `dir` (абсолютный) по статусу репы `root`: файл — свой статус, папка — худший
 * статус внутри (игнор внутри папку не метит), каталог целиком не под git / в игноре — всё в нём.
 * `names` — имена записей каталога; `ignored` — те из них, что `check-ignore` назвал игнорируемыми.
 * Имя → буква; без пометки — имени нет.
 */
export function gitCodes(root: string, dir: string, files: readonly GitFile[], names: readonly string[], ignored: Iterable<string> = []): Map<string, GitCode> {
  const out = new Map<string, GitCode>()
  const rel = repoRel(root, dir)
  if (rel === null) return out
  const base = rel === '' ? '' : `${rel}/`
  // Каталог выше целиком не под git / в игноре: `tmp/` накрывает `tmp/a/b`.
  let whole: GitCode | undefined
  for (const f of files) {
    if (base !== '' && !f.path.startsWith(base)) {
      if (f.path.endsWith('/') && base.startsWith(f.path)) whole = gitWorse(whole, f.code)
      continue
    }
    const rest = f.path.slice(base.length)
    const slash = rest.indexOf('/')
    const name = slash < 0 ? rest : rest.slice(0, slash)
    if (name === '') continue
    const exact = slash < 0 || slash === rest.length - 1
    if (exact || f.code !== '!') out.set(name, gitWorse(out.get(name), f.code))
  }
  for (const n of ignored) if (!out.has(n)) out.set(n, '!')
  if (whole) for (const n of names) out.set(n, gitWorse(out.get(n), whole))
  return out
}

/**
 * Буква по абсолютному пути (дерево: записи из разных каталогов): файл — свой статус, папка — худший внутри
 * (без игнора), всё под каталогом не под git / в игноре — его буква. Вне репы — `undefined`.
 */
export function gitLookup(root: string, files: readonly GitFile[]): (abs: string) => GitCode | undefined {
  const r = root.replace(/\/+$/, '')
  const exact = new Map<string, GitCode>()
  const inside = new Map<string, GitCode>()
  const covers: Array<{ prefix: string; code: GitCode }> = []
  for (const f of files) {
    const full = `${r}/${f.path.replace(/\/+$/, '')}`
    exact.set(full, gitWorse(exact.get(full), f.code))
    if (f.path.endsWith('/')) covers.push({ prefix: `${full}/`, code: f.code })
    if (f.code === '!') continue
    for (let d = full.slice(0, full.lastIndexOf('/')); d.length > r.length; d = d.slice(0, d.lastIndexOf('/'))) inside.set(d, gitWorse(inside.get(d), f.code))
  }
  return (abs) => {
    if (abs !== r && !abs.startsWith(`${r}/`)) return undefined
    let c = exact.get(abs)
    const i = inside.get(abs)
    if (i) c = gitWorse(c, i)
    for (const cv of covers) if (abs.startsWith(cv.prefix)) c = gitWorse(c, cv.code)
    return c
  }
}

/** Пометка по букве (колонка `git`, значок в списке/дереве/эскизах). */
export function gitDecoration(code: GitCode, dir = false): Decoration {
  return { source: 'git', badge: code, tone: TONE[code], title: dir && code !== '!' && code !== '?' ? `внутри: ${TITLE[code]}` : TITLE[code] }
}

/** Что умеет вызывающий: статус репы каталога и игнор видимых имён. */
export interface GitStatusSource {
  /** Статус репы, где лежит каталог; не репа / не вышло — `null`. */
  status(dir: string, host?: string): Promise<{ root: string; files: readonly GitFile[] } | null>
  /** Какие из имён каталога игнорируются (`check-ignore`). */
  ignored?(dir: string, names: readonly string[], host?: string): Promise<readonly string[]>
}

/** Поставщик пометок `git` ({@link DecorationProvider}): путь записи → буква. */
export function gitDecorationProvider(src: GitStatusSource): DecorationProvider {
  return {
    id: 'git',
    async decorate(dir, paths, host) {
      const out = new Map<string, Decoration[]>()
      const st = await src.status(dir, host)
      if (!st) return out
      const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1))
      const ign = src.ignored ? await src.ignored(dir, names, host).catch(() => []) : []
      const codes = gitCodes(st.root, dir, st.files, names, ign)
      for (const p of paths) {
        const c = codes.get(p.slice(p.lastIndexOf('/') + 1))
        if (c) out.set(p, [gitDecoration(c)])
      }
      return out
    },
  }
}

// ── log ────────────────────────────────────────────────────────────────────

/** Поля коммита через `\x1f`, коммиты — через `\x1e` (без `-z`: сообщение — одна строка `%s`). */
export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1f%s%x1e'

export interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  /** Секунды эпохи. */
  time: number
  /** Ветки и теги (`%D`): `HEAD -> master`, `origin/master`, `tag: v1`. */
  refs: string[]
  parents: string[]
  subject: string
}

export function parseLog(out: string): GitCommit[] {
  const list: GitCommit[] = []
  for (const raw of out.split('\x1e')) {
    const rec = raw.replace(/^\s+/, '')
    if (rec === '') continue
    const [hash = '', short = '', author = '', email = '', time = '0', refs = '', parents = '', ...subject] = rec.split('\x1f')
    list.push({
      hash,
      short,
      author,
      email,
      time: Number(time),
      refs: refs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      parents: parents.split(' ').filter(Boolean),
      subject: subject.join('\x1f').replace(/\s+$/, ''),
    })
  }
  return list
}

// ── blame ──────────────────────────────────────────────────────────────────

export interface GitBlameLine {
  /** Номер строки файла с 1. */
  line: number
  hash: string
  author: string
  time: number
  summary: string
  text: string
}

/** Разбор `git blame --porcelain`: сведения о коммите приходят при первом его появлении. */
export function parseBlame(out: string): GitBlameLine[] {
  const info = new Map<string, { author: string; time: number; summary: string }>()
  const lines: GitBlameLine[] = []
  const rows = out.split('\n')
  let cur: { hash: string; line: number } | null = null
  let meta: { author: string; time: number; summary: string } = { author: '', time: 0, summary: '' }
  for (const row of rows) {
    if (row.startsWith('\t')) {
      if (!cur) continue
      if (!info.has(cur.hash)) info.set(cur.hash, meta)
      const m = info.get(cur.hash)!
      lines.push({ line: cur.line, hash: cur.hash, author: m.author, time: m.time, summary: m.summary, text: row.slice(1) })
      cur = null
      continue
    }
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row)
    if (head) {
      cur = { hash: head[1]!, line: Number(head[2]) }
      meta = info.get(cur.hash) ?? { author: '', time: 0, summary: '' }
      continue
    }
    if (!cur) continue
    if (row.startsWith('author ')) meta = { ...meta, author: row.slice(7) }
    else if (row.startsWith('author-time ')) meta = { ...meta, time: Number(row.slice(12)) }
    else if (row.startsWith('summary ')) meta = { ...meta, summary: row.slice(8) }
  }
  return lines
}

// ── файлы изменений ────────────────────────────────────────────────────────

export interface GitChange {
  /** `M`, `A`, `D`, `R`, `C`, `T`, `U`. */
  status: string
  path: string
  /** Прежний путь у `R`/`C`. */
  orig?: string
  /** Новый файл stash'а (`stash push -u`): лежит в третьем родителе `stash@{n}^3`. */
  untracked?: boolean
}

/** Разбор `git diff --name-status -z` (и `git show --name-status -z --format=`). */
export function parseNameStatus(out: string): GitChange[] {
  const parts = out.split('\0')
  const list: GitChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!.replace(/^\n+/, '')
    if (s === '') continue
    const status = s[0]!
    if (!/^[ACDMRTUX]/.test(status)) continue
    if (status === 'R' || status === 'C') {
      const orig = parts[++i] ?? ''
      const path = parts[++i] ?? ''
      list.push({ status, path, orig })
    } else list.push({ status, path: parts[++i] ?? '' })
  }
  return list
}

// ── ветки ──────────────────────────────────────────────────────────────────

export const BRANCH_FORMAT = '%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(subject)'

export interface GitBranch {
  name: string
  remote: boolean
  current: boolean
  hash: string
  upstream?: string
  ahead: number
  behind: number
  /** Ветка ушла у remote (`[gone]`). */
  gone?: boolean
  time: number
  subject: string
}

/** Разбор `git for-each-ref refs/heads refs/remotes --format=` {@link BRANCH_FORMAT}; текущая — первой. */
export function parseBranches(out: string): GitBranch[] {
  const list: GitBranch[] = []
  for (const row of out.split('\n')) {
    if (row.trim() === '') continue
    const [head = '', ref = '', short = '', hash = '', upstream = '', track = '', time = '0', ...subject] = row.split('\x1f')
    if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) continue
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    list.push({
      name: short,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      hash,
      ...(upstream ? { upstream } : {}),
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      ...(track.includes('gone') ? { gone: true } : {}),
      time: Number(time),
      subject: subject.join('\x1f'),
    })
  }
  return list.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name))
}

// ── stash ──────────────────────────────────────────────────────────────────

export const STASH_FORMAT = '%gd%x1f%ct%x1f%s'

export interface GitStash {
  /** `stash@{0}`. */
  ref: string
  time: number
  message: string
}

export function parseStashList(out: string): GitStash[] {
  return out
    .split('\n')
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [ref = '', time = '0', ...msg] = r.split('\x1f')
      return { ref, time: Number(time), message: msg.join('\x1f') }
    })
}

// ── ошибки ─────────────────────────────────────────────────────────────────

export type GitErrorKind = 'access' | 'non-ff' | 'conflict' | 'dirty' | 'not-repo' | 'no-upstream' | 'other'

/**
 * Что сказал git (stderr/stdout): нет доступа к remote (пароль не спрашиваем — `GIT_TERMINAL_PROMPT=0`),
 * отказ non-fast-forward, конфликт, грязная копия мешает, не репа. Текст — для строки панели.
 */
export function classifyGitError(text: string, remote = 'origin'): { kind: GitErrorKind; text: string } {
  const t = text.trim()
  const last = t.split('\n').filter((l) => l.trim() !== '').slice(-3).join(' · ')
  if (/terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|could not read from remote repository|returned error: 40[13]/i.test(t)) {
    return { kind: 'access', text: `нужен доступ к ${remote}` }
  }
  if (/\[rejected\].*(non-fast-forward|fetch first)|Updates were rejected because/i.test(t)) return { kind: 'non-ff', text: 'удалённая ветка ушла вперёд — сначала pull' }
  if (/CONFLICT|could not apply|Merge conflict|needs merge|unmerged files/i.test(t)) return { kind: 'conflict', text: 'конфликт — пометка U у файлов' }
  if (/Your local changes to the following files would be overwritten|Please commit your changes or stash them/i.test(t)) return { kind: 'dirty', text: 'локальные правки мешают' }
  if (/has no upstream branch|no upstream configured/i.test(t)) return { kind: 'no-upstream', text: 'у ветки нет upstream' }
  if (/not a git repository/i.test(t)) return { kind: 'not-repo', text: 'не репа git' }
  return { kind: 'other', text: last || 'git: ошибка' }
}
