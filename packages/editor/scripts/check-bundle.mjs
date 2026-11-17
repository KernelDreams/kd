// Checks the build output: the base bundle (core + md, everything statically
// reachable from dist/index.js) must not pull TypeScript or the TS service.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const dist = resolve(import.meta.dirname, '../dist')
const FORBIDDEN = ['typescript', '@typescript/vfs', '@valtown/codemirror-ts', 'comlink', 'react', 'react-dom']
const STATIC_RE = /(?:^|\n)\s*(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']/g

function staticGraph(entry) {
  const seen = new Set()
  const bare = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const code = readFileSync(file, 'utf8')
    for (const [, spec] of code.matchAll(STATIC_RE)) {
      if (spec.startsWith('.')) queue.push(join(dirname(file), spec))
      else bare.add(spec)
    }
  }
  return { files: [...seen], bare: [...bare] }
}

for (const f of ['index.js', 'react.js', 'worker.js', 'index.d.ts']) {
  if (!existsSync(join(dist, f))) {
    console.error(`dist/${f} missing — run npm run build`)
    process.exit(1)
  }
}

const { files, bare } = staticGraph(join(dist, 'index.js'))
const bad = bare.filter((spec) => FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`)))
const size = files.reduce((sum, f) => sum + readFileSync(f).length, 0)
const inlined = files.filter((f) => /createLanguageService|ts\.createProgram/.test(readFileSync(f, 'utf8')))

console.log(`base bundle: ${files.length} files, ${(size / 1024).toFixed(1)} KB`)
console.log(`static deps: ${bare.sort().join(', ')}`)
if (bad.length || inlined.length) {
  console.error(`FAIL: base bundle pulls ${[...bad, ...inlined].join(', ')}`)
  process.exit(1)
}
const worker = readFileSync(join(dist, 'worker.js'), 'utf8')
if (!worker.includes('createLanguageService')) {
  console.error('FAIL: dist/worker.js does not carry the TypeScript service')
  process.exit(1)
}
console.log('OK: base bundle has no typescript; worker.js is self-contained')
