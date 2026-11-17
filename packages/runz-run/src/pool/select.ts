/**
 * Выбор машины (compute-pool-spec §5) и предохранитель (§3) — чистые функции:
 * их зовёт центр на каждой раздаче, воркер — перед запросом задачи.
 */

import { needsOf, type Budget, type Guard, type Measure, type Needs, type WorkerState } from './types.js'

/** Предохранитель по реальному замеру: `deep` — память ниже половины порога. */
export function guardState(guard: Guard, m: Measure): WorkerState['guard'] {
  if (m.memFree < guard.memFree / 2) return 'deep'
  if (m.memFree < guard.memFree || m.diskFree < guard.diskFree || m.load > guard.load) return 'tripped'
  return 'ok'
}

/** Занято бюджета идущими задачами. */
export function used(running: { needs: Needs }[]): Budget {
  const u: Budget = { cpu: 0, mem: 0, disk: 0, jobs: 0 }
  for (const r of running) {
    const n = needsOf(r.needs)
    u.cpu += n.cpu ?? 0
    u.mem += n.mem ?? 0
    u.disk += n.disk ?? 0
    u.jobs++
  }
  return u
}

/** Подходит ли машина по ОС, меткам и прибитому хосту (§5 п.1). */
export function matches(needs: Needs | undefined, w: Pick<WorkerState, 'name' | 'os' | 'arch' | 'labels'>): boolean {
  const n = needs ?? {}
  if (n.host && n.host !== w.name) return false
  if (n.os && n.os !== w.os) return false
  for (const l of n.labels ?? []) if (l !== w.arch && !w.labels.includes(l)) return false
  return true
}

/**
 * Влезает ли в свободный бюджет (§5 п.2). Прибитая к этой машине задача бюджет не
 * считает — ей больше некуда идти (хост prod с `jobs: 0` берёт только такие).
 */
export function fitsBudget(needs: Needs | undefined, w: Pick<WorkerState, 'name' | 'budget' | 'running'>): boolean {
  if (needs?.host && needs.host === w.name) return true
  const n = needsOf(needs)
  const u = used(w.running)
  const b = w.budget
  if (u.jobs + 1 > b.jobs) return false
  if (u.cpu + (n.cpu ?? 0) > b.cpu) return false
  if (u.mem + (n.mem ?? 0) > b.mem) return false
  if ((n.disk ?? 0) > 0 && u.disk + (n.disk ?? 0) > b.disk) return false
  return true
}

/** Машина может взять задачу сейчас: подходит, влезает, не на паузе и не под предохранителем. */
export function canTake(needs: Needs | undefined, w: WorkerState): boolean {
  return !w.paused && w.guard === 'ok' && matches(needs, w) && fitsBudget(needs, w)
}

/**
 * Лучшая машина из ждущих (§5): хост prod — последним; дальше — больше пакетов
 * задачи в кэше; дальше — больше свободного CPU. Никто не может — null.
 */
export function pick<W extends WorkerState>(
  job: { needs?: Needs | undefined; pkgs?: string[] | undefined },
  workers: W[],
  prodHost?: string,
): W | null {
  const ok = workers.filter((w) => canTake(job.needs, w))
  if (ok.length === 0) return null
  const pkgs = job.pkgs ?? []
  const hits = (w: W): number => pkgs.filter((p) => w.cache.includes(p)).length
  ok.sort((a, b) => {
    const pa = a.name === prodHost ? 1 : 0
    const pb = b.name === prodHost ? 1 : 0
    if (pa !== pb) return pa - pb
    const h = hits(b) - hits(a)
    if (h !== 0) return h
    return b.measure.cpuFree - a.measure.cpuFree
  })
  return ok[0] ?? null
}
