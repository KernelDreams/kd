#!/usr/bin/env node
// Единая версия kd: пишет версию в корень, во все packages/*/package.json и во внутренние зависимости (точная).
//   node scripts/version.mjs 0.2.0
//   node scripts/version.mjs --check   все пакеты и внутренние зависимости на версии корня (код 1 — нет)
import fs from 'node:fs'
import path from 'node:path'
import { KD_ROOT, SCOPE, readJson, writeJson, workspacePackages } from './lib/repo.mjs'

const arg = process.argv[2]
const rootFile = path.join(KD_ROOT, 'package.json')
const root = readJson(rootFile)
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

if (arg === '--check') {
  const bad = []
  for (const p of workspacePackages()) {
    if (p.pkg.version !== root.version) bad.push(`${p.dir}: version ${p.pkg.version}`)
    for (const s of SECTIONS) for (const [n, v] of Object.entries(p.pkg[s] ?? {})) {
      if (n.startsWith(SCOPE + '/') && v !== root.version) bad.push(`${p.dir}: ${s} ${n}@${v}`)
    }
  }
  if (bad.length) { console.error(`version: не на ${root.version}:\n  ${bad.join('\n  ')}`); process.exit(1) }
  console.log(`version: все пакеты на ${root.version}`)
  process.exit(0)
}

if (!arg || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
  console.error('version: node scripts/version.mjs <x.y.z> | --check')
  process.exit(1)
}
root.version = arg
writeJson(rootFile, root)
for (const p of workspacePackages()) {
  p.pkg.version = arg
  for (const s of SECTIONS) for (const n of Object.keys(p.pkg[s] ?? {})) if (n.startsWith(SCOPE + '/')) p.pkg[s][n] = arg
  writeJson(path.join(p.abs, 'package.json'), p.pkg)
  // версия, зашитая в код пакета (src/version.ts: export const VERSION = 'x.y.z') — та же
  const vf = path.join(p.abs, 'src', 'version.ts')
  if (fs.existsSync(vf)) fs.writeFileSync(vf, fs.readFileSync(vf, 'utf8').replace(/(export const VERSION = ')[^']*(')/, (_, a, b) => a + arg + b))
}
console.log(`version: ${arg} — корень и ${workspacePackages().length} пакетов; дальше npm install (обновит lock)`)
