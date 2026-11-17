/**
 * `kd job` — задачи (jobs): прогон дольше окна, очередь, лимиты, лог после смерти процесса; `--on=<машина>`
 * и `$needs` — в пул машин (kd-cli-spec §11, compute-pool-spec). Задача убитого воркера уходит следующему
 * сама только при `$repeatable`; иначе — код 4 у постановщика, повтор — `kd job restart <id>`.
 *
 *   kd job start <тул|документ> [-- аргументы тула] [--on=машина] [--wait]
 */

import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { hostOf } from '../node/host.js'
import { loadCatalog } from '../node/catalog.js'

export const tool = {
  description: 'задачи: прогон вне окна, очередь, лог; --on=<машина> — в пул машин',
  fields: {
    target: 'string? $pos=1 $for=start // Тул или документ',
    args: 'string[]? $rest $for=start // Аргументы тула (после --)',
    on: 'string? $kind=host $for=start // Машина пула',
    pool: 'checkbox $for=start // В пул машин без привязки (раздача по $needs)',
    wait: 'checkbox $for=start,status // Дождаться конца: лог и выходы, код по итогу',
    repeatable: 'checkbox $for=start // Повторяема: потеря машины — следующему воркеру',
    retries: 'number? 0..10 $for=start,restart // Попыток на потерю машины (решение постановщика)',
    id: 'string? $pos=1 $for=status,log,cancel,restart // Задача',
  },
  actions: {
    list: { title: 'задачи', default: true },
    start: { title: 'поставить задачу' },
    status: { title: 'состояние задачи' },
    log: { title: 'лог задачи' },
    cancel: { title: 'отменить' },
    restart: { title: 'повторить' },
  },
  examples: ['kd job start bench.mdz --on=pc --wait', 'kd job start forge -- play https://… --persona=me', 'kd job status 20261115-…'],
}

type Ctx = { get(p: string[]): unknown }
const s = (ctx: Ctx, k: string): string => (typeof ctx.get([k]) === 'string' ? (ctx.get([k]) as string) : '')

/** Аргументы тула словами → значения задачи (`--k=v`, остальное — `_`). */
function valuesOf(args: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const pos: string[] = []
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]!] = m[2] ?? true
    else pos.push(a)
  }
  if (pos.length) out._ = pos.length === 1 ? pos[0] : pos
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export default async function job(ctx: Ctx): Promise<{ output: string; exitCode?: number }> {
  const h = hostOf()
  const jobs = await import('@kerneldreams/runz-run/jobs')
  const action = s(ctx, 'action') || 'list'
  const show = (j: { id: string; status: string; title?: string; worker?: string; error?: string }): string => `${j.id}  ${j.status.padEnd(9)} ${j.title ?? ''}${j.worker ? `  @${j.worker}` : ''}${j.error ? `\n  ${j.error}` : ''}`
  if (action === 'list') {
    const list = jobs.list({ limit: 30 } as never) as Array<{ id: string; status: string; title?: string; worker?: string }>
    return { output: list.length ? list.map(show).join('\n') : 'задач нет' }
  }
  if (action === 'start') {
    const target = s(ctx, 'target')
    if (!target) return { output: 'kd job start: нужен тул или документ\nkd job start <тул|документ> [-- аргументы]', exitCode: 2 }
    const cwd = h?.io.cwd ?? process.cwd()
    const asPath = resolve(cwd, target)
    const entry = existsSync(asPath) ? asPath : h ? loadCatalog(h.layers).tools.get(target)?.file : undefined
    if (!entry) return { output: `kd job start: «${target}» — не тул и не файл`, exitCode: 2 }
    const args = ctx.get(['args'])
    const retries = ctx.get(['retries'])
    const j = (await jobs.start({
      target: entry,
      cwd,
      values: valuesOf(Array.isArray(args) ? args.map(String) : []),
      ...(s(ctx, 'on') ? { on: s(ctx, 'on'), pool: true } : ctx.get(['pool']) === true ? { pool: true } : {}),
      ...(ctx.get(['repeatable']) === true ? { repeatable: true } : {}),
      ...(typeof retries === 'number' ? { retries } : {}),
    } as never)) as { id: string; status: string }
    if (ctx.get(['wait']) !== true) return { output: `${j.id}  ${j.status}\nсостояние: kd job status ${j.id}` }
    return waitFor(jobs, j.id)
  }
  const id = s(ctx, 'id')
  if (!id) return { output: `kd job ${action}: нужен id задачи`, exitCode: 2 }
  if (action === 'status') {
    if (ctx.get(['wait']) === true) return waitFor(jobs, id)
    const j = jobs.get(id) as { id: string; status: string; title?: string; worker?: string; error?: string; last?: string } | null
    return j ? { output: show(j) + (j.last ? `\n  ${j.last}` : '') } : { output: `задачи ${id} нет`, exitCode: 2 }
  }
  if (action === 'log') {
    const dir = jobs.jobsDir()
    const { readFileSync } = await import('node:fs')
    const f = join(dir, id, 'output.log')
    return existsSync(f) ? { output: readFileSync(f, 'utf8') } : { output: `лога ${id} нет`, exitCode: 2 }
  }
  if (action === 'cancel') {
    const j = (await jobs.cancel(id)) as { status: string } | null
    return j ? { output: `${id}  ${j.status}` } : { output: `задачи ${id} нет`, exitCode: 2 }
  }
  const retries = ctx.get(['retries'])
  const j = (await jobs.restart(id, typeof retries === 'number' ? ({ retries } as never) : {})) as { id: string; status: string }
  return { output: `${j.id}  ${j.status} (повтор ${id})` }
}

/** Ждать конца задачи: итог, лог, выходы; потеря машины без `$repeatable` — код 4. */
async function waitFor(jobs: typeof import('@kerneldreams/runz-run/jobs'), id: string): Promise<{ output: string; exitCode?: number }> {
  for (;;) {
    const j = jobs.get(id) as { status: string; output?: string; outputs?: string[]; error?: string; worker?: string } | null
    if (!j) return { output: `задачи ${id} нет`, exitCode: 2 }
    if (['done', 'failed', 'cancelled', 'lost', 'interrupted'].includes(j.status)) {
      const lines = [`${id}  ${j.status}${j.worker ? ` @${j.worker}` : ''}`]
      if (j.output) lines.push(j.output.trim())
      if (j.outputs?.length) lines.push(`выходы: ${j.outputs.join(', ')}`)
      if (j.error) lines.push(j.error)
      const code = j.status === 'done' ? 0 : j.status === 'lost' ? 4 : 1
      return { output: lines.join('\n'), ...(code ? { exitCode: code } : {}) }
    }
    await sleep(500)
  }
}
