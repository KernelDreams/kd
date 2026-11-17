// Снимок имён иконок lucide для проверки `$icon` в finalize: node scripts/lucide-names.mjs <путь к lucide-react>
// По умолчанию — lucide-react фронта nrchat (рендерит иконки он, версия должна совпадать).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2] ?? join(import.meta.dirname, '../../../Projects/nrchat/node_modules/lucide-react')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const src = readFileSync(join(root, 'dist/esm/dynamicIconImports.mjs'), 'utf8')
const names = [...new Set([...src.matchAll(/^\s*"?([a-z0-9-]+)"?\s*:\s*\(?\s*\(\)\s*=>/gm)].map((m) => m[1]))].sort()
if (names.length < 1000) throw new Error(`мало имён (${names.length}) — формат dynamicIconImports сменился?`)
const out = `// Сгенерировано scripts/lucide-names.mjs из lucide-react ${version} — не править руками.\nexport const LUCIDE_VERSION = '${version}'\nexport const LUCIDE_NAMES: ReadonlySet<string> = new Set(${JSON.stringify(names)})\n`
writeFileSync(join(import.meta.dirname, '../src/lucide-names.ts'), out)
console.log(`lucide-react ${version}: ${names.length} имён`)
