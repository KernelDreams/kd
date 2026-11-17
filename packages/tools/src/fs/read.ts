/**
 * `read` и `ls` (tools-spec §2) — порт pi `core/tools/read.ts`, `ls.ts` (MIT,
 * Mario Zechner): те же лимиты, тексты подсказок и семантика offset/limit.
 * Отличия: пути — через границу `cwd` (paths.ts); картинки отдаются как есть,
 * без ресайза pi (`processImage`), с лимитом размера.
 */

import { toBase64, utf8Length, utf8Text } from '../bytes.js'
import type { ToolDef, ToolImage } from '../types.js'
import { displayPath, resolveReadableIn, resolveReadIn, type FsRoot } from './paths.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate.js'

/** Картинка больше — текстом отказ: провайдеры режут крупные image-блоки. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const LS_DEFAULT_LIMIT = 500

/** MIME картинки по сигнатуре (как pi `detectSupportedImageMimeTypeFromFile`). */
export function imageMimeOf(buf: Uint8Array): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function readTool(root: FsRoot): ToolDef {
  return {
    name: 'read',
    description:
      `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. ` +
      `For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
      `Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute)' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['path'],
    },
    executor: 'backend',
    policy: 'auto',
    async execute(args) {
      const path = String(args.path ?? '')
      const offset = num(args.offset)
      const limit = num(args.limit)
      const abs = await resolveReadIn(root, path)
      const st = await root.fs.stat(abs)
      if (st?.type === 'dir') throw new Error(`EISDIR: illegal operation on a directory, read`)
      const buf = await root.fs.readBytes(abs)
      if (!buf) throw new Error(`ENOENT: no such file or directory, open '${abs}'`)
      const mime = imageMimeOf(buf)
      if (mime) {
        if (buf.length > MAX_IMAGE_BYTES) {
          return { text: `Read image file [${mime}]: ${formatSize(buf.length)} exceeds the ${formatSize(MAX_IMAGE_BYTES)} image limit; not attached.`, isError: true }
        }
        const image: ToolImage = { mimeType: mime, data: toBase64(buf) }
        return { text: `Read image file [${mime}]: ${displayPath(root, abs)}`, images: [image], data: { path: displayPath(root, abs), mimeType: mime, bytes: buf.length } }
      }

      const all = utf8Text(buf).split('\n')
      const start = offset ? Math.max(0, offset - 1) : 0
      const startDisplay = start + 1
      if (start >= all.length) throw new Error(`Offset ${offset} is beyond end of file (${all.length} lines total)`)
      let selected: string
      let userLimited: number | undefined
      if (limit !== undefined) {
        const end = Math.min(start + limit, all.length)
        selected = all.slice(start, end).join('\n')
        userLimited = end - start
      } else {
        selected = all.slice(start).join('\n')
      }
      const t = truncateHead(selected)
      let text: string
      if (t.firstLineExceedsLimit) {
        const size = formatSize(utf8Length(all[start] ?? ''))
        text = `[Line ${startDisplay} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use exec: sed -n '${startDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
      } else if (t.truncated) {
        const endDisplay = startDisplay + t.outputLines - 1
        text =
          t.content +
          (t.truncatedBy === 'lines'
            ? `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${all.length}. Use offset=${endDisplay + 1} to continue.]`
            : `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${all.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${endDisplay + 1} to continue.]`)
      } else if (userLimited !== undefined && start + userLimited < all.length) {
        const remaining = all.length - (start + userLimited)
        text = `${t.content}\n\n[${remaining} more lines in file. Use offset=${start + userLimited + 1} to continue.]`
      } else {
        text = t.content
      }
      return { text, data: { path: displayPath(root, abs), lines: all.length } }
    },
  }
}

export function lsTool(root: FsRoot): ToolDef {
  return {
    name: 'ls',
    description:
      `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. ` +
      `Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (default: current directory)' },
        limit: { type: 'number', description: `Maximum number of entries to return (default: ${LS_DEFAULT_LIMIT})` },
      },
    },
    executor: 'backend',
    policy: 'auto',
    async execute(args) {
      const dir = await resolveReadableIn(root, String(args.path ?? '.') || '.')
      const limit = num(args.limit) ?? LS_DEFAULT_LIMIT
      const st = await root.fs.stat(dir).catch(() => undefined)
      if (!st) throw new Error(`Path not found: ${displayPath(root, dir)}`)
      if (st.type !== 'dir') throw new Error(`Not a directory: ${displayPath(root, dir)}`)
      const entries = ((await root.fs.readdir(dir)) ?? []).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      const out: string[] = []
      let limited = false
      for (const e of entries) {
        if (out.length >= limit) {
          limited = true
          break
        }
        out.push(e.name + (e.type === 'dir' ? '/' : ''))
      }
      if (out.length === 0) return '(empty directory)'
      const t = truncateHead(out.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
      const notices: string[] = []
      if (limited) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
      if (t.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
      return t.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '')
    },
  }
}
