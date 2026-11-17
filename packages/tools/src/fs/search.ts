/**
 * `find` (glob) и `grep` (tools-spec §2) — порт pi `core/tools/find.ts`,
 * `grep.ts` (MIT, Mario Zechner): те же схемы, лимиты, формат вывода
 * (`путь:строка: текст`, контекст — `путь-строка- текст`) и подсказки.
 *
 * pi качает `fd`/`rg` сам (`ensureTool`); здесь — берёт хост (`ExecHost.which`/
 * `lines`, Node — из PATH), если есть, иначе свой обход каталога над
 * `host.fs`: без `node_modules`/`.git`, без разбора `.gitignore` (у fd/rg — с ним).
 */

import { basename, join, relative, sep, type Fs } from '@kerneldreams/chat-store/fs'
import type { ExecHost } from '../host.js'
import { utf8Text } from '../bytes.js'
import type { ToolDef } from '../types.js'
import { displayPath, resolveReadableIn, type FsRoot } from './paths.js'
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from './truncate.js'

const FIND_DEFAULT_LIMIT = 1000
const GREP_DEFAULT_LIMIT = 100
const SKIP_DIRS = new Set(['node_modules', '.git'])

export interface SearchOptions {
  /** Внешние `fd`/`rg` хоста (default — если хост их даёт). false — всегда свой обход (тесты). */
  external?: boolean
  /** Ускоритель хоста: `which` + `lines` (Node — PATH). */
  search?: Pick<ExecHost, 'which' | 'lines'>
}

/** Внешний бинарь и запуск построчно, если хост их даёт и они не выключены. */
function externalBin(opts: SearchOptions, bin: string): { bin: string; lines: NonNullable<ExecHost['lines']> } | undefined {
  if (opts.external === false || !opts.search?.which || !opts.search.lines) return undefined
  const path = opts.search.which(bin)
  return path ? { bin: path, lines: opts.search.lines } : undefined
}

// ────────────────────────────────────────────────────────────────────────────
// glob
// ────────────────────────────────────────────────────────────────────────────

/** Glob → RegExp: `**` — любые каталоги, `*`/`?` — внутри сегмента, `{a,b}`, `[…]`. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|') + ')'
        i = end
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else {
        let body = glob.slice(i + 1, end)
        if (body.startsWith('!')) body = '^' + body.slice(1)
        re += '[' + body.replace(/\\/g, '\\\\') + ']'
        i = end
      }
    } else re += /[.+^$()|\\]/.test(c) ? '\\' + c : c
  }
  return new RegExp('^' + re + '$')
}

/** Совпадение с семантикой fd в pi: без `/` — по имени файла, с `/` — по пути от корня поиска. */
export function globMatcher(pattern: string): (rel: string) => boolean {
  if (!pattern.includes('/')) {
    const re = globToRegExp(pattern)
    return (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1))
  }
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern.startsWith('**/') || pattern === '**' ? pattern : `**/${pattern}`
  const re = globToRegExp(p)
  return (rel) => re.test(rel)
}

/** Обход каталога (файлы), относительные пути через `/`. */
async function* walk(fs: Fs, dir: string, signal?: AbortSignal, prefix = ''): AsyncGenerator<string> {
  let entries
  try {
    entries = (await fs.readdir(dir)) ?? []
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (signal?.aborted) return
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.type === 'dir') {
      if (SKIP_DIRS.has(e.name)) continue
      yield* walk(fs, join(dir, e.name), signal, rel)
    } else yield rel
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function finish(lines: string[], notices: string[]): string {
  const t = truncateHead(lines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
  if (t.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
  return t.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '')
}

// ────────────────────────────────────────────────────────────────────────────
// find
// ────────────────────────────────────────────────────────────────────────────

export function findTool(root: FsRoot, opts: SearchOptions = {}): ToolDef {
  return {
    name: 'find',
    description:
      `Search for files by glob pattern. Returns matching file paths relative to the search directory. ` +
      `Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
        path: { type: 'string', description: 'Directory to search in (default: current directory)' },
        limit: { type: 'number', description: `Maximum number of results (default: ${FIND_DEFAULT_LIMIT})` },
      },
      required: ['pattern'],
    },
    executor: 'backend',
    policy: 'auto',
    async execute(args, ctx) {
      const pattern = String(args.pattern ?? '')
      const dir = await resolveReadableIn(root, String(args.path ?? '.') || '.')
      const limit = num(args.limit) ?? FIND_DEFAULT_LIMIT
      if ((await root.fs.stat(dir).catch(() => undefined))?.type !== 'dir') throw new Error(`Path not found: ${displayPath(root, dir)}`)
      const found: string[] = []
      const fd = externalBin(opts, 'fd')
      if (fd) {
        const fdArgs = ['--glob', '--color=never', '--hidden', '--no-require-git', '--exclude', '.git', '--exclude', 'node_modules', '--max-results', String(limit)]
        let p = pattern
        if (pattern.includes('/')) {
          fdArgs.push('--full-path')
          if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') p = `**/${pattern}`
        }
        fdArgs.push('--', p, dir)
        const res = await fd.lines(fd.bin, fdArgs, ctx.signal, (line) => {
          const l = line.replace(/\r$/, '').trim()
          if (l) found.push(relative(dir, l).split(sep).join('/') + (l.endsWith('/') ? '/' : ''))
        })
        if (res.code !== 0 && found.length === 0 && res.stderr.trim()) throw new Error(res.stderr.trim())
      } else {
        const match = globMatcher(pattern)
        for await (const rel of walk(root.fs, dir, ctx.signal)) {
          if (match(rel)) found.push(rel)
          if (found.length >= limit) break
        }
      }
      if (found.length === 0) return 'No files found matching pattern'
      const notices: string[] = []
      if (found.length >= limit) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`)
      return finish(found, notices)
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// grep
// ────────────────────────────────────────────────────────────────────────────

export function grepTool(root: FsRoot, opts: SearchOptions = {}): ToolDef {
  return {
    name: 'grep',
    description:
      `Search file contents for a pattern. Returns matching lines with file paths and line numbers. ` +
      `Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
        path: { type: 'string', description: 'Directory or file to search (default: current directory)' },
        glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
        context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
        limit: { type: 'number', description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` },
      },
      required: ['pattern'],
    },
    executor: 'backend',
    policy: 'auto',
    async execute(args, ctx) {
      const pattern = String(args.pattern ?? '')
      const target = await resolveReadableIn(root, String(args.path ?? '.') || '.')
      const glob = typeof args.glob === 'string' && args.glob ? args.glob : undefined
      const ignoreCase = args.ignoreCase === true
      const literal = args.literal === true
      const context = Math.max(0, num(args.context) ?? 0)
      const limit = Math.max(1, num(args.limit) ?? GREP_DEFAULT_LIMIT)
      const st = await root.fs.stat(target).catch(() => undefined)
      if (!st) throw new Error(`Path not found: ${displayPath(root, target)}`)
      const isDir = st.type === 'dir'
      const fmt = (file: string): string => {
        if (isDir) {
          const rel = relative(target, file)
          if (rel && !rel.startsWith('..')) return rel.split(sep).join('/')
        }
        return basename(file)
      }

      const matches: Array<{ file: string; line: number; text?: string }> = []
      let limited = false
      const rg = externalBin(opts, 'rg')
      if (rg) {
        const rgArgs = ['--json', '--line-number', '--color=never', '--hidden', '--glob', '!.git', '--glob', '!node_modules']
        if (ignoreCase) rgArgs.push('--ignore-case')
        if (literal) rgArgs.push('--fixed-strings')
        if (glob) rgArgs.push('--glob', glob)
        rgArgs.push('--', pattern, target)
        const res = await rg.lines(rg.bin, rgArgs, ctx.signal, (line, stop) => {
          if (matches.length >= limit || !line.trim()) return
          let ev: any
          try {
            ev = JSON.parse(line)
          } catch {
            return
          }
          if (ev.type !== 'match') return
          const file = ev.data?.path?.text
          const ln = ev.data?.line_number
          if (file && typeof ln === 'number') matches.push({ file, line: ln, text: ev.data?.lines?.text })
          if (matches.length >= limit) {
            limited = true
            stop()
          }
        })
        if (!res.stopped && res.code !== 0 && res.code !== 1) throw new Error(res.stderr.trim() || `ripgrep exited with code ${res.code}`)
      } else {
        let re: RegExp
        try {
          re = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'i' : '')
        } catch (err) {
          throw new Error(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`)
        }
        const keep = glob ? globMatcher(glob) : () => true
        const files: string[] = []
        if (isDir) {
          for await (const rel of walk(root.fs, target, ctx.signal)) if (keep(rel)) files.push(join(target, rel))
        } else files.push(target)
        outer: for (const file of files) {
          let text: string
          try {
            const buf = await root.fs.readBytes(file)
            if (!buf || buf.includes(0)) continue // нет или бинарный
            text = utf8Text(buf)
          } catch {
            continue
          }
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              matches.push({ file, line: i + 1, text: lines[i] })
              if (matches.length >= limit) {
                limited = true
                break outer
              }
            }
          }
        }
      }
      if (matches.length === 0) return 'No matches found'

      const cache = new Map<string, string[]>()
      const linesOf = async (file: string): Promise<string[]> => {
        let l = cache.get(file)
        if (!l) {
          try {
            l = ((await root.fs.readText(file)) ?? '').replace(/\r\n?/g, '\n').split('\n')
          } catch {
            l = []
          }
          cache.set(file, l)
        }
        return l
      }
      let linesTruncated = false
      const out: string[] = []
      for (const m of matches) {
        if (context === 0 && m.text !== undefined) {
          const { text, wasTruncated } = truncateLine(m.text.replace(/\r?\n$/, '').replace(/\r/g, ''))
          if (wasTruncated) linesTruncated = true
          out.push(`${fmt(m.file)}:${m.line}: ${text}`)
          continue
        }
        const lines = await linesOf(m.file)
        const from = Math.max(1, m.line - context)
        const to = Math.min(lines.length, m.line + context)
        for (let n = from; n <= to; n++) {
          const { text, wasTruncated } = truncateLine((lines[n - 1] ?? '').replace(/\r/g, ''))
          if (wasTruncated) linesTruncated = true
          out.push(n === m.line ? `${fmt(m.file)}:${n}: ${text}` : `${fmt(m.file)}-${n}- ${text}`)
        }
      }
      const notices: string[] = []
      if (limited) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`)
      if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
      return finish(out, notices)
    },
  }
}
