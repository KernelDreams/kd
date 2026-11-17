#!/usr/bin/env node
// Страж публикации kd (kd-repo-spec §1.4): следы студии в дереве.
//   node scripts/guard.mjs                     рабочее дерево (отслеживаемые и новые неигнорируемые файлы)
//   node scripts/guard.mjs --tree <ref>        дерево коммита
//     итог одной строкой: «guard: чисто» (код 0) или «guard: следов N (…)» (код 1); -v — построчно по файлам
//   node scripts/guard.mjs --pre-push <remote> <url>   хук pre-push (.githooks/pre-push): git даёт строки
//     «<local ref> <sha> <remote ref> <sha>» на stdin; на remote GitHub пускает только main и теги v*, и только
//     чистое дерево. Остальные remote — без проверки.
// Имя площадки карточек разрешено только файлам из guard-allow.txt (формат карточек).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KD_ROOT } from './lib/repo.mjs'

// Слова собираются из частей (w), чтобы сам страж не был следом: в исходнике их нет целиком.
const w = (...parts) => parts.join('')
const re = (src, flags) => new RegExp(src, flags)
const STUDIO = w('not', 'real')
const PLATFORM = w('ch', 'ub')
const HOME = w('den', 'is')

export const PATTERNS = {
  [STUDIO]: re(STUDIO, 'gi'),
  [w('Not ', 'Real')]: re(w('Not ', 'Real'), 'g'),
  [w('Jul', 'ian')]: re(w('Jul', 'ian'), 'g'),
  [w('Gar', 'rett')]: re(w('Gar', 'rett'), 'g'),
  'домен студии': re(`[\\w.-]+\\.${STUDIO}\\.studio`, 'gi'),
  '192.168.': /192\.168\.\d+\.\d+/g,
  tailnet: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
  [`/home/${HOME}`]: re(`/home/${HOME}`, 'g'),
  [`/Users/${HOME}`]: re(`/Users/${HOME}`, 'g'),
  'номер задачи': /\b(?:DEV|NOT|SLOT|NRP|BOT|FAR|LIFE|DUK|TRM|EH|ART|GMB)-\d+\b/g,
  [w('gm', 'bl')]: re(`\\b${w('gm', 'bl')}\\b`, 'gi'),
  [w('cc', 'gate / ', 'claude-', 'sess')]: re(`${w('cc', 'gate')}|${w('claude-', 'sess')}|${w('claude_', 'sess')}`, 'gi'),
  'похоже на ключ': /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{30,}|AKIA[0-9A-Z]{16}|xox[abp]-[\w-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{30,})\b/g,
  [PLATFORM]: re(`\\b${PLATFORM}\\b|${PLATFORM}\\.ai|character${w('h', 'ub')}`, 'gi'),
  // имена людей и машин студии (кириллица — границы по буквам Unicode, \b её не видит)
  'имя человека': re(`(?<![\\p{L}\\d])(?:${[w('Den', 'is'), w('den', 'is'), w('Ден', 'ис'), w('Ол', 'ена'), w('ol', 'ena'), w('Ле', 'на'), w('Джу', 'лия'), w('Jul', 'ia'), w('jul', 'ia'), w('le', 'na'), w('pavliu', 'shyna'), w('vinograd', 'sky')].join('|')})(?![\\p{L}\\d])`, 'gu'),
  // приватные пакеты и репы студии: открытое ядро о них не знает (точки расширения — без имён реализаций)
  'приватный пакет': re(`@${w('kd-', 'studio')}/|${w('kd-', 'private')}`, 'g'),
  // пакеты, ушедшие из открытого ядра: под открытым скоупом их быть не должно нигде, включая lock
  'закрытый пакет под открытым именем': re(`@${w('kernel', 'dreams')}/(?:${[w('backend-', 'acp'), w('backend-', 'nr'), w('ca', 'rds'), w('cu', 'bes'), w('h', 'ub'), w('i', 'd'), w('sp', 'eak')].join('|')})(?![\\w-])`, 'g'),
  'имя машины': re(`(?<![\\p{L}\\d])(?:${[w('nex', 'us'), w('m', '4'), w('du', 'ke'), w('Du', 'ke')].join('|')})(?![\\p{L}\\d])`, 'gu'),
}
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|wasm|zip|gz|mp3|mp4|wav|ogg|pdf|psd|bin|node)$/i

function allowList() {
  const f = path.join(KD_ROOT, 'guard-allow.txt')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$')

function scanText(f, text, allow, hits) {
  for (const [name, re] of Object.entries(PATTERNS)) {
    if (name === PLATFORM && allow.some((r) => r.test(f))) continue
    const m = text.match(re)
    if (m) hits.push({ file: f, pattern: name, count: m.length, sample: m[0] })
  }
}

/** Следы в дереве коммита: [{ file, pattern, count, sample }]. */
export function scanTree(ref, cwd = KD_ROOT) {
  const allow = allowList().map(globRe)
  const files = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', ref], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean)
  const hits = []
  for (const f of files) {
    if (BINARY.test(f)) continue
    let text
    try { text = execFileSync('git', ['show', `${ref}:${f}`], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }) } catch { continue }
    scanText(f, text, allow, hits)
  }
  return hits
}

/** Следы в рабочем дереве: отслеживаемые и новые неигнорируемые файлы, как они лежат на диске. */
export function scanWorktree(cwd = KD_ROOT) {
  const allow = allowList().map(globRe)
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean)
  const hits = []
  for (const f of [...new Set(files)]) {
    if (BINARY.test(f)) continue
    let text
    try { text = fs.readFileSync(path.join(cwd, f), 'utf8') } catch { continue }
    scanText(f, text, allow, hits)
  }
  return hits
}

export function summary(hits) {
  const by = {}
  for (const h of hits) by[h.pattern] = (by[h.pattern] ?? 0) + h.count
  return Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(', ')
}

function prePush(remote = '', url = '') {
  const toGithub = remote === 'github' || /github\.com/i.test(url)
  if (!toGithub) return 0
  const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)
  let bad = false
  for (const line of lines) {
    const [, localSha, remoteRef] = line.split(' ')
    if (/^0+$/.test(localSha)) continue // удаление ветки
    if (remoteRef !== 'refs/heads/main' && !/^refs\/tags\/v\d/.test(remoteRef)) {
      console.error(`guard: в GitHub — только main и теги v*, а не ${remoteRef}`)
      bad = true
      continue
    }
    const hits = scanTree(localSha)
    if (hits.length) {
      for (const h of hits.slice(0, 50)) console.error(`  ${h.file}: ${h.pattern} ×${h.count}`)
      console.error(`guard: дерево ${localSha.slice(0, 8)} не чистое (${summary(hits)}) — пуш в GitHub отклонён`)
      bad = true
    }
  }
  return bad ? 1 : 0
}

function main(argv) {
  if (argv[0] === '--pre-push') return prePush(argv[1], argv[2])
  const verbose = argv.includes('-v') || argv.includes('--verbose')
  const t = argv.indexOf('--tree')
  const ref = t >= 0 ? (argv[t + 1] ?? 'HEAD') : null
  const hits = ref ? scanTree(ref) : scanWorktree()
  if (verbose) for (const h of hits) console.log(`${h.file}: ${h.pattern} ×${h.count} (${h.sample})`)
  const where = ref ? ` ${ref}` : ''
  if (!hits.length) { console.log(`guard:${where} чисто`); return 0 }
  const files = new Set(hits.map((h) => h.file)).size
  console.log(`guard:${where} следов ${hits.reduce((n, h) => n + h.count, 0)} в ${files} файлах (${summary(hits)})${verbose ? '' : ' — подробно: -v'}`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
