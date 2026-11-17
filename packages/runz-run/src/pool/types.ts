/**
 * Словарь пула (compute-pool-spec §3–§4): что нужно задаче (`$needs`), сколько
 * машина отдаёт (`$budget`), предохранитель (`$guard`) и сердцебиение воркера.
 * Размеры в документах — строкой (`mem: "16G"`: объект атрибута — JSON5), внутри —
 * байты.
 */

export interface Needs {
  cpu?: number
  /** Байты. */
  mem?: number
  /** Байты. */
  disk?: number
  os?: string
  labels?: string[]
  /** Прибить к машине (`--on=carol`, e2e-live, живой стенд). */
  host?: string
  net?: string
}

/** Задача без `$needs` — `{cpu: 1, mem: 1G}`, любая машина. */
export const DEFAULT_NEEDS: Readonly<Required<Pick<Needs, 'cpu' | 'mem'>>> = { cpu: 1, mem: 1024 ** 3 }

export interface Budget {
  cpu: number
  mem: number
  disk: number
  jobs: number
}

export interface Guard {
  /** Байты свободной памяти, ниже — не брать. */
  memFree: number
  diskFree: number
  /** Загрузка на ядро (loadavg / cpus), выше — не брать. */
  load: number
}

/** Реальное состояние машины (замер воркера). */
export interface Measure {
  memFree: number
  diskFree: number
  /** loadavg(1) / число ядер. */
  load: number
  /** Ядер, не занятых загрузкой. */
  cpuFree: number
}

export interface RunningLease {
  id: string
  lease: string
  needs: Needs
  started: string
}

/** Что воркер говорит центру (сердцебиение и запрос задачи). */
export interface WorkerState {
  name: string
  os: string
  arch: string
  labels: string[]
  budget: Budget
  measure: Measure
  /** Сработал ли предохранитель: `deep` — память ниже половины порога. */
  guard: 'ok' | 'tripped' | 'deep'
  paused: boolean
  running: RunningLease[]
  /** sha пакетов в кэше. */
  cache: string[]
  version: string
}

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/** `16G`, `512M`, `1.5g`, `2048` (байты) → байты; мусор — undefined. */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  if (typeof v !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?\s*$/i.exec(v)
  if (!m) return undefined
  return Math.round(Number(m[1]) * (UNITS[(m[2] ?? '').toLowerCase()] ?? 1))
}

/** Байты → `16G` / `512M` / `100K` (как пишет человек). */
export function formatSize(n: number): string {
  for (const [u, k] of [['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]] as const) {
    if (n >= k) {
      const x = n / k
      return `${Number.isInteger(x) ? x : x.toFixed(1)}${u}`
    }
  }
  return String(n)
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : undefined)

function list(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean)
  // IArray NRD (`$[a, b]`) — итерируемый.
  if (v && typeof v === 'object' && typeof (v as { iterate?: unknown }).iterate === 'function') {
    return [...(v as { iterate(): Iterable<unknown> }).iterate()].map((x) => String(x).trim()).filter(Boolean)
  }
  return undefined
}

/** `$needs` из документа (объект JSON5) или поля `start`. */
export function parseNeeds(raw: unknown): Needs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const n: Needs = {}
  const cpu = num(o.cpu)
  if (cpu !== undefined) n.cpu = cpu
  const mem = parseSize(o.mem)
  if (mem !== undefined) n.mem = mem
  const disk = parseSize(o.disk)
  if (disk !== undefined) n.disk = disk
  const os = str(o.os)
  if (os) n.os = os
  const labels = list(o.labels)
  if (labels?.length) n.labels = labels
  const host = str(o.host)
  if (host) n.host = host
  const net = str(o.net)
  if (net) n.net = net
  return n
}

const q = (s: string): string => JSON.stringify(s)

/** Обратно в атрибут `job.mdz`: `{cpu: 8, mem: "16G", labels: ["cargo"]}`. */
export function formatNeeds(n: Needs): string {
  const parts: string[] = []
  if (n.cpu !== undefined) parts.push(`cpu: ${n.cpu}`)
  if (n.mem !== undefined) parts.push(`mem: ${q(formatSize(n.mem))}`)
  if (n.disk !== undefined) parts.push(`disk: ${q(formatSize(n.disk))}`)
  if (n.os) parts.push(`os: ${q(n.os)}`)
  if (n.labels?.length) parts.push(`labels: [${n.labels.map(q).join(', ')}]`)
  if (n.host) parts.push(`host: ${q(n.host)}`)
  if (n.net) parts.push(`net: ${q(n.net)}`)
  return `{${parts.join(', ')}}`
}

/** Нужды с дефолтами (cpu 1, mem 1G). */
export const needsOf = (n: Needs | undefined): Needs => ({ ...DEFAULT_NEEDS, ...(n ?? {}) })

export function parseBudget(raw: unknown, fallback: Budget): Budget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const o = raw as Record<string, unknown>
  return {
    cpu: num(o.cpu) ?? fallback.cpu,
    mem: parseSize(o.mem) ?? fallback.mem,
    disk: parseSize(o.disk) ?? fallback.disk,
    jobs: num(o.jobs) !== undefined ? Math.floor(num(o.jobs)!) : fallback.jobs,
  }
}

export function parseGuard(raw: unknown, fallback: Guard): Guard {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const o = raw as Record<string, unknown>
  return {
    memFree: parseSize(o.mem_free) ?? fallback.memFree,
    diskFree: parseSize(o.disk_free) ?? fallback.diskFree,
    load: num(o.load) ?? fallback.load,
  }
}
