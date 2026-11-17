#!/usr/bin/env node
// Ссылки потребителя на пакеты kd без npm install: в каждой папке репы с package.json, где есть зависимости
// `@kerneldreams/*`, ставит node_modules/@kerneldreams/<x> → <kd>/packages/<x> (plugin-api → <nrchat>/packages/plugin-api).
// node_modules-симлинк (worktree хаба задач) превращается в папку-зеркало: записи — ссылки на прежнюю цель.
// Прочие зависимости `file:` (приватные пакеты потребителя) — ссылкой на цель пути, если цель есть; остальные записи
// node_modules не трогает — их ведёт npm install потребителя.
//
//   node scripts/link.mjs --repo=<путь> [--kd=<корень kd>] [--nrchat=<корень nrchat>] [--dry]
//
// После слияния переезда в основные копии: `npm install && npm run build` в ~/Studio/kd, затем link.mjs по
// каждому потребителю (или npm install в нём).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { KD_ROOT, SCOPE } from './lib/repo.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true] }))
if (!args.repo) { console.error('link: --repo=<путь>'); process.exit(1) }
const repo = path.resolve(String(args.repo))
const kd = path.resolve(String(args.kd ?? KD_ROOT))
const nrchat = path.resolve(String(args.nrchat ?? path.join(os.homedir(), 'Studio', 'Projects', 'nrchat')))
const dry = !!args.dry

function targetOf(name) {
  if (name === `${SCOPE}/plugin-api`) return path.join(nrchat, 'packages', 'plugin-api')
  return path.join(kd, 'packages', name.slice(SCOPE.length + 1))
}

/** node_modules-симлинк → папка, где каждая запись — ссылка на запись прежней цели. */
function unfoldLinkedModules(nm) {
  const target = fs.realpathSync(nm)
  if (dry) return
  fs.unlinkSync(nm)
  fs.mkdirSync(nm)
  for (const name of fs.readdirSync(target)) {
    const src = path.join(target, name)
    if (name.startsWith('@') && fs.lstatSync(src).isDirectory()) {
      fs.mkdirSync(path.join(nm, name))
      for (const sub of fs.readdirSync(src)) fs.symlinkSync(path.join(src, sub), path.join(nm, name, sub))
    } else fs.symlinkSync(src, path.join(nm, name))
  }
}

const top = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const manifests = execFileSync('git', ['-C', top, 'ls-files', '-z', '--', 'package.json', '**/package.json'], { encoding: 'utf8' })
  .split('\0').filter((f) => f && !/(^|\/)node_modules\//.test(f))
let linked = 0
const missing = []
for (const m of manifests) {
  const dir = path.join(top, path.dirname(m))
  if (!dir.startsWith(repo) && repo !== top) continue
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(path.join(top, m), 'utf8')) } catch { continue }
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const names = new Set(sections.flatMap((s) => Object.keys(pkg[s] ?? {})).filter((n) => n.startsWith(SCOPE + '/')))
  /** `file:`-зависимости не из kd: имя → цель пути от папки манифеста. */
  const files = new Map(sections.flatMap((s) => Object.entries(pkg[s] ?? {})).filter(([n, v]) => !n.startsWith(SCOPE + '/') && typeof v === 'string' && v.startsWith('file:')).map(([n, v]) => [n, path.resolve(dir, v.slice(5))]))
  if (!names.size && !files.size) continue
  const nm = path.join(dir, 'node_modules')
  if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) unfoldLinkedModules(nm)
  for (const n of [...names, ...files.keys()]) {
    const t = files.get(n) ?? targetOf(n)
    if (!fs.existsSync(path.join(t, 'package.json'))) { missing.push(`${m}: ${n} → ${t}`); continue }
    const dst = path.join(nm, n)
    let cur = null
    try { cur = fs.realpathSync(dst) } catch { /* нет */ }
    if (cur === fs.realpathSync(t)) continue
    if (!dry) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.rmSync(dst, { recursive: true, force: true })
      fs.symlinkSync(t, dst)
    }
    linked++
  }
}
console.log(`link: ${top} — ссылок ${linked}${dry ? ' (сухой прогон)' : ''}${missing.length ? `; нет цели: ${missing.length}` : ''}`)
for (const l of missing) console.log(`  нет: ${l}`)
if (missing.length) process.exitCode = 1
