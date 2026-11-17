/**
 * Байты ↔ строка провода: общее правило кодировки `utf8 | base64` для
 * `fileContent` и `attachmentContent`. Отдельным модулем — files.ts и
 * attachments.ts импортируют друг друга, общий низ разрывает цикл.
 */

/** UTF-8 без NUL → текст, иначе `undefined` (общее правило кодировки провода). */
export function utf8Text(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return undefined
  }
}

export function toBase64(data: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

