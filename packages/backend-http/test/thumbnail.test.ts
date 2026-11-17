/**
 * Эскиз на любом хосте (pics-spec §3): sharp для картинок (поворот по EXIF), ffmpeg для
 * кадра видео, WebP; битый файл — `false`. Живые инструменты: нет ffmpeg — видео-тест пропускается.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostThumbnail, thumbKind, thumbMime } from '../src/external.js'

const sharp = (await import('sharp' as string).then((m: { default: unknown }) => m.default, () => null)) as null | ((x: unknown, o?: unknown) => any)
const ffmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Размер WebP по заголовку VP8/VP8L/VP8X. */
function webpSize(b: Buffer): { w: number; h: number } {
  const fourcc = b.toString('ascii', 12, 16)
  if (fourcc === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }
  }
  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nr-thumb-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('hostThumbnail', () => {
  it.skipIf(!sharp)('картинка — WebP, вписан в px, поворот по EXIF (ориентация 6)', async () => {
    // 400×200 в пикселях, ориентация 6 — на экране 200×400.
    const src = join(dir, 'o6.jpg')
    await sharp!({ create: { width: 400, height: 200, channels: 3, background: '#c33' } }).jpeg().withMetadata({ orientation: 6 }).toFile(src)
    const out = join(dir, 'o6.webp')
    expect(await hostThumbnail(src, out, 128, 'image')).toBe(true)
    const data = await readFile(out)
    expect(thumbMime(data)).toBe('image/webp')
    expect(webpSize(data)).toEqual({ w: 64, h: 128 })
  })

  it.skipIf(!ffmpeg)('видео — кадр WebP', async () => {
    const src = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:duration=1', '-pix_fmt', 'yuv420p', src])
    const out = join(dir, 'clip.webp')
    expect(await hostThumbnail(src, out, 160, 'video')).toBe(true)
    const data = await readFile(out)
    expect(thumbMime(data)).toBe('image/webp')
    expect(webpSize(data).w).toBe(160)
  })

  it('битый файл — false, файла эскиза нет', async () => {
    const src = join(dir, 'broken.png')
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const out = join(dir, 'broken.webp')
    expect(await hostThumbnail(src, out, 128, 'image')).toBe(false)
    await expect(readFile(out)).rejects.toThrow()
  })
})

/** Плоский PSD 8 бит RGB без слоёв: заголовок, пустые секции, сырые каналы. */
function flatPsd(w: number, h: number): Buffer {
  const head = Buffer.alloc(26)
  head.write('8BPS', 0, 'ascii')
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(3, 12)
  head.writeUInt32BE(h, 14)
  head.writeUInt32BE(w, 18)
  head.writeUInt16BE(8, 22)
  head.writeUInt16BE(3, 24)
  const empty = Buffer.alloc(4)
  const comp = Buffer.alloc(2)
  const planes = Buffer.alloc(w * h * 3)
  planes.fill(200, 0, w * h)
  return Buffer.concat([head, empty, empty, empty, comp, planes])
}

describe('эскиз PSD (ABC-794)', () => {
  it.skipIf(!hasFfmpegHere())('hostThumbnail: PSD сведённой картинкой — ffmpeg (sharp PSD не читает)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nr-psd-'))
    try {
      const src = join(dir, 'a.psd')
      await writeFile(src, flatPsd(40, 20))
      const out = join(dir, 'a.webp')
      expect(await hostThumbnail(src, out, 64, 'image')).toBe(true)
      expect(thumbMime(new Uint8Array(await readFile(out)).subarray(0, 12))).toBe('image/webp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('thumbKind: psd / psb — картинка', () => {
    expect(thumbKind('/x/a.PSD')).toBe('image')
    expect(thumbKind('/x/a.psb')).toBe('image')
  })
})

function hasFfmpegHere(): boolean {
  return spawnSync('ffmpeg', ['-version']).status === 0
}

