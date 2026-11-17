// Фикстуры тестов из пробы (universal-editor-spec §10 E2):
//   node scripts/probe-fixtures.mjs ~/Studio/Projects/nrchat.dev/research/universal-editor/probe
// Копирует эталоны и выходы агентов в tests/fixtures/probe, переводит блоки row/tabs на атрибуты
// $row/$tab (mdz, JSON, YAML; HTML переводит загрузчик теста) и пишет expected.json — вердикт
// валидатора пробы (`PROBE_HELPERS=1 node check.mjs <файл>`, ошибки до перевода). У пробы должны
// стоять её зависимости (`npm i` в каталоге пробы).

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { rowTabsMdz, rowTabsTree } from '../tests/probe/row-tabs.mjs'

const probe = process.argv[2]
if (!probe || !existsSync(join(probe, 'check.mjs'))) {
  console.error('usage: node scripts/probe-fixtures.mjs <каталог пробы>')
  process.exit(1)
}
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'probe')

const files = []
for (const f of readdirSync(join(probe, 'reference'))) if (/\.(json|yaml|mdz|html)$/.test(f)) files.push(join('reference', f))
for (const model of readdirSync(join(probe, 'out')).sort()) {
  const md = join(probe, 'out', model)
  if (!statSync(md).isDirectory() || model === 'pdf') continue
  for (const fmt of readdirSync(md).sort()) for (const f of readdirSync(join(md, fmt)).sort()) files.push(join('out', model, fmt, f))
}

const unwrap = (t) => /^\s*```[a-z0-9]*\n([\s\S]*?)\n```\s*$/.exec(t)?.[1] ?? t
const expected = {}
let converted = 0
for (const rel of files) {
  const src = readFileSync(join(probe, rel), 'utf8')
  const ext = rel.split('.').pop()
  let out = src
  if (ext === 'mdz') out = rowTabsMdz(unwrap(src))
  else if (ext === 'json' || ext === 'yaml') {
    const doc = ext === 'json' ? JSON.parse(unwrap(src)) : YAML.parse(unwrap(src))
    const before = JSON.stringify(doc.layout)
    doc.layout = rowTabsTree(doc.layout)
    if (JSON.stringify(doc.layout) !== before) out = ext === 'json' ? JSON.stringify(doc, null, 2) + '\n' : YAML.stringify(doc)
  }
  if (out !== src) converted++
  const to = join(dest, rel.replace(/^out\//, ''))
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, out)
  const r = JSON.parse(execFileSync('node', ['check.mjs', rel], { cwd: probe, env: { ...process.env, PROBE_HELPERS: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  expected[relative(dest, to)] = { ok: r.errors.length === 0, errors: r.errors }
}
writeFileSync(join(dest, 'expected.json'), JSON.stringify(expected, null, 1) + '\n')
console.log(`${files.length} файлов, переведено на $row/$tab: ${converted}, ошибочных по пробе: ${Object.values(expected).filter((e) => !e.ok).length}`)
