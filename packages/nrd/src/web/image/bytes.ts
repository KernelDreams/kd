/**
 * Байты картинок и медиа без `Buffer`: base64 и MIME по сигнатуре. Ступень web —
 * только `btoa`/`atob` (WinterCG), работает в Node, браузере и Workers.
 */

/** Uint8Array → base64 (без префикса data:). */
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 → Uint8Array. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** MIME картинки по первым байтам; неизвестная сигнатура — `application/octet-stream`. */
export function sniffImageMime(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp'
  return 'application/octet-stream'
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

/**
 * MIME медиа по первым байтам (media-gen-spec §1): картинки — как `sniffImageMime`,
 * плюс `video/mp4` (ISO BMFF `ftyp`; `M4A ` — `audio/mp4`), `video/webm`,
 * `audio/mpeg` (ID3 / кадр MPEG), `audio/wav`, `audio/ogg`, `audio/flac`.
 */
export function sniffMediaMime(b: Uint8Array): string {
  const img = sniffImageMime(b)
  if (img !== 'application/octet-stream') return img
  if (ascii(b, 4, 'ftyp')) return ascii(b, 8, 'M4A ') ? 'audio/mp4' : 'video/mp4'
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'audio/wav'
  if (ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (ascii(b, 0, 'OggS')) return 'audio/ogg'
  if (ascii(b, 0, 'fLaC')) return 'audio/flac'
  return 'application/octet-stream'
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
}

/** Расширение файла по MIME медиа (картинка, видео, звук); неизвестный — `bin`. */
export function imageExt(mime: string): string {
  return EXT[mime] ?? 'bin'
}

/** То же, что `imageExt`: имя по смыслу для видео и звука. */
export const mediaExt = imageExt

/** Вид медиа по MIME: `image` | `video` | `audio`; иное — undefined. */
export function mediaKindOf(mime: string): 'image' | 'video' | 'audio' | undefined {
  const top = mime.split('/')[0]
  return top === 'image' || top === 'video' || top === 'audio' ? top : undefined
}
