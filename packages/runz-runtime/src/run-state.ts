/**
 * Состояние прогона документа с шагами (kd-cli-spec §8): дерево шагов в `.mds` — сохранение,
 * продолжение той же командой, повтор. Файл — `<папка документа>/.runz/state/<имя>.mds`:
 * `%meta` — документ и отпечаток (текст документа + аргументы), дальше узел `%step <id>` на шаг
 * со статусом (`running` / `done`) и результатом в теле (JSON в фенсе).
 *
 * Включается хостом (`RUNZ_STATE=1`, команда kd); runz без него ведёт себя как раньше.
 * Удачный прогон файл состояния снимает. Шаг, оборванный посреди (`running`), повторяется сам,
 * только если он заявлен `$repeatable: true` (блок или корень документа) или у него нет `$effects`;
 * иначе — ошибка «прерван» (код 4), повтор — флагом `--retry=<id>` при следующем запуске.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse, stringify, type ChatMessage } from '@kerneldreams/nrd/chat'
import { InterruptedError } from './busy.ts'

export interface StepRecord {
  id: string
  status: 'running' | 'done'
  /** Результат шага (JSON). */
  result?: unknown
  at: string
}

export interface RunState {
  file: string
  hash: string
  steps: Map<string, StepRecord>
}

export const stateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.RUNZ_STATE === '1'

export function stateFileOf(docFile: string): string {
  return join(dirname(docFile), '.runz', 'state', `${basename(docFile).replace(/\.(mdz|md|mdd|mds)$/i, '')}.mds`)
}

export function runHash(docText: string, args: unknown): string {
  return createHash('sha256').update(docText).update('\0').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16)
}

function render(s: RunState): string {
  const msgs: ChatMessage[] = [{ role: 'meta', meta: { kind: 'run-state', hash: s.hash }, body: '' }]
  for (const st of s.steps.values()) {
    const json = st.result === undefined ? '' : JSON.stringify(st.result, null, 1)
    msgs.push({ role: 'step', name: st.id, meta: { status: st.status, at: st.at }, body: json ? '````json\n' + json + '\n````' : '' })
  }
  return stringify(msgs)
}

/** Прочитать состояние; другой отпечаток (документ или аргументы изменились) — начать заново. */
export function loadState(docFile: string, hash: string): RunState {
  const file = stateFileOf(docFile)
  const fresh: RunState = { file, hash, steps: new Map() }
  if (!existsSync(file)) return fresh
  try {
    const msgs = parse(readFileSync(file, 'utf8'))
    const meta = msgs.find((m) => m.role === 'meta')?.meta
    if (meta?.hash !== hash) return fresh
    for (const m of msgs) {
      if (m.role !== 'step' || !m.name) continue
      const body = m.body.replace(/^````json\n/, '').replace(/\n````\s*$/, '').trim()
      fresh.steps.set(m.name, { id: m.name, status: m.meta?.status === 'done' ? 'done' : 'running', at: String(m.meta?.at ?? ''), ...(body ? { result: JSON.parse(body) } : {}) })
    }
    return fresh
  } catch (err) {
    process.stderr.write(`[runz] состояние ${file} не читается (${(err as Error).message}) — прогон заново\n`)
    return fresh
  }
}

export function saveState(s: RunState): void {
  mkdirSync(dirname(s.file), { recursive: true })
  const tmp = `${s.file}.${process.pid}.tmp`
  writeFileSync(tmp, render(s))
  renameSync(tmp, s.file)
}

export function clearState(s: RunState): void {
  rmSync(s.file, { force: true })
}

export interface StepPolicy {
  repeatable: boolean
  effects: boolean
}

/**
 * Перед шагом: `done` — взять сохранённый результат; `running` (оборван) — повторить, если можно,
 * иначе {@link InterruptedError}. Возвращает сохранённый результат или `undefined` (исполнять).
 */
export function beforeStep(s: RunState, id: string, policy: StepPolicy, retry: ReadonlySet<string>): { cached: boolean; result?: unknown } {
  const rec = s.steps.get(id)
  if (rec?.status === 'done') return { cached: true, result: rec.result }
  if (rec?.status === 'running' && policy.effects && !policy.repeatable && !retry.has(id) && !retry.has('*')) {
    throw new InterruptedError(`шаг «${id}» оборван посреди побочного действия и сам не повторяется ($repeatable не заявлен) — повторить: та же команда с --retry=${id}`, null)
  }
  s.steps.set(id, { id, status: 'running', at: new Date().toISOString() })
  saveState(s)
  return { cached: false }
}

export function afterStep(s: RunState, id: string, result: unknown): void {
  s.steps.set(id, { id, status: 'done', at: new Date().toISOString(), result: JSON.parse(JSON.stringify(result ?? null)) })
  saveState(s)
}
