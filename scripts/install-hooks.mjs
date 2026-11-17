#!/usr/bin/env node
// Копирует .githooks/pre-push в .git/hooks клона (kd-repo-spec §1.4: копией, не core.hooksPath —
// настройкой не выключить). Ставится на машине публикации; обход — git push --no-verify, только owner.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { KD_ROOT } from './lib/repo.mjs'

const hooksDir = path.resolve(KD_ROOT, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: KD_ROOT, encoding: 'utf8' }).trim())
fs.mkdirSync(hooksDir, { recursive: true })
const dst = path.join(hooksDir, 'pre-push')
const src = path.join(KD_ROOT, '.githooks', 'pre-push')
// Хук зовёт стража явным режимом: guard.mjs --pre-push <remote> <url> (без флага guard проверяет рабочее дерево).
if (!/guard\.mjs"? --pre-push "\$@"/.test(fs.readFileSync(src, 'utf8'))) {
  console.error('hooks: .githooks/pre-push должен звать scripts/guard.mjs --pre-push "$@"')
  process.exit(1)
}
fs.copyFileSync(src, dst)
fs.chmodSync(dst, 0o755)
console.log(`hooks: pre-push → ${dst}`)
