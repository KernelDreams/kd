/**
 * `apply_patch` (tools-spec §2): unified diff (как `git diff`), несколько
 * файлов, создание (`--- /dev/null`, `new file mode`), удаление
 * (`+++ /dev/null`, `deleted file mode`), переименование (`rename from/to`).
 * Всё или ничего: сначала все файлы считаются в памяти, потом пишутся.
 *
 * Поиск ханка — образец OpenClaw `src/agents/apply-patch-update.ts` (MIT,
 * OpenClaw Foundation; формат там — Codex `*** Begin Patch`, у нас — unified):
 * старые строки ханка ищутся от курсора всё более терпимо (как есть → без
 * хвостовых пробелов → trim → trim + типографская пунктуация); первый уровень,
 * где что-то нашлось, решает. В отличие от донора, несколько совпадений — не
 * ошибка: берётся ближайшее к номеру строки из `@@`. Строки контекста, которые
 * совпали нестрого, остаются в файле байт в байт (правится только то, что
 * патч меняет). Концы строк файла (CRLF) сохраняются.
 *
 * Терпимость к выводу моделей: текст вокруг патча и ```-ограды пропускаются;
 * счётчики в `@@` не обязательны (ханк — до следующего заголовка); пустая
 * строка внутри ханка — пустая строка контекста; хвостовые пустые строки
 * контекста в конце ханка отбрасываются.
 */

import type { ToolDef, ToolPreview } from '../types.js'
import { prepareFileDiff } from './file-diff.js'
import { displayPath, resolveIn, type FsRoot } from './paths.js'
import { withFileLock } from './write.js'

// ────────────────────────────────────────────────────────────────────────────
// Разбор
// ────────────────────────────────────────────────────────────────────────────

export interface PatchHunk {
  oldStart: number
  lines: string[] // с префиксом ' ' | '-' | '+'
  /** `\ No newline at end of file` после последней строки новой стороны. */
  noNewlineNew: boolean
}

export interface FilePatch {
  oldPath: string | null // null — новый файл
  newPath: string | null // null — удаление
  hunks: PatchHunk[]
}

function stripPrefix(p: string): string {
  const t = p.trim().replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1')
  return /^[ab]\//.test(t) ? t.slice(2) : t
}

function headerPath(line: string, marker: '--- ' | '+++ '): string | null {
  const p = line.slice(marker.length).trim().replace(/\t.*$/, '')
  return p === '/dev/null' ? null : stripPrefix(p)
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const files: FilePatch[] = []
  let cur: FilePatch | undefined
  let hunk: PatchHunk | undefined
  let pendingGit: { oldPath: string | null; newPath: string | null; renameFrom?: string; renameTo?: string; isNew?: boolean; isDeleted?: boolean } | undefined

  const closeHunk = (): void => {
    if (!hunk || !cur) return
    while (hunk.lines.length && hunk.lines[hunk.lines.length - 1] === ' ') hunk.lines.pop()
    cur.hunks.push(hunk)
    hunk = undefined
  }
  const flushGit = (): void => {
    // `diff --git` без ---/+++ (чистое переименование, пустой новый файл, удаление)
    if (!pendingGit) return
    const g = pendingGit
    pendingGit = undefined
    const oldPath = g.isNew ? null : (g.renameFrom ?? g.oldPath)
    const newPath = g.isDeleted ? null : (g.renameTo ?? g.newPath)
    cur = { oldPath, newPath, hunks: [] }
    files.push(cur)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('diff --git ')) {
      closeHunk()
      flushGit()
      cur = undefined
      const m = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(line)
      pendingGit = { oldPath: m ? m[1]! : null, newPath: m ? m[2]! : null }
      continue
    }
    if (pendingGit && !hunk) {
      if (line.startsWith('new file mode')) { pendingGit.isNew = true; continue }
      if (line.startsWith('deleted file mode')) { pendingGit.isDeleted = true; continue }
      if (line.startsWith('rename from ')) { pendingGit.renameFrom = line.slice(12).trim(); continue }
      if (line.startsWith('rename to ')) { pendingGit.renameTo = line.slice(10).trim(); continue }
      if (/^(similarity index|dissimilarity index|index |old mode|new mode|copy from|copy to|Binary files)/.test(line)) continue
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeHunk()
      const g = pendingGit
      pendingGit = undefined
      let oldPath = headerPath(line, '--- ')
      let newPath = headerPath(lines[i + 1]!, '+++ ')
      if (g?.isNew) oldPath = null
      if (g?.isDeleted) newPath = null
      if (g?.renameFrom && oldPath !== null) oldPath = g.renameFrom
      if (g?.renameTo && newPath !== null) newPath = g.renameTo
      cur = { oldPath, newPath, hunks: [] }
      files.push(cur)
      i++
      continue
    }
    const hm = HUNK_RE.exec(line)
    if (hm) {
      closeHunk()
      flushGit()
      if (!cur) throw new Error(`hunk without file header at line ${i + 1}`)
      hunk = { oldStart: Number(hm[1]), lines: [], noNewlineNew: false }
      continue
    }
    if (hunk) {
      if (line.startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1]
        if (last && last[0] !== '-') hunk.noNewlineNew = true
        continue
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        if (line.startsWith('```')) { closeHunk(); continue }
        hunk.lines.push(line === '' ? ' ' : line)
        continue
      }
      closeHunk() // текст после патча
    }
  }
  closeHunk()
  flushGit()
  if (files.length === 0) throw new Error('no file sections found: expected a unified diff with ---/+++ headers (or diff --git)')
  return files
}

// ────────────────────────────────────────────────────────────────────────────
// Применение к тексту
// ────────────────────────────────────────────────────────────────────────────

type Ending = '\r\n' | '\n' | ''
interface SrcLine { text: string; ending: Ending }

function splitSource(content: string): { lines: SrcLine[]; preferred: '\r\n' | '\n'; bom: string } {
  const bom = content.startsWith('﻿') ? '﻿' : ''
  const text = content.slice(bom.length)
  const raw = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  const lines = raw.map((l): SrcLine => (l.endsWith('\r\n') ? { text: l.slice(0, -2), ending: '\r\n' } : l.endsWith('\n') ? { text: l.slice(0, -1), ending: '\n' } : { text: l, ending: '' }))
  const preferred = lines.find((l) => l.ending)?.ending === '\r\n' ? '\r\n' : '\n'
  return { lines, preferred, bom }
}

const PUNCT: Array<[RegExp, string]> = [
  [/[‐-―−]/g, '-'],
  [/[‘-‛]/g, "'"],
  [/[“-‟]/g, '"'],
  [/[  -   　]/g, ' '],
]
const TIERS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => PUNCT.reduce((acc, [re, to]) => acc.replace(re, to), s.trim()),
]

/** Индекс начала `pattern` в `lines` от `from`: первый уровень терпимости с совпадениями, ближайшее к `hint`. */
function seek(lines: string[], pattern: string[], from: number, hint: number): { index: number; tier: number } | undefined {
  if (pattern.length === 0) return { index: Math.max(from, Math.min(hint, lines.length)), tier: 0 }
  const max = lines.length - pattern.length
  for (let tier = 0; tier < TIERS.length; tier++) {
    const norm = TIERS[tier]!
    const pat = pattern.map(norm)
    let best: number | undefined
    for (let i = from; i <= max; i++) {
      let ok = true
      for (let k = 0; k < pat.length; k++) {
        if (norm(lines[i + k]!) !== pat[k]) {
          ok = false
          break
        }
      }
      if (ok && (best === undefined || Math.abs(i - hint) < Math.abs(best - hint))) best = i
    }
    if (best !== undefined) return { index: best, tier }
  }
  return undefined
}

export interface HunkReport { hunk: number; line: number; offset: number; fuzzy: boolean }

/** Ханки → новый текст файла. Ошибка — с текстом для модели. */
export function applyHunks(content: string, hunks: PatchHunk[], path: string): { content: string; reports: HunkReport[] } {
  const src = splitSource(content)
  const out: SrcLine[] = [...src.lines]
  const texts = out.map((l) => l.text)
  const reports: HunkReport[] = []
  let cursor = 0
  let delta = 0 // сдвиг из-за уже применённых ханков (в индексах out)
  let lastNoNewline: boolean | undefined
  hunks.forEach((h, n) => {
    const oldLines = h.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1))
    const hint = Math.max(0, h.oldStart - 1) + delta
    const found = seek(texts, oldLines, cursor, h.oldStart === 0 ? 0 : hint)
    if (!found) {
      throw new Error(
        `hunk ${n + 1} (@@ -${h.oldStart}) does not match ${path}: expected lines not found:\n${oldLines.slice(0, 12).join('\n')}${oldLines.length > 12 ? '\n…' : ''}\nRe-read the file and produce the patch against its current content.`,
      )
    }
    const at = found.index
    const replaced = out.slice(at, at + oldLines.length)
    const nearby = replaced.find((l) => l.ending)?.ending || out[at - 1]?.ending || src.preferred
    const next: SrcLine[] = []
    let k = 0 // индекс в replaced
    for (const l of h.lines) {
      const tag = l[0]
      const text = l.slice(1)
      if (tag === ' ') {
        next.push(replaced[k] ?? { text, ending: nearby }) // контекст — байт в байт из файла
        k++
      } else if (tag === '-') k++
      else next.push({ text, ending: nearby })
    }
    // Последняя строка замены наследует конец последней заменённой (EOF без \n).
    const lastOld = replaced[replaced.length - 1]
    const lastNew = next[next.length - 1]
    if (lastNew && lastOld && at + oldLines.length === out.length && h.lines[h.lines.length - 1]![0] !== ' ') lastNew.ending = lastOld.ending
    out.splice(at, oldLines.length, ...next)
    texts.splice(at, oldLines.length, ...next.map((l) => l.text))
    reports.push({ hunk: n + 1, line: at + 1, offset: at - (h.oldStart - 1 + delta), fuzzy: found.tier > 0 })
    cursor = at + next.length
    delta += next.length - oldLines.length
    if (at + next.length === out.length) lastNoNewline = h.noNewlineNew
  })
  // Внутренние строки без конца (вставка после последней строки без \n) — получают конец.
  for (let i = 0; i < out.length - 1; i++) if (!out[i]!.ending) out[i]!.ending = src.preferred
  const last = out[out.length - 1]
  if (last && lastNoNewline !== undefined) last.ending = lastNoNewline ? '' : last.ending || src.preferred
  return { content: src.bom + out.map((l) => l.text + l.ending).join(''), reports }
}

/** Содержимое нового файла из ханков (только `+`/контекст). */
function newFileContent(hunks: PatchHunk[]): string {
  const lines = hunks.flatMap((h) => h.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1)))
  const noNl = hunks[hunks.length - 1]?.noNewlineNew === true
  return lines.length ? lines.join('\n') + (noNl ? '' : '\n') : ''
}

// ────────────────────────────────────────────────────────────────────────────
// План по файлам
// ────────────────────────────────────────────────────────────────────────────

export type FileOp =
  | { op: 'add'; abs: string; rel: string; content: string }
  | { op: 'delete'; abs: string; rel: string; before: string }
  | { op: 'update'; abs: string; rel: string; before: string; content: string; reports: HunkReport[] }
  | { op: 'rename'; fromAbs: string; fromRel: string; abs: string; rel: string; before: string; content: string; reports: HunkReport[] }

export async function planPatch(root: FsRoot, patchText: string): Promise<FileOp[]> {
  const files = parseUnifiedDiff(patchText)
  const ops: FileOp[] = []
  const touched = new Set<string>()
  const claim = (abs: string, rel: string): void => {
    if (touched.has(abs)) throw new Error(`${rel} appears more than once in the patch; merge its sections`)
    touched.add(abs)
  }
  for (const f of files) {
    if (f.oldPath === null && f.newPath === null) throw new Error('file section with /dev/null on both sides')
    if (f.oldPath === null) {
      const abs = await resolveIn(root, f.newPath!)
      const rel = displayPath(root, abs)
      claim(abs, rel)
      if (await root.fs.exists(abs)) throw new Error(`cannot create ${rel}: file already exists (use a modification hunk against its content)`)
      ops.push({ op: 'add', abs, rel, content: newFileContent(f.hunks) })
      continue
    }
    const fromAbs = await resolveIn(root, f.oldPath)
    const fromRel = displayPath(root, fromAbs)
    const before = await root.fs.readText(fromAbs).catch(() => undefined)
    if (before === undefined) throw new Error(`file not found: ${fromRel}`)
    if (f.newPath === null) {
      claim(fromAbs, fromRel)
      ops.push({ op: 'delete', abs: fromAbs, rel: fromRel, before })
      continue
    }
    const { content, reports } = f.hunks.length ? applyHunks(before, f.hunks, fromRel) : { content: before, reports: [] }
    const abs = await resolveIn(root, f.newPath)
    const rel = displayPath(root, abs)
    if (abs !== fromAbs) {
      claim(fromAbs, fromRel)
      claim(abs, rel)
      if (await root.fs.exists(abs)) throw new Error(`cannot rename ${fromRel} to ${rel}: target exists`)
      ops.push({ op: 'rename', fromAbs, fromRel, abs, rel, before, content, reports })
    } else {
      claim(abs, rel)
      ops.push({ op: 'update', abs, rel, before, content, reports })
    }
  }
  return ops
}

function summaryOf(ops: FileOp[]): string {
  const lines: string[] = []
  for (const o of ops) {
    if (o.op === 'add') lines.push(`A ${o.rel}`)
    else if (o.op === 'delete') lines.push(`D ${o.rel}`)
    else if (o.op === 'rename') lines.push(`R ${o.fromRel} -> ${o.rel}`)
    else lines.push(`M ${o.rel}`)
    if (o.op === 'update' || o.op === 'rename') {
      for (const r of o.reports) if (r.offset !== 0 || r.fuzzy) lines.push(`  hunk ${r.hunk} applied at line ${r.line}${r.offset ? ` (offset ${r.offset > 0 ? '+' : ''}${r.offset})` : ''}${r.fuzzy ? ' (whitespace/punctuation-tolerant match)' : ''}`)
    }
  }
  return lines.join('\n')
}

/** Диф того, что реально будет записано (превью и `data` результата). */
function diffOf(ops: FileOp[]): string {
  const parts: string[] = []
  for (const o of ops) {
    if (o.op === 'add') parts.push(prepareFileDiff(o.rel, '', o.content)?.patch ?? `new file ${o.rel}`)
    else if (o.op === 'delete') parts.push(prepareFileDiff(o.rel, o.before, '')?.patch ?? `delete ${o.rel}`)
    else if (o.op === 'rename') parts.push(`rename ${o.fromRel} -> ${o.rel}\n` + (o.before !== o.content ? (prepareFileDiff(o.rel, o.before, o.content)?.patch ?? '') : ''))
    else parts.push(prepareFileDiff(o.rel, o.before, o.content)?.patch ?? '')
  }
  return parts.filter(Boolean).join('\n')
}

export function applyPatchTool(root: FsRoot): ToolDef {
  return {
    name: 'apply_patch',
    description:
      'Apply a unified diff (the format of `git diff` / `diff -u`) to files under the workspace. One patch may touch several files; ' +
      'create a file with `--- /dev/null`, delete with `+++ /dev/null`, rename with `diff --git` + `rename from`/`rename to`. ' +
      'Hunks are located by their context lines (line numbers are a hint). The whole patch is applied or nothing is.',
    schema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'The unified diff text, with ---/+++ file headers and @@ hunks.' },
      },
      required: ['patch'],
    },
    executor: 'backend',
    policy: 'ask',
    async preview(args): Promise<ToolPreview> {
      const ops = await planPatch(root, String(args.patch ?? ''))
      return { kind: 'diff', diff: diffOf(ops) }
    },
    async execute(args) {
      const ops = await planPatch(root, String(args.patch ?? ''))
      for (const o of ops) {
        await withFileLock(o.abs, async () => {
          if (o.op === 'delete') return root.fs.remove(o.abs)
          if (o.op === 'rename') {
            await root.fs.rename(o.fromAbs, o.abs)
            if (o.content !== o.before) await root.fs.writeText(o.abs, o.content)
          } else await root.fs.writeText(o.abs, o.content)
        })
      }
      return { text: `Patch applied:\n${summaryOf(ops)}`, data: { files: ops.map((o) => ({ op: o.op, path: o.rel })), diff: diffOf(ops) } }
    },
  }
}
