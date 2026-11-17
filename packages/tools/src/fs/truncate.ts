/**
 * Обрезка вывода тулов: два независимых лимита — строки и байты, что раньше.
 * Голова — для файлов (`read`, списки), хвост — для вывода команд (`exec`).
 *
 * Порт `pi-nrchat/packages/coding-agent/src/core/tools/truncate.ts` (MIT,
 * Mario Zechner), сокращён до того, что используют наши тулы.
 */

import { utf8Bytes, utf8Length, utf8Text } from '../bytes.js'

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500

export interface Truncation {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
  /** Голова: первая строка сама больше лимита байт — `content` пуст. */
  firstLineExceedsLimit: boolean
}

export interface TruncateOptions {
  maxLines?: number
  maxBytes?: number
}

function linesOf(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Первые N строк / байт, целыми строками. */
export function truncateHead(content: string, opts: TruncateOptions = {}): Truncation {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = utf8Length(content)
  const lines = linesOf(content)
  const totalLines = lines.length
  const base = { totalLines, totalBytes }
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { ...base, content, truncated: false, truncatedBy: null, outputLines: totalLines, firstLineExceedsLimit: false }
  }
  if (utf8Length(lines[0] ?? '') > maxBytes) {
    return { ...base, content: '', truncated: true, truncatedBy: 'bytes', outputLines: 0, firstLineExceedsLimit: true }
  }
  const out: string[] = []
  let bytes = 0
  let by: 'lines' | 'bytes' = 'lines'
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const add = utf8Length(lines[i]!) + (i > 0 ? 1 : 0)
    if (bytes + add > maxBytes) {
      by = 'bytes'
      break
    }
    out.push(lines[i]!)
    bytes += add
  }
  return { ...base, content: out.join('\n'), truncated: true, truncatedBy: by, outputLines: out.length, firstLineExceedsLimit: false }
}

/** Последние N строк / байт; одна огромная последняя строка — её хвост. */
export function truncateTail(content: string, opts: TruncateOptions = {}): Truncation {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = utf8Length(content)
  const lines = linesOf(content)
  const totalLines = lines.length
  const base = { totalLines, totalBytes, firstLineExceedsLimit: false }
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { ...base, content, truncated: false, truncatedBy: null, outputLines: totalLines }
  }
  const out: string[] = []
  let bytes = 0
  let by: 'lines' | 'bytes' = 'lines'
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!
    const add = utf8Length(line) + (out.length > 0 ? 1 : 0)
    if (bytes + add > maxBytes) {
      by = 'bytes'
      if (out.length === 0) {
        const buf = utf8Bytes(line)
        let start = buf.length - maxBytes
        while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
        out.unshift(utf8Text(buf.subarray(start)))
      }
      break
    }
    out.unshift(line)
    bytes += add
  }
  return { ...base, content: out.join('\n'), truncated: true, truncatedBy: by, outputLines: out.length }
}

/** Строка совпадения grep — до N символов. */
export function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
}

/** Лимит результата в контексте (tools-spec §5): голова + пометка, сколько срезано. */
export function capResultText(text: string, maxBytes: number): string {
  const buf = utf8Bytes(text)
  const total = buf.length
  if (maxBytes <= 0 || total <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return `${utf8Text(buf.subarray(0, end))}\n\n[… result truncated: ${total - end} of ${total} bytes cut (tool result limit) …]`
}
