#!/usr/bin/env node
// Публикация kd (kd-repo-spec §2): снимок master → GitHub main (родитель — прошлый github/main), затем по --npm —
// npm publish --workspaces. Запускает только owner или ствол по его слову. Без --yes — сухой прогон.
//   node scripts/publish.mjs --notes="что изменилось" [--npm] [--yes]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { KD_ROOT, readJson } from './lib/repo.mjs'
import { scanTree } from './guard.mjs'

const argv = process.argv.slice(2)
const flag = (k) => argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
const val = (k) => flag(k)?.split('=').slice(1).join('=')
const yes = !!flag('yes')
const git = (...a) => execFileSync('git', a, { cwd: KD_ROOT, encoding: 'utf8' }).trim()
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: KD_ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} — код ${r.status}`)
}

const version = readJson(path.join(KD_ROOT, 'package.json')).version
const notes = val('notes')
if (!notes) { console.error('publish: --notes="человеческий список изменений" обязателен'); process.exit(1) }
if (git('status', '--porcelain')) { console.error('publish: рабочая копия грязная'); process.exit(1) }

// 1. сборка, тесты, страж
run('npm', ['run', 'build'])
run('npm', ['test'])
const hits = scanTree('HEAD')
if (hits.length) { console.error(`publish: дерево HEAD не чистое (${hits.length}) — node scripts/guard.mjs --tree HEAD -v`); process.exit(1) }

// 2. снимок: дерево master, родитель — github/main
const tree = git('rev-parse', 'HEAD^{tree}')
let parent = ''
try { git('fetch', 'github', 'main'); parent = git('rev-parse', 'github/main') } catch { /* первая публикация */ }
const msg = `v${version}\n\n${notes}`
console.log(`publish: снимок дерева ${tree.slice(0, 8)} поверх ${parent ? parent.slice(0, 8) : '(пусто)'} — v${version}`)
if (!yes) { console.log('publish: сухой прогон (--yes — по-настоящему)'); process.exit(0) }
const snap = execFileSync('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg], { cwd: KD_ROOT, encoding: 'utf8' }).trim()
run('git', ['push', 'github', `${snap}:refs/heads/main`])
run('git', ['tag', `v${version}`, snap])
run('git', ['push', 'github', `v${version}`])

// 3. npm — токен из ~/.runz/config.md во временный .npmrc процесса, не в git и не в вывод
if (flag('npm')) {
  const cfg = fs.readFileSync(path.join(os.homedir(), '.runz', 'config.md'), 'utf8')
  const token = cfg.match(/\$npm_token_kerneldreams:\s*(\S+)/)?.[1]
  if (!token) throw new Error('publish: нет $npm_token_kerneldreams в ~/.runz/config.md')
  const rc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kd-publish-')), '.npmrc')
  fs.writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 })
  try { run('npm', ['publish', '--workspaces', '--access', 'public'], { NPM_CONFIG_USERCONFIG: rc }) } finally { fs.rmSync(path.dirname(rc), { recursive: true, force: true }) }
}
console.log(`publish: v${version} готово`)
