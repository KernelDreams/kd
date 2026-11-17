#!/usr/bin/env node
// Зачистка следов (шаг 8 kd-repo-spec): номера задач из комментариев и текстов — механически, идемпотентно.
// По умолчанию — только отчёт; --write — правит файлы. Остаток (имена, адреса, площадки) — руками, список даёт guard.mjs.
//   node scripts/scrub.mjs [--write] [packages/<dir> …]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { KD_ROOT } from './lib/repo.mjs'

const TASK = '(?:DEV|NOT|SLOT|NRP|BOT|FAR|LIFE|DUK|TRM|EH|ART|GMB)-\\d+'
const LIST = `${TASK}(?:\\s*(?:[,;/+]|и|and)\\s*${TASK})*`
const RULES = [
  // « (ABC-1)», « (ABC-1, ABC-2)», « (ABC-1 п. 3)» — скобка целиком из номеров
  [new RegExp(`\\s*\\((?:${LIST})(?:\\s*п\\.\\s*\\d+)?\\)`, 'g'), ''],
  // «(ABC-1, текст)», «(ABC-1: текст)», «(ABC-1 — текст)» → «(текст)»
  [new RegExp(`\\((?:${LIST})\\s*(?:[,;:]|—|-)\\s*`, 'g'), '('],
  // «(текст, ABC-1)», «(текст; ABC-1 и ABC-2)» → «(текст)»
  [new RegExp(`\\s*[,;]\\s*(?:${LIST})(?=\\s*\\))`, 'g'), ''],
  // «текст, ABC-1, текст» внутри перечня → «текст, текст»
  [new RegExp(`\\s*[,;]\\s*(?:${LIST})(?=\\s*[,;])`, 'g'), ''],
  // «ABC-1: » / «ABC-1 — » в начале комментария, строки или пункта
  [new RegExp(`((?:\\/\\/|\\*|#|^|-|«|"|')\\s*)(?:${LIST})(?:\\s*(?:[:.]|—|–)\\s*)`, 'gm'), '$1'],
  // одиночное упоминание («как в ABC-1», «задача ABC-1») — номер убрать, смысл оставить
  [new RegExp(`[ \\t]*\\b(?:${LIST})\\b`, 'g'), ''],
]
const TEXT = /\.(m?[jt]sx?|cjs|cts|mts|css|md|json|mdz|mdd|mds|html|txt|sh|ya?ml)$/

/** Тесты и фикстуры: номер в данных (строка, заголовок сессии, ожидание) — значение, его не вырезать. */
const TESTS = /(^|\/)(test|tests|e2e|fixtures|spike)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const CODE = /\.(m?[jt]sx?|cjs|cts|mts)$/
// Студийный префикс → нейтральный: ABC-123 — тот же вид «PROJ-N», но не след студии.
const NEUTRAL = { DEV: 'ABC', NOT: 'NTS', SLOT: 'SLT', NRP: 'RPG', BOT: 'BTS', FAR: 'FRR', LIFE: 'LFE', DUK: 'DKS', TRM: 'TRP', EH: 'EHS', ART: 'ARS', GMB: 'GMS' }
const PREFIX_RE = new RegExp(`\\b(${Object.keys(NEUTRAL).join('|')})-(\\d+)\\b`, 'g')
const neutral = (p) => (p === p.toLowerCase() ? NEUTRAL[p.toUpperCase()].toLowerCase() : NEUTRAL[p.toUpperCase()])

function scrubText(text) {
  for (const [re, to] of RULES) text = text.replace(re, to)
  return text
}

/** Строка-комментарий — номер убрать; строка кода — префикс заменить нейтральным. */
function scrubTest(text) {
  return text
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? scrubText(l) : l.replace(PREFIX_RE, (_, p, n) => `${neutral(p)}-${n}`)))
    .join('\n')
}

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const roots = argv.filter((a) => !a.startsWith('--'))
const files = execFileSync('git', ['ls-files', '-z', '--', ...(roots.length ? roots : ['packages'])], { cwd: KD_ROOT, encoding: 'utf8', maxBuffer: 256 << 20 })
  .split('\0').filter((f) => f && TEXT.test(f) && !f.endsWith('package.json'))

let changed = 0
let total = 0
for (const f of files) {
  const abs = path.join(KD_ROOT, f)
  const before = fs.readFileSync(abs, 'utf8')
  const text = TESTS.test(f) && CODE.test(f) ? scrubTest(before) : scrubText(before)
  if (text !== before) {
    changed++
    total += (before.match(new RegExp(TASK, 'g')) ?? []).length
    if (write) fs.writeFileSync(abs, text)
  }
}
console.log(`scrub: ${changed} файлов, номеров задач ${total}${write ? ' — вычищено' : ' (отчёт; --write — править)'}`)
