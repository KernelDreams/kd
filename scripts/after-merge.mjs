#!/usr/bin/env node
// После слияния переезда в kd — основные копии студии на новую раскладку, без правки кода:
//   1. kd: npm install (если нет node_modules или --install) и npm run build;
//   2. каждому потребителю с зависимостями @kerneldreams/* — ссылки node_modules (scripts/link.mjs);
//   3. nrchat: пакет Plugin API заново (node scripts/plugin-api-pack.ts) — внешние плагины собираются от него.
// Плагины, lab, сборщик приложений (mini: клон kd + npm install) — дальше руками, список печатается в конце.
//
//   node scripts/after-merge.mjs [--studio=~/Studio] [--install] [--dry]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { KD_ROOT } from './lib/repo.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true] }))
const STUDIO = path.resolve(String(args.studio ?? path.join(os.homedir(), 'Studio')))
const dry = !!args.dry
const SKIP = /^(\.worktrees|archive|data|node_modules|kd)(\/|$)|\/node_modules(\/|$)|(^|\/)\.archive(\/|$)/

function step(cmd, argv, cwd) {
  console.log(`$ (${path.relative(STUDIO, cwd) || '.'}) ${cmd} ${argv.join(' ')}`)
  if (dry) return
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit' })
  if (r.status !== 0) { console.error(`after-merge: ${cmd} ${argv.join(' ')} — код ${r.status}`); process.exit(1) }
}

// 1. kd
if (args.install || !fs.existsSync(path.join(KD_ROOT, 'node_modules'))) step('npm', ['install', '--no-audit', '--no-fund'], KD_ROOT)
step('node', ['scripts/build.mjs'], KD_ROOT)

// 2. потребители: git-репы студии, где package.json называет @kerneldreams/*
const repos = execFileSync('find', [STUDIO, '-maxdepth', '5', '-name', '.git', '-not', '-path', '*/node_modules/*'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).map((g) => path.dirname(g)).filter((d) => !SKIP.test(path.relative(STUDIO, d)))
let n = 0
for (const r of repos.sort()) {
  let hit = false
  try {
    hit = execFileSync('git', ['-C', r, 'grep', '-l', '"@kerneldreams/', '--', 'package.json', '**/package.json'], { encoding: 'utf8' }).trim() !== ''
  } catch { /* нет совпадений */ }
  if (!hit) continue
  // замороженная репа (переехала, в корне MOVED.md) — не потребитель: её ссылки смотрят на прежние места
  if (fs.existsSync(path.join(r, 'MOVED.md'))) continue
  n++
  step('node', [path.join(KD_ROOT, 'scripts', 'link.mjs'), `--repo=${r}`, ...(dry ? ['--dry'] : [])], KD_ROOT)
}
console.log(`after-merge: потребителей ${n}`)

// 3. Plugin API
const nrchat = path.join(STUDIO, 'Projects', 'nrchat')
if (fs.existsSync(path.join(nrchat, 'scripts', 'plugin-api-pack.ts'))) step('node', ['scripts/plugin-api-pack.ts'], nrchat)

console.log(`
дальше руками:
  - внешние плагины: npm run build в каждой Projects/nrchat-plugins/<id> (dist — с @kerneldreams/*);
  - lab: runz host restart lab, runz host status;
  - сборщик приложений (mini): git clone kerneldreams/kd в ~/Studio/kd, npm install (срез релиза берёт его node_modules);
  - prod — только runz release по слову owner.`)
