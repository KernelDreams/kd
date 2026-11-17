/** Байты UTF-8 без `Buffer` (ядро — и в браузере). */

const enc = new TextEncoder()
const dec = new TextDecoder()

export function utf8Length(text: string): number {
  return enc.encode(text).length
}

export function utf8Bytes(text: string): Uint8Array {
  return enc.encode(text)
}

export function utf8Text(bytes: Uint8Array): string {
  return dec.decode(bytes)
}

export { fromBase64, toBase64 } from '@kerneldreams/chat-store/fs'
