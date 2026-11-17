/**
 * Обвязка конформанс-тестов StoreBackend: скриптованная генерация + мелочи.
 * Реального движка нет — generate инъектируется чанками (backend-mds-spec §4).
 */

import type { AnyRunEvent, Message } from '@kerneldreams/ui-protocol'
import type { GenChunk, GenerateFn, GenerateRequest } from '../src/store-backend.js'

/** Скриптованная генерация: отдаёт чанки, опционально ждёт abort / бросает. */
export interface GenScript {
  chunks: GenChunk[]
  /** После чанков висеть до abort (для cancel-теста). */
  waitAbort?: boolean
  /** Бросить после чанков (ошибка генерации, §4). */
  throwErr?: Error
  /** Шпион запроса: чем кормят generate. */
  onRequest?: (req: GenerateRequest) => void
}

export function scriptGen(script: GenScript): GenerateFn {
  return async function* (req: GenerateRequest): AsyncIterable<GenChunk> {
    script.onRequest?.(req)
    for (const c of script.chunks) {
      if (req.signal.aborted) return
      yield c
    }
    if (script.waitAbort && !req.signal.aborted) {
      await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()))
    }
    if (script.throwErr) throw script.throwErr
  }
}

export const noGen: GenerateFn = async function* () {}

export async function collect(iter: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

export function textOf(msg: Message): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
