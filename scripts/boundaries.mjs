#!/usr/bin/env node
// Страж импортов kd: пакет импортирует только пакеты kd и зависимости npm из своего package.json; запрещены
// зависимость `file:` за пределы репы (приватные пакеты, приложение) и относительный путь за пределы своей папки.
// Исключения — scripts/boundaries-allow.json (каждое с причиной и сроком).
//   node scripts/boundaries.mjs [--json]
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { KD_ROOT, SCOPE, packageOf, readJson, workspacePackages } from './lib/repo.mjs'
import { listImports } from './lib/specifiers.mjs'

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'fixtures', 'json5-suite', 'vendor', 'public', 'assets', 'spike', 'templates'])
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out) }
    else if (CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.join(dir, e.name))
  }
  return out
}

const allowFile = path.join(KD_ROOT, 'scripts', 'boundaries-allow.json')
const allow = fs.existsSync(allowFile) ? readJson(allowFile).allow ?? [] : []
const allowed = (dir, spec) => allow.some((a) => a.package === dir && (a.import === spec || a.import === packageOf(spec)))

const pkgs = workspacePackages()
const kdNames = new Set(pkgs.map((p) => p.pkg.name))
const problems = []
const used = new Set()
for (const p of pkgs) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const declared = new Set(sections.flatMap((s) => Object.keys(p.pkg[s] ?? {})))
  // зависимость, которая ведёт наружу репы: `file:`/`link:` вне kd, или чужой скоуп не из npm
  for (const sec of sections) {
    for (const [name, spec] of Object.entries(p.pkg[sec] ?? {})) {
      if (typeof spec !== 'string') continue
      const local = /^(file|link):/.test(spec)
      if (local && !path.resolve(p.abs, spec.replace(/^(file|link):/, '')).startsWith(KD_ROOT + path.sep)) {
        problems.push({ dir: p.dir, file: path.relative(KD_ROOT, path.join(p.abs, 'package.json')), spec: `${name}: ${spec}`, why: 'зависимость за пределы репы kd' })
      } else if (name.startsWith(SCOPE + '/') && local) {
        problems.push({ dir: p.dir, file: path.relative(KD_ROOT, path.join(p.abs, 'package.json')), spec: `${name}: ${spec}`, why: 'пакет kd — версией рабочей области, не путём' })
      }
    }
  }
  for (const file of walk(p.abs)) {
    // строки комментариев (` * …`, `// …`) — не импорты
    const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    const relFile = path.relative(KD_ROOT, file)
    for (let spec of listImports(text)) {
      spec = spec.split('?')[0]
      if (!spec || spec.includes('${') || /^(https?|data|virtual|file):/.test(spec) || spec.startsWith('#')) continue
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec)
        if (!target.startsWith(p.abs + path.sep) && target !== p.abs) problems.push({ dir: p.dir, file: relFile, spec, why: 'относительный путь за пределы пакета' })
        continue
      }
      if (spec.startsWith('/')) continue
      if (BUILTIN.has(spec) || BUILTIN.has(spec.split('/')[0])) continue
      const name = packageOf(spec)
      if (name === p.pkg.name) continue
      if (allowed(p.dir, spec)) { used.add(`${p.dir}:${name}`); continue }
      if (!declared.has(name) && !declared.has(`@types/${name}`)) {
        problems.push({ dir: p.dir, file: relFile, spec, why: kdNames.has(name) ? 'пакет kd не объявлен в package.json' : 'зависимость не объявлена в package.json' })
      }
    }
  }
}

const stale = allow.filter((a) => !used.has(`${a.package}:${packageOf(a.import)}`))
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ problems, stale }, null, 2))
} else {
  for (const pr of problems) console.log(`${pr.file}: ${pr.spec} — ${pr.why}`)
  for (const a of stale) console.log(`boundaries-allow.json: исключение ${a.package} → ${a.import} больше не нужно`)
  if (allow.length) console.log(`boundaries: исключений ${allow.length} (${allow.map((a) => `${a.package}→${a.import}`).join(', ')}) — ${allow[0].until ?? ''}`)
}
if (problems.length) { console.error(`boundaries: нарушений ${problems.length}`); process.exit(1) }
console.log(`boundaries: ${pkgs.length} пакетов, нарушений нет`)
