/**
 * Обёртка задачи — `runz-run job-wrap <id>` (jobs-spec §2): отдельный процесс в
 * своей группе, запускает runz и сам пишет `log.ndjson` и конец в `job.mdz`.
 * Родитель (стенд, CLI) может умереть сразу после запуска — лог пишется дальше.
 *
 * SIGTERM группе (отмена) → SIGTERM группе runz, через 10 с SIGKILL; конец —
 * `cancelled` (если отмену просили через `cancel()`), иначе `lost`. После конца — проход планировщика: следующая из очереди стартует
 * и без резидентного планировщика.
 */

import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { runFile } from '../run.js'
import { materialize, type TemplateValue, type TemplateValues } from '../template.js'
import { isDocTarget } from './recipe.js'
import { appendLog, inputsDir, jobsDir, readJob, traceOf, tracePointer, withLock, writeJob } from './registry.js'
import type { JobInfo } from './registry.js'
import { runEnv, tick } from './scheduler.js'

const KILL_GRACE_MS = 10_000
const ERROR_TAIL = 2_000

/** `inputs/<имя>` в значениях → абсолютный путь входа задачи (если такой вход есть). */
export function resolveInputs(dir: string, job: JobInfo): TemplateValues {
  const base = inputsDir(dir, job.id)
  const one = (v: TemplateValue): TemplateValue => {
    if (typeof v !== 'string' || !v.startsWith('inputs/')) return v
    const p = join(base, v.slice('inputs/'.length))
    return existsSync(p) ? p : v
  }
  const out: TemplateValues = {}
  for (const [k, v] of Object.entries(job.values)) out[k] = Array.isArray(v) ? v.map(one) : one(v)
  return out
}

/** Значения appz — аргументами CLI (список — через запятую: CLI списков не передаёт). */
const cliArgs = (values: TemplateValues): string[] =>
  Object.entries(values).map(([k, v]) => `--${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)

export async function runWrapper(id: string, dir = jobsDir(), early?: AbortSignal): Promise<number> {
  const job = readJob(dir, id)
  if (!job) {
    process.stderr.write(`job-wrap: нет задачи ${id}\n`)
    return 2
  }
  const ac = new AbortController()
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => ac.abort())
  if (early?.aborted) ac.abort()
  else early?.addEventListener('abort', () => ac.abort(), { once: true })

  let runz = ['runz']
  try {
    if (process.env.RUNZ_JOBS_RUNZ) runz = JSON.parse(process.env.RUNZ_JOBS_RUNZ) as string[]
  } catch {
    // битый — runz из PATH
  }

  const values = resolveInputs(dir, job)
  let file = job.target
  let args: string[] = []
  let temp: string | null = null
  const writes: Promise<unknown>[] = []

  try {
    if (job.cmd !== undefined) {
      // Задача-команда: `sh -c <cmd>` — файл runz тут сама команда.
      runz = ['sh', '-c']
      file = job.cmd
      args = []
    } else if (isDocTarget(job.target)) {
      if (Object.keys(values).length > 0) {
        // Рядом с рецептом: его `$[[…]]` и относительные пути — как у оригинала.
        const ext = extname(job.target) || '.mdz'
        temp = join(dirname(job.target), `.${basename(job.target, ext)}.job-${id}${ext}`)
        writeFileSync(temp, materialize(readFileSync(job.target, 'utf8'), values))
        file = temp
      }
    } else {
      args = cliArgs(values)
    }

    const r = await runFile({
      file,
      args,
      runz,
      cwd: job.cwd,
      // Каталог задачи — рецепту: входы `inputs/` без значений (картинки формы → `<out>/media/`, bot-fix-tool §3).
      env: { ...runEnv(), RUNZ_JOB_DIR: join(dir, id), RUNZ_TRACE_POINTER: tracePointer(dir, id) },
      signal: ac.signal,
      ...(job.cmd !== undefined ? { raw: true } : {}),
      timeoutMs: job.timeoutMs ?? 0,
      killGraceMs: KILL_GRACE_MS,
      onSpawn: (pid) => {
        writes.push(
          withLock(dir, () => {
            const j = readJob(dir, id)
            if (j && j.status === 'running') writeJob(dir, { ...j, child: pid })
          }).catch(() => undefined),
        )
      },
      onLine: (stream, text) => appendLog(dir, id, { kind: 'line', stream, text }),
    })
    await Promise.all(writes)

    await withLock(dir, () => {
      const j = readJob(dir, id) ?? job
      // Сигнал без запроса отмены (`cancel` пишет только `cancel()`) — обёртку убили
      // снаружи (стоп сервиса, машина): это `lost`, не «отменили».
      const status = ac.signal.aborted ? (j.cancel ? 'cancelled' : 'lost') : r.ok ? 'done' : 'failed'
      const next: JobInfo = { ...j, status, ended: new Date().toISOString(), exit: r.exitCode }
      delete next.child
      if (r.output) next.output = r.output
      const paths = r.outputs.flatMap((o) => (o.type === 'text' ? [] : [o.path]))
      if (paths.length > 0) next.outputs = paths
      const trace = traceOf(dir, id)
      if (trace) next.trace = trace
      if (status === 'lost') next.error = 'обёртку остановили сигналом снаружи (не отмена задачи)'
      if (status === 'failed') {
        next.error = r.timedOut ? `таймаут ${Math.round((job.timeoutMs ?? 0) / 1000)} с` : (r.stderr.trim() || r.output || `${job.cmd !== undefined ? 'exit' : 'runz exit'} ${String(r.exitCode)}`).slice(-ERROR_TAIL)
      }
      writeJob(dir, next)
      appendLog(dir, id, { kind: 'end', status, exit: r.exitCode, ms: r.ms, output: r.output, outputs: r.outputs })
    })
  } catch (e) {
    await withLock(dir, () => {
      const j = readJob(dir, id) ?? job
      writeJob(dir, { ...j, status: 'failed', ended: new Date().toISOString(), error: (e as Error).message })
      appendLog(dir, id, { kind: 'end', status: 'failed', error: (e as Error).message })
    }).catch(() => undefined)
  } finally {
    if (temp) rmSync(temp, { force: true })
  }

  try {
    await tick({ dir })
  } catch {
    // следующий проход сделает стенд или следующая постановка
  }
  return 0
}
