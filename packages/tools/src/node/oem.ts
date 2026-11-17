/**
 * Вывод процессов на Windows: встроенные команды cmd без консоли (nr-mcp — бинарь без окна) пишут
 * в OEM-кодировке (русская Windows — cp866), внешние программы чаще в UTF-8. Режим решается на процесс по
 * первому куску с байтами ≥ 0x80: валидный UTF-8 (обрыв последовательности в конце допустим) — UTF-8, иначе cp866.
 */

import { StringDecoder } from 'node:string_decoder'

const HIGH =
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■\u00a0'

export function decodeCp866(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : HIGH[b - 0x80]!
  return out
}

/** Валидный UTF-8; незаконченная последовательность в самом конце — не ошибка (кусок потока). */
export function looksUtf8(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; ) {
    const b = buf[i]!
    const n = b < 0x80 ? 0 : (b & 0xe0) === 0xc0 ? 1 : (b & 0xf0) === 0xe0 ? 2 : (b & 0xf8) === 0xf0 ? 3 : -1
    if (n < 0) return false
    for (let k = 1; k <= n; k++) {
      if (i + k >= buf.length) return true
      if ((buf[i + k]! & 0xc0) !== 0x80) return false
    }
    i += n + 1
  }
  return true
}

/** Декодер потока: POSIX — UTF-8; Windows — UTF-8 или cp866 по первому не-ASCII куску. */
export function createOutputDecoder(win = process.platform === 'win32'): (chunk: Buffer | string) => string {
  const utf8 = new StringDecoder('utf8')
  let mode: 'utf8' | 'oem' | undefined = win ? undefined : 'utf8'
  return (chunk) => {
    if (typeof chunk === 'string') return chunk
    if (!mode && chunk.some((b) => b >= 0x80)) mode = looksUtf8(chunk) ? 'utf8' : 'oem'
    return mode === 'oem' ? decodeCp866(chunk) : utf8.write(chunk)
  }
}
