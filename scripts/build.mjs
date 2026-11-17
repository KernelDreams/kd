#!/usr/bin/env node
// Сборка пакетов kd по build-order.json: `npm run build -w packages/<dir>` по очереди, падение — сразу.
//   node scripts/build.mjs                 все
//   node scripts/build.mjs nrd tools       только эти (в порядке build-order)
//   node scripts/build.mjs --affected=nrd  nrd и все его потребители
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { KD_ROOT, readJson } from './lib/repo.mjs'
import { affected, graph } from './build-order.mjs'

const argv = process.argv.slice(2)
const ord = readJson(path.join(KD_ROOT, 'build-order.json'))
let list = ord
const aff = argv.find((a) => a.startsWith('--affected='))
if (aff) list = affected(graph().deps, aff.split('=')[1].split(',').filter(Boolean))
else if (argv.filter((a) => !a.startsWith('--')).length) {
  const want = new Set(argv.filter((a) => !a.startsWith('--')))
  for (const w of want) if (!ord.includes(w)) { console.error(`build: нет пакета ${w}`); process.exit(1) }
  list = ord.filter((d) => want.has(d))
}

const t0 = Date.now()
for (const dir of list) {
  const pkg = readJson(path.join(KD_ROOT, 'packages', dir, 'package.json'))
  if (!pkg.scripts?.build) { console.log(`· ${dir}: сборки нет`); continue }
  const t = Date.now()
  const r = spawnSync('npm', ['run', 'build', '--silent'], { cwd: path.join(KD_ROOT, 'packages', dir), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) {
    process.stdout.write(r.stdout.split('\n').slice(-40).join('\n'))
    process.stderr.write(r.stderr.split('\n').slice(-40).join('\n'))
    console.error(`\n✗ ${dir}: сборка упала (код ${r.status})`)
    process.exit(1)
  }
  console.log(`✓ ${dir} ${((Date.now() - t) / 1000).toFixed(1)}s`)
}
console.log(`build: ${list.length} пакетов за ${((Date.now() - t0) / 1000).toFixed(0)}s`)
if (!fs.existsSync(path.join(KD_ROOT, 'node_modules'))) console.warn('build: нет node_modules — сначала npm install в корне kd')
