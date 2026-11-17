/**
 * Пул машин (compute-pool-spec §11, юниты): выбор машины, аренда и её
 * истечение, поздний ответ старой аренды, `$retries: 0`, кэш пакетов и LRU,
 * шарды → `$merge`, предохранитель без траты попытки, HTTP центра и воркера.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { get, list, parseJob, serializeJob, start, tick } from '../src/jobs/index.js'
import type { JobInfo, JobsConfig } from '../src/jobs/index.js'
import { readJob } from '../src/jobs/registry.js'
import {
  Center,
  PkgCache,
  Worker,
  defaultWorkerConfig,
  guardState,
  hoursOk,
  httpPoolClient,
  localPoolClient,
  pack,
  parseNeeds,
  parseSize,
  pick,
  servePool,
  runzExecutor,
  type Assignment,
  type Executor,
  type Measure,
  type WorkerState,
} from '../src/pool/index.js'

const G = 1024 ** 3
const CFG: JobsConfig = { max: 4, limits: {}, resumeLost: false, pool: true }

let root: string
let dir: string
let recipes: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pool-'))
  dir = join(root, 'jobs')
  recipes = join(root, 'recipes')
  mkdirSync(recipes, { recursive: true })
  writeFileSync(join(recipes, 'sim.mdz'), '$job_keys: $[sim]\n$needs: {cpu: 2, mem: "2G"}\n$shards: 4\n$merge: merge.mdz\n\n## run\nsim\n')
  writeFileSync(join(recipes, 'merge.mdz'), '## run\nmerge\n')
  writeFileSync(join(recipes, 'one.mdz'), '$retries: 0\n\n## run\none\n')
  writeFileSync(join(recipes, 'plain.mdz'), '## run\nplain\n')
  writeFileSync(join(recipes, 'rep.mdz'), '$repeatable: true\n\n## run\nrep\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const healthy: Measure = { memFree: 32 * G, diskFree: 200 * G, load: 0.1, cpuFree: 8 }

function ws(name: string, over: Partial<WorkerState> = {}): WorkerState {
  return {
    name,
    os: 'darwin',
    arch: 'arm64',
    labels: [],
    budget: { cpu: 8, mem: 16 * G, disk: 40 * G, jobs: 2 },
    measure: healthy,
    guard: 'ok',
    paused: false,
    running: [],
    cache: [],
    version: '1',
    ...over,
  }
}

function center(clock?: () => number, prodHost?: string): Center {
  return new Center({ dir, config: CFG, ...(clock ? { clock } : {}), ...(prodHost ? { prodHost } : {}) })
}

describe('выбор машины (§5)', () => {
  it('os, labels, host', () => {
    expect(pick({ needs: { os: 'linux' } }, [ws('mini')])).toBeNull()
    expect(pick({ needs: { labels: ['cargo'] } }, [ws('mini'), ws('air', { labels: ['cargo'] })])?.name).toBe('air')
    expect(pick({ needs: { host: 'carol' } }, [ws('mini'), ws('air')])).toBeNull()
    expect(pick({ needs: { host: 'air' } }, [ws('mini'), ws('air')])?.name).toBe('air')
  })

  it('бюджет: не влезает — не берётся; прибитая к машине — мимо бюджета', () => {
    const small = ws('air', { budget: { cpu: 2, mem: 4 * G, disk: 10 * G, jobs: 1 } })
    expect(pick({ needs: { cpu: 4 } }, [small])).toBeNull()
    expect(pick({ needs: { mem: 8 * G } }, [small])).toBeNull()
    const busy = ws('air', { budget: { cpu: 8, mem: 16 * G, disk: 10 * G, jobs: 1 }, running: [{ id: 'x', lease: 'l', needs: {}, started: '' }] })
    expect(pick({}, [busy])).toBeNull()
    const prod = ws('mini', { budget: { cpu: 0, mem: 0, disk: 0, jobs: 0 } })
    expect(pick({}, [prod])).toBeNull()
    expect(pick({ needs: { host: 'mini' } }, [prod])?.name).toBe('mini')
  })

  it('предохранитель и пауза — машина не берёт', () => {
    expect(pick({}, [ws('air', { guard: 'tripped' })])).toBeNull()
    expect(pick({}, [ws('air', { paused: true })])).toBeNull()
  })

  it('prod последним, потом кэш, потом свободный CPU', () => {
    const mini = ws('mini', { measure: { ...healthy, cpuFree: 12 }, cache: ['a'] })
    const air = ws('air', { measure: { ...healthy, cpuFree: 2 } })
    const carol = ws('carol', { measure: { ...healthy, cpuFree: 6 } })
    expect(pick({ pkgs: ['a'] }, [mini, air, carol], 'mini')?.name).toBe('carol')
    expect(pick({ pkgs: ['a'] }, [mini, air, ws('carol', { measure: { ...healthy, cpuFree: 1 }, cache: ['a'] })], 'mini')?.name).toBe('carol')
    expect(pick({ pkgs: ['a'] }, [air, ws('pc', { cache: ['a'], measure: { ...healthy, cpuFree: 1 } })])?.name).toBe('pc')
    expect(pick({}, [mini], 'mini')?.name).toBe('mini')
  })

  it('предохранитель по реальному замеру', () => {
    const g = { memFree: 4 * G, diskFree: 20 * G, load: 0.8 }
    expect(guardState(g, healthy)).toBe('ok')
    expect(guardState(g, { ...healthy, diskFree: 10 * G })).toBe('tripped')
    expect(guardState(g, { ...healthy, load: 0.95 })).toBe('tripped')
    expect(guardState(g, { ...healthy, memFree: 3 * G })).toBe('tripped')
    expect(guardState(g, { ...healthy, memFree: 1 * G })).toBe('deep')
  })

  it('часы машины', () => {
    const at = (h: number, m = 0): Date => new Date(2026, 9, 22, h, m)
    expect(hoursOk('always', at(12))).toBe(true)
    expect(hoursOk('22:00-08:00', at(23))).toBe(true)
    expect(hoursOk('22:00-08:00', at(7, 59))).toBe(true)
    expect(hoursOk('22:00-08:00', at(12))).toBe(false)
    expect(hoursOk('idle', at(12), () => 10)).toBe(false)
    expect(hoursOk('idle', at(12), () => 600)).toBe(true)
  })
})

describe('job.mdz и рецепт', () => {
  it('поля пула переживают запись и чтение', () => {
    const j: JobInfo = {
      id: '20261022-120000000-abcd',
      title: 't',
      target: '/x/sim.mdz',
      cwd: '/x',
      keys: ['sim'],
      values: {},
      status: 'running',
      created: '2026-10-22T10:00:00.000Z',
      pool: true,
      needs: { cpu: 8, mem: 16 * G, labels: ['cargo'], host: 'mini' },
      retries: 2,
      attempt: 1,
      worker: 'air',
      lease: 'tok',
      leaseUntil: '2026-10-22T10:01:00.000Z',
      tried: ['carol'],
      pkgs: ['code:' + 'a'.repeat(64)],
      entry: 'sim.mdz',
      entryCwd: '.',
      shard: 3,
      parent: '20261022-115959000-dcba',
    }
    const text = serializeJob(j)
    expect(text).toContain('$needs: {cpu: 8, mem: "16G", labels: ["cargo"], host: "mini"}')
    expect(parseJob(text)).toEqual(j)
  })

  it('размеры и $needs', () => {
    expect(parseSize('16G')).toBe(16 * G)
    expect(parseSize('512M')).toBe(512 * 1024 ** 2)
    expect(parseSize('nope')).toBeUndefined()
    expect(parseNeeds({ cpu: 8, mem: '16G', labels: ['cargo'] })).toEqual({ cpu: 8, mem: 16 * G, labels: ['cargo'] })
  })

  it('в пул: пакет кода, планировщик машины задачу не трогает', async () => {
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    expect(j.pool).toBe(true)
    expect(j.status).toBe('queued')
    expect(j.pkgs?.[0]).toMatch(/^code:[0-9a-f]{64}$/)
    expect(j.entry).toBe('plain.mdz')
    // Без $repeatable потеря машины не повторяется сама (kd-cli-spec §11).
    expect(j.retries).toBe(0)
    const r = await start({ dir, target: join(recipes, 'rep.mdz'), config: CFG })
    expect(r.retries).toBe(2)
    expect(r.repeatable).toBe(true)
    await tick({ dir, config: CFG })
    expect(readJob(dir, j.id)?.status).toBe('queued')
  })

  it('--on прибивает к машине', async () => {
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: { ...CFG, pool: false }, on: 'carol' })
    expect(j.pool).toBe(true)
    expect(j.needs?.host).toBe('carol')
  })
})

describe('аренда (§7)', () => {
  it('истекла — снова в очереди, попытка +1, машина помечена; поздний ответ отброшен', async () => {
    let t = Date.parse('2026-10-22T10:00:00Z')
    const c = center(() => t)
    const j = await start({ dir, target: join(recipes, 'rep.mdz'), config: CFG })
    const a = await c.claim(ws('air'))
    expect(a?.id).toBe(j.id)
    expect(readJob(dir, j.id)?.worker).toBe('air')

    // Сердцебиение продлевает.
    t += 50_000
    await c.heartbeat(ws('air', { running: [{ id: j.id, lease: a!.lease, needs: {}, started: '' }] }))
    t += 50_000
    expect((await c.dispatch()).expired).toEqual([])

    t += 61_000
    expect((await c.dispatch()).expired).toEqual([j.id])
    const q = readJob(dir, j.id)!
    expect(q.status).toBe('queued')
    expect(q.attempt).toBe(1)
    expect(q.tried).toEqual(['air'])

    const b = await c.claim(ws('carol'))
    expect(b?.id).toBe(j.id)
    expect(b?.attempt).toBe(1)
    // Старая машина вернулась с результатом — не принят, сердцебиение велит бросить.
    expect(await c.finish('air', { id: j.id, lease: a!.lease, status: 'done', output: 'stale' })).toBe(false)
    expect(await c.log('air', j.id, a!.lease, [{ stream: 'stdout', text: 'stale' }])).toBe(false)
    const hb = await c.heartbeat(ws('air', { running: [{ id: j.id, lease: a!.lease, needs: {}, started: '' }] }))
    expect(hb.drop).toEqual([j.id])
    expect(await c.finish('carol', { id: j.id, lease: b!.lease, status: 'done', output: 'fresh' })).toBe(true)
    const d = readJob(dir, j.id)!
    expect(d.status).toBe('done')
    expect(d.output).toBe('fresh')
  })

  it('$retries: 0 — потеря машины → lost', async () => {
    let t = Date.now()
    const c = center(() => t)
    const j = await start({ dir, target: join(recipes, 'one.mdz'), config: CFG })
    expect(j.retries).toBe(0)
    expect((await c.claim(ws('air')))?.id).toBe(j.id)
    t += 61_000
    await c.dispatch()
    expect(readJob(dir, j.id)?.status).toBe('lost')
  })

  it('без $repeatable — потеря машины → lost с подсказкой повтора; флаг retries — решение постановщика', async () => {
    let t = Date.now()
    const c = center(() => t)
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    expect((await c.claim(ws('air')))?.id).toBe(j.id)
    t += 61_000
    await c.dispatch()
    const d = readJob(dir, j.id)!
    expect(d.status).toBe('lost')
    expect(d.error).toMatch(/без \$repeatable.*kd job restart/)
    const forced = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG, retries: 1 })
    expect(forced.retries).toBe(1)
  })

  it('предохранитель вернул задачу — попытка не тратится', async () => {
    const c = center()
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    const a = (await c.claim(ws('air')))!
    expect(await c.giveBack('air', j.id, a.lease, 'guard')).toBe(true)
    const q = readJob(dir, j.id)!
    expect(q.status).toBe('queued')
    expect(q.attempt ?? 0).toBe(0)
  })

  it('перезапуск центра: идущим аренда заново, не истекают сразу', async () => {
    let t = Date.now()
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    const a = (await center(() => t).claim(ws('air')))!
    t += 120_000
    const c2 = center(() => t)
    expect(await c2.recover()).toEqual([j.id])
    expect((await c2.dispatch()).expired).toEqual([])
    expect(await c2.finish('air', { id: j.id, lease: a.lease, status: 'done' })).toBe(true)
  })

  it('$job_keys — лимит на весь пул', async () => {
    const c = new Center({ dir, config: { ...CFG, limits: { gemini: 1 } } })
    const a = await start({ dir, target: join(recipes, 'plain.mdz'), keys: ['gemini'], config: CFG })
    const b = await start({ dir, target: join(recipes, 'plain.mdz'), keys: ['gemini'], config: CFG })
    expect((await c.claim(ws('air')))?.id).toBe(a.id)
    expect(await c.claim(ws('carol'))).toBeNull()
    expect(readJob(dir, b.id)?.status).toBe('queued')
  })

  it('long-poll: ждущему воркеру задача приходит при постановке', async () => {
    const c = center()
    const p = c.claim(ws('air'), 5_000)
    await new Promise((r) => setTimeout(r, 50))
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    await c.dispatch()
    expect((await p)?.id).toBe(j.id)
  })
})

describe('кэш пакетов (§6)', () => {
  it('есть — не тянется; LRU по пределу', async () => {
    const src = join(root, 'src')
    const mk = (name: string, size: number): { sha: string; bytes: Buffer } => {
      const d = join(src, name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'f.bin'), Buffer.alloc(size, name.charCodeAt(0)))
      return pack(d)
    }
    const a = mk('a', 1)
    const b = mk('b', 1)
    const cc = mk('c', 1)
    const store = new Map([a, b, cc].map((p) => [p.sha, p.bytes]))
    let fetched = 0
    const fetch = async (sha: string): Promise<Buffer> => {
      fetched++
      return store.get(sha)!
    }
    let t = 0
    // Размер tar.gz плавает на байт (время файлов в заголовке): предел — a плюс больший из b и c,
    // чтобы a + c влезали всегда, а a + b + c — никогда.
    const cache = new PkgCache(join(root, 'cache'), a.bytes.length + Math.max(b.bytes.length, cc.bytes.length), () => ++t)
    await cache.ensure(a.sha, fetch)
    await cache.ensure(a.sha, fetch)
    expect(fetched).toBe(1)
    expect(readFileSync(join(cache.path(a.sha), 'f.bin')).length).toBe(1)
    await cache.ensure(b.sha, fetch)
    await cache.ensure(a.sha, fetch) // a свежее b
    await cache.ensure(cc.sha, fetch)
    expect(cache.has(a.sha)).toBe(true)
    expect(cache.has(b.sha)).toBe(false)
    expect(cache.has(cc.sha)).toBe(true)
    expect(fetched).toBe(3)
  })

  it('один и тот же код — один хэш', () => {
    const d1 = join(root, 'd1')
    const d2 = join(root, 'd2')
    for (const d of [d1, d2]) {
      mkdirSync(join(d, 'sub'), { recursive: true })
      writeFileSync(join(d, 'sub', 'x.txt'), 'x')
      writeFileSync(join(d, 'y.txt'), 'y')
    }
    expect(pack(d1).sha).toBe(pack(d2).sha)
    writeFileSync(join(d2, 'y.txt'), 'z')
    expect(pack(d1).sha).not.toBe(pack(d2).sha)
  })
})

/** Исполнитель-фейк: шард пишет `out/part.txt` (сумма сидов диапазона), склейка суммирует. */
const fakeExec = (delayMs: number | (() => number) = 0, seen: Assignment[] = []): Executor => async (t) => {
  seen.push(t.assignment)
  const out = String(t.values.out ?? join(t.work, 'out'))
  mkdirSync(out, { recursive: true })
  await new Promise<void>((r) => {
    if (t.signal.aborted) return r()
    const timer = setTimeout(r, typeof delayMs === 'function' ? delayMs() : delayMs)
    t.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      r()
    }, { once: true })
  })
  if (t.signal.aborted) return { status: 'cancelled', exit: null, output: '', outputs: [], ms: 0 }
  t.onLine('stdout', `run ${t.assignment.id} shard=${t.env.RUNZ_SHARD ?? '-'}`)
  if (t.env.RUNZ_SHARD !== undefined) {
    const i = Number(t.env.RUNZ_SHARD)
    const n = Number(t.env.RUNZ_SHARDS)
    let sum = 0
    for (let seed = i; seed < 1000; seed += n) sum += seed
    writeFileSync(join(out, 'part.txt'), String(sum))
    return { status: 'done', exit: 0, output: `part ${sum}`, outputs: [join(out, 'part.txt')], ms: 1 }
  }
  const inputs = join(t.work, 'inputs')
  if (existsSync(inputs) && readdirSync(inputs).some((n) => n.startsWith('shard-'))) {
    let total = 0
    for (const s of readdirSync(inputs)) total += Number(readFileSync(join(inputs, s, 'part.txt'), 'utf8'))
    writeFileSync(join(out, 'total.txt'), String(total))
    return { status: 'done', exit: 0, output: `total ${total}`, outputs: [join(out, 'total.txt')], ms: 1 }
  }
  writeFileSync(join(out, 'ok.txt'), 'ok')
  return { status: 'done', exit: 0, output: 'ok', outputs: [join(out, 'ok.txt')], ms: 1 }
}

function worker(c: Center, name: string, exec: Executor, over: { measure?: () => Measure; budget?: Partial<WorkerState['budget']> } = {}): Worker {
  const cfg = { ...defaultWorkerConfig(), name, root: join(root, 'w', name) }
  cfg.budget = { cpu: 8, mem: 16 * G, disk: 1 * G, jobs: 2, ...over.budget }
  return new Worker({ config: cfg, client: localPoolClient(c), exec, measure: over.measure ?? (() => healthy) })
}

async function drain(c: Center, ws_: Worker[], until: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !until(); i++) {
    await c.dispatch()
    for (const w of ws_) {
      await w.heartbeat()
      await w.claimOnce().catch(() => null)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  for (const w of ws_) await w.idle()
}

describe('шарды (§8)', () => {
  it('шарды по машинам → $merge с выходами всех; итог равен одной машине', async () => {
    const c = center()
    const parent = await start({ dir, target: join(recipes, 'sim.mdz'), config: CFG, values: { out: join(root, 'result') } })
    expect(parent.shards).toBe(4)
    expect(parent.status).toBe('running')
    const kids = list({ dir }).filter((j) => j.parent === parent.id)
    expect(kids).toHaveLength(4)
    expect(kids.every((k) => k.keys[0] === 'sim' && k.needs?.cpu === 2)).toBe(true)

    const seenA: Assignment[] = []
    const seenB: Assignment[] = []
    const a = worker(c, 'air', fakeExec(20, seenA))
    const b = worker(c, 'carol', fakeExec(20, seenB))
    await drain(c, [a, b], () => get(parent.id, { dir })?.status === 'done')

    const p = get(parent.id, { dir })!
    expect(p.status).toBe('done')
    expect(p.shardsDone).toBe(4)
    expect(p.output).toBe(`total ${(999 * 1000) / 2}`)
    expect(readFileSync(join(root, 'result', 'total.txt'), 'utf8')).toBe(String((999 * 1000) / 2))
    expect(p.outputs).toEqual([join(root, 'result', 'total.txt')])
    expect(seenA.length).toBeGreaterThan(0)
    expect(seenB.length).toBeGreaterThan(0)
    const merge = get(p.mergeJob!, { dir })!
    expect(merge.status).toBe('done')
    // Лог шарда — у центра, кадры с машиной.
    const log = readFileSync(join(dir, kids[0]!.id, 'log.ndjson'), 'utf8')
    expect(log).toMatch(/"worker":"(air|carol)"/)
  })

  it('упавший шард — родитель failed', async () => {
    const c = center()
    const parent = await start({ dir, target: join(recipes, 'sim.mdz'), config: CFG, shards: 2 })
    const bad: Executor = async (t) => (t.env.RUNZ_SHARD === '1' ? { status: 'failed', exit: 1, output: '', outputs: [], error: 'boom', ms: 1 } : fakeExec()(t))
    await drain(c, [worker(c, 'air', bad)], () => get(parent.id, { dir })?.status === 'failed')
    expect(get(parent.id, { dir })?.error).toContain('шард 1')
  })
})

describe('воркер', () => {
  it('предохранитель глубоко пробит — задача остановлена и вернулась без траты попытки', async () => {
    const c = center()
    let m: Measure = healthy
    let delay = 10_000
    const w = worker(c, 'air', fakeExec(() => delay), { measure: () => m })
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    expect(await w.claimOnce()).toBe(j.id)
    m = { ...healthy, memFree: 1 * G }
    await w.heartbeat()
    await w.idle()
    const q = readJob(dir, j.id)!
    expect(q.status).toBe('queued')
    expect(q.attempt ?? 0).toBe(0)
    // Под предохранителем новое не берёт.
    expect(await w.claimOnce()).toBeNull()
    m = healthy
    delay = 0
    expect(await w.claimOnce()).toBe(j.id)
    await w.idle()
    expect(readJob(dir, j.id)?.status).toBe('done')
  })

  it('центр недоступен — конец ждёт в outbox и уходит позже', async () => {
    const c = center()
    const real = localPoolClient(c)
    let down = false
    const client = { ...real, finish: async (...args: Parameters<typeof real.finish>) => (down ? Promise.reject(new Error('down')) : real.finish(...args)) }
    const cfg = { ...defaultWorkerConfig(), name: 'air', root: join(root, 'w', 'air') }
    const w = new Worker({ config: cfg, client, exec: fakeExec(), measure: () => healthy })
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG, values: { out: join(root, 'o') } })
    down = true
    await w.claimOnce()
    await w.idle()
    expect(w.pending()).toBe(1)
    expect(readJob(dir, j.id)?.status).toBe('running')
    down = false
    await w.heartbeat()
    expect(w.pending()).toBe(0)
    expect(readJob(dir, j.id)?.status).toBe('done')
    expect(readFileSync(join(root, 'o', 'ok.txt'), 'utf8')).toBe('ok')
  })

  it('пауза центра — новое не берёт', async () => {
    const c = center()
    const w = worker(c, 'air', fakeExec())
    await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    c.pause('air')
    await w.heartbeat()
    expect(await w.claimOnce()).toBeNull()
    c.pause('air', false)
    await w.heartbeat()
    expect(await w.claimOnce()).not.toBeNull()
    await w.idle()
  })

  it('отмена из реестра доходит до машины', async () => {
    const c = center()
    const w = worker(c, 'air', fakeExec(10_000))
    const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG })
    await w.claimOnce()
    const { cancel } = await import('../src/jobs/index.js')
    await cancel(j.id, { dir, config: CFG, waitMs: 0 })
    await w.heartbeat()
    await w.idle()
    expect(readJob(dir, j.id)?.status).toBe('cancelled')
  })
})

describe('runz на машине', () => {
  it('значения материализуются, входы и out — каталог задачи воркера, шард видит RUNZ_SHARD', async () => {
    const bin = join(root, 'fake-runz.mjs')
    writeFileSync(
      bin,
      `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const v = {}
for (const l of text.split('\\n')) {
  if (l.startsWith('## ')) break
  const m = /^\\$(\\w+): (.*)$/.exec(l)
  if (m) v[m[1]] = m[2].replace(/^"|"$/g, '')
}
mkdirSync(v.out, { recursive: true })
const p = v.out + '/r.txt'
writeFileSync(p, 'shard=' + process.env.RUNZ_SHARD + ' in=' + readFileSync(v.src, 'utf8'))
console.log('step')
process.stdout.write(JSON.stringify({ output: 'ok', outputs: [{ type: 'file', path: p }] }) + '\\n')
`,
    )
    writeFileSync(join(recipes, 'job.mdz'), '$out: ./o\n$src: x\n\n## run\nx\n')
    const c = center()
    const cfg = { ...defaultWorkerConfig(), name: 'air', root: join(root, 'w', 'air') }
    const w = new Worker({ config: cfg, client: localPoolClient(c), exec: runzExecutor([process.execPath, bin]), measure: () => healthy })
    const parent = await start({ dir, target: join(recipes, 'job.mdz'), config: CFG, shards: 1, values: { src: 'inputs/a.txt' }, files: [{ name: 'a.txt', text: 'hello' }] })
    await drain(c, [w], () => get(parent.id, { dir })?.status === 'done')
    const p = get(parent.id, { dir })!
    expect(p.status).toBe('done')
    const kid = list({ dir }).find((j) => j.parent === parent.id)!
    expect(kid.outputs).toEqual([join(dir, kid.id, 'out', 'r.txt')])
    expect(readFileSync(kid.outputs![0]!, 'utf8')).toBe('shard=0 in=hello')
    expect(readFileSync(join(dir, kid.id, 'log.ndjson'), 'utf8')).toContain('"text":"step"')
  })
})

describe('HTTP центра', () => {
  it('ключи, пакеты, лог и выходы через сеть', async () => {
    const c = center()
    const srv = await servePool(c, { keys: { air: 'k-air' } })
    try {
      expect((await fetch(`${srv.url}/v1/workers`)).status).toBe(401)
      const cfg = { ...defaultWorkerConfig(), name: 'air', root: join(root, 'w', 'air') }
      const w = new Worker({ config: cfg, client: httpPoolClient(srv.url, 'k-air'), exec: fakeExec(), measure: () => healthy })
      const j = await start({ dir, target: join(recipes, 'plain.mdz'), config: CFG, values: { out: join(root, 'net') } })
      expect(await w.claimOnce()).toBe(j.id)
      await w.idle()
      const d = readJob(dir, j.id)!
      expect(d.status).toBe('done')
      expect(d.worker).toBe('air')
      expect(readFileSync(join(root, 'net', 'ok.txt'), 'utf8')).toBe('ok')
      expect(w.cache.list()).toHaveLength(1)
      const workers = (await (await fetch(`${srv.url}/v1/workers`, { headers: { authorization: 'Bearer k-air' } })).json()) as { name: string; alive: boolean }[]
      expect(workers.map((x) => [x.name, x.alive])).toEqual([['air', true]])
    } finally {
      await srv.close()
    }
  })
})
