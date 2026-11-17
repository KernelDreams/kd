/**
 * Проверка рантайма после finalize — композиция для агентов:
 * запрос «открой и проверь» в очередь `open.jsonl` → живой nrchat открывает
 * (перезагружает) вкладку, ждёт load + окно и присылает ошибки гостя. Нет
 * nrchat — «не проверено», а не провал. Одна на `pi-ext-artifact`
 * (`artifact_finalize`) и `appz/artifact` (`runz artifact finalize`),.
 */

import type { RegistryOpts } from './collections.js'
import type { FinalizeResult } from './lifecycle.js'
import { requestOpen } from './lifecycle.js'
import type { RuntimeError } from './runtime.js'
import { awaitRuntimeCheck, newCheckId } from './runtime.js'

/** finalize + проверка рантайма. `runtimeErrors: null` — не проверено (почему — `unchecked` и `note`). */
export interface CheckedFinalize extends FinalizeResult {
  ok: boolean
  runtimeErrors: RuntimeError[] | null
  /** Почему не проверено: запрос не поставился / nrchat не открыт / вкладка не ответила. */
  unchecked?: 'request' | 'no-client' | 'timeout'
  note?: string
}

export interface CheckTimings {
  /** Ждать, что запрос подхватил открытый nrchat. Default 2500. */
  ackMs?: number
  /** Ждать результата: загрузка вкладки + окно 3 с. Default 20 000. */
  resultMs?: number
}

export async function checkRuntime(r: FinalizeResult, reg: RegistryOpts & { root?: string }, t: CheckTimings = {}): Promise<CheckedFinalize> {
  if (r.errors.length > 0) return { ...r, ok: false, runtimeErrors: null }
  const check = newCheckId()
  try {
    requestOpen(r.dir, { ...reg, check })
  } catch (e) {
    return { ...r, ok: true, runtimeErrors: null, unchecked: 'request', note: (e as Error).message }
  }
  const res = await awaitRuntimeCheck(check, { ackMs: t.ackMs ?? 2500, resultMs: t.resultMs ?? 20_000, ...(reg.root ? { root: reg.root } : {}) })
  if (res.status === 'no-client') return { ...r, ok: true, runtimeErrors: null, unchecked: 'no-client', note: 'нет открытого nrchat' }
  if (res.status === 'timeout') {
    return {
      ...r,
      ok: true,
      runtimeErrors: null,
      unchecked: 'timeout',
      note: 'nrchat принял запрос, но вкладка не ответила (артефакт вне рабочей области открытого nrchat?)',
    }
  }
  return { ...r, ok: res.errors.length === 0, runtimeErrors: res.errors }
}
