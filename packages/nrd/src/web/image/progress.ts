/**
 * Прогресс генерации (image-gen-2-spec §1): обёртка над `onProgress` запроса.
 * Колбэк зовётся только на смене `stage`/`status`/`step` (превью — всегда);
 * исключение колбэка ловится и уходит в warn, генерацию не роняет.
 */

import type { ImageProgress } from '../../contracts/index.js'

export type ProgressEmit = (e: ImageProgress) => void

export function progressEmitter(cb: ((e: ImageProgress) => void) | undefined, who: string): ProgressEmit {
  if (!cb) return () => {}
  let last: ImageProgress | undefined
  return (e) => {
    if (!e.preview && last && last.stage === e.stage && last.status === e.status && last.step === e.step) return
    last = e
    try {
      cb(e)
    } catch (x) {
      console.warn(`${who}: onProgress бросил исключение — ${x instanceof Error ? x.message : String(x)}`)
    }
  }
}
