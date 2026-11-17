#!/usr/bin/env node
// smoke-pack — проверка УПАКОВАННОЙ установки (nrd-merge §4.8).
//
// Остаётся навсегда как pre-publish check: `npm run smoke`. Ловит то, что не
// ловят ни tsc, ни vitest, — они работают по src/ и по дереву репозитория:
//   - subpath из `exports` не резолвится у потребителя (нет файла в dist,
//     опечатка в карте, забытый `files`);
//   - `nrd/template` падает при импорте без установленных nunjucks/handlebars
//     (движки обязаны быть ЛЕНИВЫМИ optional peers, §2.4);
//   - `nrd` / `nrd/web` тянут node-модули (лестница платформ, §2.2);
//   - file:-зависимость уехала в тарбол как есть → нерезолвимый пакет
//     (инцидент 22.07 с nrd-core 3.0.0–3.0.2).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUBPATHS = ['', '/web', '/node', '/template', '/format', '/batch']
/** Движки — optional peers: их НЕ должно быть в дереве смоук-проекта. */
const FORBIDDEN_IN_TREE = ['nunjucks', 'handlebars']

let tmp
let userconfig
let globalconfig
let failed = 0

const say = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`)
}

/**
 * Окружение без `npm_config_*`: `npm run smoke` экспортирует туда ВЕСЬ свой
 * конфиг (в т.ч. allow-scripts и scope→registry из ~/.npmrc), а переменные
 * окружения сильнее `--userconfig`. Без чистки смоук зависел бы от настроек
 * машины — ровно то, что он и должен исключать.
 */
function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase().startsWith('npm_')) continue
    env[k] = v
  }
  return env
}

function npm(args, cwd) {
  return execFileSync('npm', [...args, '--userconfig', userconfig, '--globalconfig', globalconfig], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function node(file, cwd) {
  return execFileSync(process.execPath, [file], { cwd, env: cleanEnv(), encoding: 'utf-8' })
}

function packInto(dir, target) {
  const out = npm(['pack', target, '--pack-destination', dir, '--loglevel', 'error'], dir)
  return join(dir, out.trim().split('\n').pop().trim())
}

/**
 * Упаковать пакет и, рекурсивно, все его file:-зависимости — каждую в свой
 * тарбол, ссылки в манифесте переписать на них. То же преобразование, что при
 * публикации делает `nr libs publish` (там file: → ^version): тарбол обязан
 * резолвиться сам по себе, без дерева разработки рядом. Инцидент 22.07
 * (nrd-core 3.0.0–3.0.2) — ровно про то, что этого не проверяли.
 */
const staged = new Map()

function stageTarball(dir) {
  const key = resolve(dir)
  if (staged.has(key)) return staged.get(key)

  const work = mkdtempSync(join(tmp, 'pkg-'))
  const rawTgz = packInto(work, key)
  execFileSync('tar', ['-xzf', rawTgz, '-C', work])
  const manifestPath = join(work, 'package', 'package.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'))

  let rewritten = 0
  for (const [dep, spec] of Object.entries(m.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const target = resolve(key, spec.slice('file:'.length))
    if (!existsSync(target)) {
      say(false, `${m.name}: file:-деп ${dep} указывает в никуда (${spec})`)
      continue
    }
    m.dependencies[dep] = `file:${stageTarball(target)}`
    rewritten++
  }
  if (rewritten > 0) {
    writeFileSync(manifestPath, JSON.stringify(m, null, 2))
    console.log(`  ..   ${m.name}: file:-депов переписано на тарболы: ${rewritten}`)
  }

  const out = packInto(work, join(work, 'package'))
  staged.set(key, out)
  return out
}

try {
  tmp = mkdtempSync(join(tmpdir(), 'nrd-smoke-'))
  userconfig = join(tmp, 'npmrc-user')
  globalconfig = join(tmp, 'npmrc-global')
  writeFileSync(userconfig, '')
  writeFileSync(globalconfig, '')
  console.log(`smoke-pack: ${tmp}`)

  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8'))
  const NAME = manifest.name

  // 1. Упаковать рекурсивно (живая file:-директория не годится: npm лезет в неё
  //    готовить пакет и тянет конфиг машины; тарбол — ровно то, что уедет).
  const tgz = stageTarball(PKG_ROOT)

  // 2. Чистый временный проект — только тарбол, без движков.
  const proj = join(tmp, 'proj')
  mkdirSync(proj)
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify({ name: 'nrd-smoke', version: '0.0.0', type: 'module', private: true }, null, 2),
  )
  npm(['install', tgz, '--no-audit', '--no-fund', '--loglevel', 'error'], proj)

  say(existsSync(join(proj, 'node_modules', NAME)), `пакет установлен: ${NAME}@${manifest.version}`)
  for (const engine of FORBIDDEN_IN_TREE) {
    say(
      !existsSync(join(proj, 'node_modules', engine)),
      `optional peer "${engine}" НЕ подтянулся (движки не обязательны)`,
    )
  }

  // 3. Импортировать все пять точек входа в чистом процессе.
  const probe = join(proj, 'probe.mjs')
  writeFileSync(
    probe,
    [
      `const subpaths = ${JSON.stringify(SUBPATHS.map((s) => NAME + s))}`,
      'const out = []',
      'for (const id of subpaths) {',
      '  try {',
      '    const m = await import(id)',
      '    out.push({ id, ok: true, exports: Object.keys(m).length })',
      '  } catch (e) {',
      '    out.push({ id, ok: false, error: e.message })',
      '  }',
      '}',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n'),
  )
  for (const r of JSON.parse(node(probe, proj))) {
    say(r.ok, r.ok ? `import('${r.id}') → ${r.exports} экспортов` : `import('${r.id}'): ${r.error}`)
  }

  // 4. Лестница платформ: корень, /web и /batch не тянут node-встроенные модули.
  //    Замер дельтой — сам ESM-загрузчик Node тянет fs/url/path на любой импорт,
  //    поэтому база снимается ПОСЛЕ импорта пустого модуля.
  writeFileSync(join(proj, 'noop.mjs'), 'export default 0\n')
  const ladder = join(proj, 'ladder.mjs')
  writeFileSync(
    ladder,
    [
      'const NODE_ONLY = /^NativeModule (fs|fs\\/promises|child_process|os|worker_threads|vm)$/',
      "await import('./noop.mjs')",
      'const before = new Set(process.moduleLoadList)',
      `await import(${JSON.stringify(NAME)})`,
      `await import(${JSON.stringify(NAME + '/web')})`,
      `await import(${JSON.stringify(NAME + '/batch')})`,
      'const leaked = process.moduleLoadList.filter((m) => !before.has(m) && NODE_ONLY.test(m))',
      'process.stdout.write(JSON.stringify(leaked))',
    ].join('\n'),
  )
  const leaked = JSON.parse(node(ladder, proj))
  say(
    leaked.length === 0,
    leaked.length === 0
      ? 'корень, /web и /batch не тянут node-встроенные модули (лестница платформ)'
      : `корень, /web или /batch тянут node-модули: ${leaked.join(', ')}`,
  )

  // 5. Живой вызов через границу пакета — что установленный dist работает.
  const live = join(proj, 'live.mjs')
  writeFileSync(
    live,
    [
      `const { parseDocument } = await import(${JSON.stringify(NAME)})`,
      `const { memoryStorage } = await import(${JSON.stringify(NAME + '/web')})`,
      `const { fsStorage, builtinFunctions } = await import(${JSON.stringify(NAME + '/node')})`,
      "const doc = parseDocument('$name: Мидленд', { sigil: '$' })",
      'const s = memoryStorage()',
      "await s.write('a/b.txt', 'hi')",
      "const r = await s.read('a/b.txt')",
      'process.stdout.write(',
      '  JSON.stringify({',
      "    parse: doc.get(['name']) === 'Мидленд',",
      "    storage: r.ok && r.value === 'hi',",
      "    node: typeof fsStorage === 'function' && typeof builtinFunctions.readFile === 'function',",
      '  }),',
      ')',
    ].join('\n'),
  )
  const res = JSON.parse(node(live, proj))
  say(res.parse, 'корень: parseDocument работает из установленного пакета')
  say(res.storage, 'nrd/web: memoryStorage работает')
  say(res.node, 'nrd/node: fsStorage + fs-функции на месте')
} catch (e) {
  failed++
  console.error(`  FAIL ${e.message}`)
  if (e.stdout) console.error(String(e.stdout))
  if (e.stderr) console.error(String(e.stderr))
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nsmoke-pack: OK' : `\nsmoke-pack: ПРОВАЛ (${failed})`)
process.exit(failed === 0 ? 0 : 1)
