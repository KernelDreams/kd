/**
 * `kd worker` — воркер пула машин (kd-cli-spec §11, compute-pool-spec): сам приходит к центру и забирает
 * задачи в пределах бюджета и предохранителя. Конфиг — `worker.mdz` в данных копии (переносная копия —
 * рядом с ней: адрес центра, ключ, имя, бюджет); флаги — поверх. Исполняет рантаймом этой копии.
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { hostOf } from '../node/host.js'

export const tool = {
  description: 'воркер пула машин: забирает задачи у центра и исполняет их здесь',
  fields: {
    center: 'string? $kind=url // Адрес центра пула',
    key: 'string? // Ключ машины',
    name: 'string? // Имя машины (по умолчанию — имя хоста)',
    jobs: 'number? 1..64 // Задач разом',
  },
  examples: ['kd worker --center=https://pool.example --key=…', 'kd worker  # адрес и ключ — в worker.mdz данных копии'],
}

type Ctx = { get(p: string[]): unknown }
const s = (ctx: Ctx, k: string): string => (typeof ctx.get([k]) === 'string' ? (ctx.get([k]) as string) : '')

export default async function worker(ctx: Ctx): Promise<{ output: string; exitCode?: number }> {
  const h = hostOf()
  const data = h?.layers.copy.dataDir ?? process.cwd()
  const pool = await import('@kerneldreams/runz-run/pool')
  const cfg = pool.loadWorkerConfig(join(data, 'worker.mdz'))
  cfg.root = join(data, 'pool')
  if (s(ctx, 'center')) cfg.pool = s(ctx, 'center')
  if (s(ctx, 'key')) cfg.key = s(ctx, 'key')
  if (s(ctx, 'name')) cfg.name = s(ctx, 'name')
  const jobs = ctx.get(['jobs'])
  if (typeof jobs === 'number') cfg.budget = { ...cfg.budget, jobs }
  if (!cfg.key || !cfg.pool) return { output: `kd worker: нужен адрес центра и ключ — --center, --key или ${join(data, 'worker.mdz')}`, exitCode: 3 }
  // Исполнитель — CLI runz этой копии kd (не тот, что в PATH).
  const runzBin = join(dirname(createRequire(import.meta.url).resolve('@kerneldreams/runz/package.json')), 'bin', 'runz.ts')
  const w = new pool.Worker({
    config: cfg,
    client: pool.httpPoolClient(cfg.pool, cfg.key, cfg.name),
    exec: pool.runzExecutor([process.execPath, runzBin]),
    log: (m: string) => void process.stderr.write(`kd worker: ${m}\n`),
  })
  process.stderr.write(`kd worker: ${cfg.name} → ${cfg.pool}\n`)
  const stop = (): void => (w as unknown as { stop(): void }).stop()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await w.run()
  return { output: '' }
}
