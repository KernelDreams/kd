#!/usr/bin/env node
// Граф рабочей области kd → build-order.json (топологический порядок по внутренним зависимостям).
//   node scripts/build-order.mjs           пересобрать build-order.json
//   node scripts/build-order.mjs --check   проверить: нет циклов и файл совпадает с графом (код 1 — нет)
//   node scripts/build-order.mjs --affected=<dir,dir>  пакеты и все их потребители в порядке сборки
import fs from 'node:fs'
import path from 'node:path'
import { KD_ROOT, workspacePackages } from './lib/repo.mjs'

export function graph(root = KD_ROOT) {
  const pkgs = workspacePackages(root)
  const byName = new Map(pkgs.map((p) => [p.pkg.name, p]))
  // Рёбра: dependencies / peer / optional — всегда; devDependencies (нужны тестам) — если не дают цикла.
  const edges = (p, secs) => secs.flatMap((s) => Object.keys(p.pkg[s] ?? {})).filter((n) => n !== p.pkg.name && byName.has(n)).map((n) => byName.get(n).dir)
  const deps = new Map()
  for (const p of pkgs) deps.set(p.dir, [...new Set(edges(p, ['dependencies', 'peerDependencies', 'optionalDependencies']))])
  const devOnly = []
  for (const p of pkgs) for (const d of edges(p, ['devDependencies'])) if (!deps.get(p.dir).includes(d)) {
    deps.get(p.dir).push(d)
    try { order(deps) } catch { deps.get(p.dir).pop(); devOnly.push(`${p.dir} → ${d}`) }
  }
  return { pkgs, deps, devOnly }
}

/** Топологический порядок (Кан, при равенстве — по алфавиту); цикл — исключение со списком. */
export function order(deps) {
  const indeg = new Map([...deps.keys()].map((k) => [k, 0]))
  const users = new Map([...deps.keys()].map((k) => [k, []]))
  for (const [k, ds] of deps) for (const d of ds) { indeg.set(k, indeg.get(k) + 1); users.get(d).push(k) }
  const ready = [...indeg].filter(([, n]) => n === 0).map(([k]) => k).sort()
  const out = []
  while (ready.length) {
    const k = ready.shift()
    out.push(k)
    for (const u of users.get(k)) {
      indeg.set(u, indeg.get(u) - 1)
      if (indeg.get(u) === 0) { ready.push(u); ready.sort() }
    }
  }
  if (out.length !== deps.size) {
    const left = [...deps.keys()].filter((k) => !out.includes(k))
    throw new Error(`цикл зависимостей среди: ${left.join(', ')}`)
  }
  return out
}

/** Пакеты из списка и все, кто от них зависит транзитивно, — в порядке сборки. */
export function affected(deps, dirs) {
  const users = new Map([...deps.keys()].map((k) => [k, []]))
  for (const [k, ds] of deps) for (const d of ds) users.get(d).push(k)
  const hit = new Set()
  const walk = (d) => { if (hit.has(d) || !deps.has(d)) return; hit.add(d); for (const u of users.get(d)) walk(u) }
  for (const d of dirs) walk(d)
  return order(deps).filter((d) => hit.has(d))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const arg = (k) => process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  const file = path.join(KD_ROOT, 'build-order.json')
  const { deps, devOnly: devCycles } = graph()
  let ord
  try { ord = order(deps) } catch (e) { console.error(`build-order: ${e.message}`); process.exit(1) }
  if (arg('affected')) {
    const dirs = arg('affected').split('=')[1]?.split(',').filter(Boolean) ?? []
    console.log(affected(deps, dirs).join('\n'))
  } else if (arg('check')) {
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    if (JSON.stringify(cur) !== JSON.stringify(ord)) {
      console.error('build-order: build-order.json устарел — node scripts/build-order.mjs')
      process.exit(1)
    }
    const dev = devCycles.length ? `; devDependencies вне порядка (дали бы цикл): ${devCycles.join(', ')}` : ''
    console.log(`build-order: ${ord.length} пакетов, циклов нет${dev}`)
  } else {
    fs.writeFileSync(file, JSON.stringify(ord, null, 2) + '\n')
    console.log(`build-order: ${ord.length} пакетов → build-order.json`)
  }
}
