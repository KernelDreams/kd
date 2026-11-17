#!/usr/bin/env node
// Тесты пакетов kd по очереди (корень vitest — папка пакета). Итог — список упавших; код 1, если есть.
//   node scripts/test.mjs [dir …] [--skip=dir,dir]
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { KD_ROOT, readJson } from './lib/repo.mjs'

const argv = process.argv.slice(2)
const ord = readJson(path.join(KD_ROOT, 'build-order.json'))
const want = argv.filter((a) => !a.startsWith('--'))
const skip = new Set((argv.find((a) => a.startsWith('--skip='))?.split('=')[1] ?? '').split(',').filter(Boolean))
const list = (want.length ? ord.filter((d) => want.includes(d)) : ord).filter((d) => !skip.has(d))

const failed = []
for (const dir of list) {
  const pkg = readJson(path.join(KD_ROOT, 'packages', dir, 'package.json'))
  if (!pkg.scripts?.test) { console.log(`· ${dir}: тестов нет`); continue }
  const isVitest = /\bvitest run\b/.test(pkg.scripts.test)
  const args = isVitest ? ['exec', '--', 'vitest', 'run', '--reporter=dot'] : ['test', '--silent']
  const t = Date.now()
  const r = spawnSync('npm', args, { cwd: path.join(KD_ROOT, 'packages', dir), encoding: 'utf8', env: { ...process.env, CI: '1' }, maxBuffer: 64 << 20 })
  const out = (r.stdout + r.stderr).split('\n')
  const summary = out.filter((l) => /Test Files|Tests\s|# (pass|fail)|passed|failed/.test(l)).slice(-3).join(' | ').replace(/\s+/g, ' ')
  if (r.status !== 0) {
    failed.push(dir)
    console.log(`✗ ${dir} ${((Date.now() - t) / 1000).toFixed(0)}s ${summary}`)
    console.log(out.filter((l) => /FAIL|Error|✗|×/.test(l)).slice(0, 15).map((l) => '    ' + l.trim()).join('\n'))
  } else console.log(`✓ ${dir} ${((Date.now() - t) / 1000).toFixed(0)}s ${summary}`)
}
if (failed.length) { console.error(`\ntest: упали ${failed.length}: ${failed.join(', ')}`); process.exit(1) }
console.log(`\ntest: ${list.length} пакетов зелёные`)
