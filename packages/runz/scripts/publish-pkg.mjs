#!/usr/bin/env node
/**
 * publish-pkg — публикация внутреннего пакета с переписанным манифестом.
 *
 *   node scripts/publish-pkg.mjs <каталог-пакета> [--dry] [--allow-missing-deps] [--pack=<каталог>]
 *
 * `--pack=<каталог>` — вместо публикации положить туда тарбол с переписанным
 * манифестом (проверка установки у потребителя до реестра).
 *
 * Правило nrlib/CLAUDE.md: голый `npm publish` с `file:`-депами запрещён —
 * пакет уезжает нерезолвимым (инцидент 22.07). Раньше это делал `nr libs
 * publish`; на Mac его нет, отсюда этот минимальный заменитель.
 *
 * Шаги:
 *   1. Чистая сборка **во временной копии** пакета (без .git, node_modules,
 *      dist; node_modules — симлинк на рабочий): `npm run build`, если скрипт
 *      build есть. Рабочая папка не трогается — пока там нет dist, на машине не
 *      стартует runz (nrlib подключён file:-ссылками; maintenance §8).
 *   2. Публикуемые файлы (`npm pack --dry-run` в копии) копируются во временный
 *      каталог; манифест пишется туда же переписанным:
 *        - `file:`-депы → `^<версия цели на диске>`;
 *        - `publishConfig.{exports,main,types}` → в корень манифеста (так
 *          пакет в репе указывает на исходники, а в реестре — на dist;
 *          конвенция pnpm, npm её сам не знает);
 *        - `scripts` — без prepublish/prepare-хуков сборки (сборка уже была).
 *   3. Проверки: в манифесте не осталось `file:`; каждая переписанная версия
 *      и каждый диапазон на соседа своего скоупа, взятого по реестру, есть в своём
 *      реестре — иначе отказ (`--allow-missing-deps` снимает:
 *      потребители студии закрывают такой деп своей `file:`-ссылкой).
 *   4. `npm publish` из временного каталога в `publishConfig.registry`.
 *
 * Токен реестра — `~/.runz/config.md`, блок `## $gitea`, ключ `$token`; нет
 * его там — npm берёт авторизацию хоста из `~/.npmrc`. В репу токен не пишется:
 * временный `.npmrc` живёт в temp-каталоге и удаляется вместе с ним.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { asText } from '@kerneldreams/nrd'
import { globalRunzDir, loadConfigFile } from '@kerneldreams/runz-runtime'

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const LIFTED = ['exports', 'main', 'types', 'module']

function die(msg) {
  process.stderr.write(`publish-pkg: ${msg}\n`)
  process.exit(1)
}

function npm(args, opts = {}) {
  const r = spawnSync('npm', args, { encoding: 'utf8', ...opts })
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const allowMissing = argv.includes('--allow-missing-deps')
const packTo = argv.find((a) => a.startsWith('--pack='))?.slice('--pack='.length)
const target = argv.find((a) => !a.startsWith('--'))
if (!target) die('usage: publish-pkg.mjs <каталог-пакета> [--dry] [--allow-missing-deps] [--pack=<каталог>]')

const pkgDir = path.resolve(target)
const manifestPath = path.join(pkgDir, 'package.json')
if (!fs.existsSync(manifestPath)) die(`нет package.json в ${pkgDir}`)
const src = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
// `--pack` — тарбол для своего релиза (runz release), не публикация: private и
// пакет без реестра (локальный, форк) паковать можно.
if (src.private && !packTo) die(`${src.name}: "private": true — пакет не для публикации`)
const registry = src.publishConfig?.registry
if (!registry && !packTo) die(`${src.name}: нет publishConfig.registry — реестр выбирается явно, по скоупу`)

// --- 1. чистая сборка во временной копии ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-pkg-'))
// Копия — рядом с пакетом: tsconfig `paths`/`extends` ссылаются на соседей через ../
const buildDir = fs.mkdtempSync(path.join(path.dirname(pkgDir), `.publish-${path.basename(pkgDir)}-`))
const cleanup = () => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(buildDir, { recursive: true, force: true })
}
process.on('exit', cleanup)
const SKIP = new Set(['.git', 'node_modules', 'dist'])
fs.cpSync(pkgDir, buildDir, { recursive: true, filter: (s) => !SKIP.has(path.relative(pkgDir, s).split(path.sep)[0]) })
if (fs.existsSync(path.join(pkgDir, 'node_modules')))
  fs.symlinkSync(path.join(pkgDir, 'node_modules'), path.join(buildDir, 'node_modules'), 'junction')
if (src.scripts?.build) {
  process.stderr.write(`publish-pkg: ${src.name} — npm run build (во временной копии)\n`)
  const r = spawnSync('npm', ['run', 'build'], { cwd: buildDir, stdio: 'inherit' })
  if (r.status !== 0) die('сборка упала')
}

// --- 2. публикуемые файлы → temp ---
const pack = npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: buildDir })
if (pack.status !== 0) die(`npm pack --dry-run: ${pack.err}`)
const files = JSON.parse(pack.out)[0].files.map((f) => f.path).filter((f) => f !== 'package.json')

for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true })
  fs.copyFileSync(path.join(buildDir, f), path.join(tmp, f))
}

const out = structuredClone(src)
const rewritten = []
for (const field of DEP_FIELDS) {
  for (const [name, spec] of Object.entries(out[field] ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const depDir = path.resolve(pkgDir, spec.slice('file:'.length))
    const dep = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf8'))
    if (dep.name !== name) die(`${name}: ${spec} ведёт на пакет ${dep.name}`)
    out[field][name] = `^${dep.version}`
    rewritten.push({ name, range: `^${dep.version}`, version: dep.version })
  }
}
for (const key of LIFTED) {
  if (out.publishConfig?.[key] !== undefined) {
    out[key] = out.publishConfig[key]
    delete out.publishConfig[key]
  }
}
for (const hook of ['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'prebuild', 'build']) {
  delete out.scripts?.[hook]
}
if (out.scripts && Object.keys(out.scripts).length === 0) delete out.scripts

// --- 3. проверки ---
const leftover = DEP_FIELDS.flatMap((f) =>
  Object.entries(out[f] ?? {}).filter(([, v]) => String(v).startsWith('file:')),
)
if (leftover.length) die(`file:-депы остались: ${leftover.map(([k]) => k).join(', ')}`)

// Соседи студии, взятые по реестру (`^версия` уже в манифесте), — тоже проверяются:
// у 0.x каретка не перешагивает минор, и диапазон, от которого сосед ушёл вперёд,
// в реестре не резолвится (nr-ui-protocol 0.33.0 → nr-chat-store ^0.22).
/** Соседи из того же скоупа, что пакет (тот же `@scope/*`): их диапазоны сверяются с реестром. */
const STUDIO = new RegExp(`^${(src.name ?? '').split('/')[0] || '@'}/`)
const checks = [...rewritten]
for (const field of DEP_FIELDS) {
  for (const [name, range] of Object.entries(out[field] ?? {})) {
    if (STUDIO.test(name) && !rewritten.some((d) => d.name === name)) checks.push({ name, range })
  }
}

const missing = []
for (const d of checks) {
  const r = npm(['view', `${d.name}@${d.range}`, 'version', '--json'])
  if (r.status !== 0 || r.out === '') missing.push(`${d.name}@${d.range}`)
}
for (const d of rewritten) process.stderr.write(`  ${d.name}: file: → ${d.range}\n`)
if (missing.length) {
  const msg = `в реестрах нет: ${missing.join(', ')}`
  if (!allowMissing) die(`${msg} — опубликуй их раньше или --allow-missing-deps`)
  process.stderr.write(`publish-pkg: ВНИМАНИЕ — ${msg}; вне студии пакет не установится\n`)
}

fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(out, null, 2) + '\n')

if (packTo) {
  const dest = path.resolve(packTo)
  fs.mkdirSync(dest, { recursive: true })
  const r = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], { cwd: tmp, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// --- 4. публикация ---
const host = registry.replace(/^https?:/, '')
const cfg = loadConfigFile(path.join(globalRunzDir(), 'config.md'))
// Токен Gitea — только для реестра Gitea; npmjs и прочие — авторизация из ~/.npmrc
// (13.10: Gitea-токен уходил на npmjs → PUT 404 на любую публикацию).
const isGitea = !/registry\.npmjs\.org/.test(registry)
const token = isGitea && cfg ? asText(cfg.get(['gitea', 'token'])) : undefined
if (token) fs.writeFileSync(path.join(tmp, '.npmrc'), `${host}:_authToken=${token}\n`)
else if (isGitea) process.stderr.write(`publish-pkg: $gitea.$token в ~/.runz/config.md нет — авторизация из ~/.npmrc\n`)

const already = npm(['view', `${out.name}@${out.version}`, 'version', '--registry', registry])
if (already.status === 0 && already.out === out.version) die(`${out.name}@${out.version} уже в реестре — подними версию`)

const args = ['publish', '--registry', registry, '--ignore-scripts']
if (dry) args.push('--dry-run')
process.stderr.write(`publish-pkg: ${out.name}@${out.version} → ${registry}${dry ? ' (dry)' : ''}\n`)
const r = spawnSync('npm', args, { cwd: tmp, stdio: 'inherit' })
if (r.status !== 0) die('npm publish упал')
