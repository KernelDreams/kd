/**
 * `kd info <файл>` — сведения о файле: размер, вид, у картинок — размер в пикселях и текстовые
 * чанки PNG (промпт генерации). Действие файла по умолчанию (`kd photo.png`).
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'

export const tool = {
  description: 'сведения о файле: размер, вид, у картинок — пиксели и промпт из PNG',
  fields: { path: 'string $pos=1 $kind=file // Файл' },
}

function head(path: string, n: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

function pngInfo(b: Buffer): string[] {
  const out: string[] = []
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return out
  out.push(`пиксели: ${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`)
  let off = 8
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString('latin1', off + 4, off + 8)
    if (type === 'tEXt' && off + 8 + len <= b.length) {
      const data = b.subarray(off + 8, off + 8 + len)
      const z = data.indexOf(0)
      const key = data.toString('latin1', 0, z)
      const val = data.toString('utf8', z + 1)
      out.push(`${key}: ${val.length > 400 ? `${val.slice(0, 400)}…` : val}`)
    }
    if (type === 'IEND') break
    off += 12 + len
  }
  return out
}

function jpegSize(b: Buffer): string[] {
  let off = 2
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) return []
    const marker = b[off + 1]!
    const len = b.readUInt16BE(off + 2)
    if (marker >= 0xc0 && marker <= 0xc3) return [`пиксели: ${b.readUInt16BE(off + 7)}×${b.readUInt16BE(off + 5)}`]
    off += 2 + len
  }
  return []
}

export default function info(ctx: { get(p: string[]): unknown }): { output: string; exitCode?: number } {
  const path = resolve(String(ctx.get(['path']) ?? ''))
  let st
  try {
    st = statSync(path)
  } catch {
    return { output: `kd info: нет файла ${path}`, exitCode: 2 }
  }
  const ext = extname(path).slice(1).toLowerCase()
  const lines = [path, `размер: ${st.size} байт`, `изменён: ${st.mtime.toISOString()}`]
  if (st.isFile()) {
    const b = head(path, Math.min(st.size, 4 * 1024 * 1024))
    if (ext === 'png') lines.push(...pngInfo(b))
    else if (ext === 'jpg' || ext === 'jpeg') lines.push(...jpegSize(b))
  }
  return { output: lines.join('\n') }
}
