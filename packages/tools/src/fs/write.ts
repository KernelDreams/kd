/**
 * `write` и `edit` (tools-spec §2).
 *
 * `edit` — семантика pi (`edits[{oldText,newText}]`, каждый oldText — по
 * исходному файлу, уникален, правки не пересекаются), сопоставление и замена —
 * vendoring OpenClaw `edit-diff`/`edit-replacements` (мягкое совпадение NFKC /
 * кавычки / тире / пробелы, замена по позициям оригинала, концы строк файла
 * сохраняются). В результате — диф (модели — компактный, фронту — unified).
 *
 * Превью апрува считается тем же кодом, что и запись (dry-run): если план
 * негоден, ошибка уходит модели без карточки.
 *
 * Записи в один файл из параллельного батча тулов идут по очереди (образец —
 * pi `file-mutation-queue.ts`).
 */

import { utf8Length } from '../bytes.js'
import type { ToolDef, ToolPreview } from '../types.js'
import { prepareFileEdit, type Edit } from './edit-diff.js'
import { prepareFileWriteDiff } from './file-diff.js'
import { displayPath, resolveIn, type FsRoot } from './paths.js'

/**
 * Очередь мутаций по пути. Не состояние между запросами: живёт, пока идут
 * записи одного батча тулов, и пустеет сама.
 */
const queues = new Map<string, Promise<unknown>>()

/** Мутации одного файла — по очереди (параллельный батч тулов). */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.catch(() => {})
  queues.set(path, settled)
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path)
  })
  return next
}

// ────────────────────────────────────────────────────────────────────────────
// write
// ────────────────────────────────────────────────────────────────────────────

export function writeTool(root: FsRoot): ToolDef {
  const plan = async (args: Record<string, unknown>) => {
    const abs = await resolveIn(root, String(args.path ?? ''))
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
    const exists = await root.fs.exists(abs)
    const before = exists ? await root.fs.readText(abs).catch(() => undefined) : undefined
    return { abs, rel: displayPath(root, abs), content, exists, before }
  }
  return {
    name: 'write',
    description:
      'Write content to a file. Creates the file if it does not exist, overwrites if it does. Automatically creates parent directories. ' +
      'Use edit for targeted changes to existing files; write only for new files or complete rewrites.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write (relative or absolute)' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
    executor: 'backend',
    policy: 'ask',
    async preview(args): Promise<ToolPreview> {
      const p = await plan(args)
      const receipt = prepareFileWriteDiff({ path: p.rel, content: p.content, ...(p.exists ? { beforeText: p.before } : { created: true }) })
      if (receipt) return { kind: 'diff', diff: receipt.patch, path: p.rel }
      return { kind: 'text', text: `${p.exists ? 'Overwrite' : 'Create'} ${p.rel} (${utf8Length(p.content)} bytes)` }
    },
    async execute(args) {
      const p = await plan(args)
      await withFileLock(p.abs, () => root.fs.writeText(p.abs, p.content))
      const receipt = prepareFileWriteDiff({ path: p.rel, content: p.content, ...(p.exists ? { beforeText: p.before } : { created: true }) })
      return {
        text: `Successfully wrote ${utf8Length(p.content)} bytes to ${p.rel}`,
        data: { path: p.rel, created: !p.exists, ...(receipt ? { diff: receipt.patch } : {}) },
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// edit
// ────────────────────────────────────────────────────────────────────────────

/** `edits[]` или старая форма pi `oldText`/`newText` верхнего уровня. */
export function editsOf(args: Record<string, unknown>): Edit[] {
  const raw = Array.isArray(args.edits) ? args.edits : args.oldText !== undefined ? [{ oldText: args.oldText, newText: args.newText }] : []
  if (raw.length === 0) throw new Error('edits must contain at least one {oldText, newText} replacement')
  return raw.map((e, i) => {
    const o = (e ?? {}) as { oldText?: unknown; newText?: unknown }
    if (typeof o.oldText !== 'string') throw new Error(`edits[${i}].oldText must be a string`)
    return { oldText: o.oldText, newText: typeof o.newText === 'string' ? o.newText : String(o.newText ?? '') }
  })
}

export function editTool(root: FsRoot): ToolDef {
  const plan = async (args: Record<string, unknown>) => {
    const abs = await resolveIn(root, String(args.path ?? ''))
    const rel = displayPath(root, abs)
    const content = await root.fs.readText(abs).catch(() => undefined)
    if (content === undefined) throw new Error(`File not found: ${rel}`)
    return { abs, rel, result: prepareFileEdit(content, editsOf(args), rel) }
  }
  return {
    name: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. ' +
      'If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. ' +
      'Do not include large unchanged regions just to connect distant changes.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit (relative or absolute)' },
        edits: {
          type: 'array',
          description:
            'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.' },
              newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    executor: 'backend',
    policy: 'ask',
    async preview(args): Promise<ToolPreview> {
      const p = await plan(args)
      if (!p.result.changed) return { kind: 'text', text: p.result.message }
      return { kind: 'diff', diff: p.result.receipt.patch, path: p.rel }
    },
    async execute(args) {
      return withFileLock(await resolveIn(root, String(args.path ?? '')), async () => {
        const p = await plan(args)
        if (!p.result.changed) return { text: p.result.message, data: { path: p.rel, changed: false } }
        await root.fs.writeText(p.abs, p.result.content)
        const r = p.result
        return {
          text: `Successfully replaced ${r.editCount} block(s) in ${p.rel}.\n${r.receipt.diff}`,
          data: { path: p.rel, diff: r.receipt.patch, ...(r.receipt.firstChangedLine !== undefined ? { firstChangedLine: r.receipt.firstChangedLine } : {}) },
        }
      })
    },
  }
}

