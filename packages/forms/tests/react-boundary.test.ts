// Страж: `./react` (его импортирует nrchat, где нет nunjucks) не тянет ядро выражений и пиров ядра.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(__dirname, '..', 'src')

function graph(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const visit = (file: string): void => {
    if (files.has(file)) return
    files.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (m[1]) continue // import type — в рантайм не попадает
      const spec = m[2]!
      if (!spec.startsWith('.')) {
        bare.add(spec)
        continue
      }
      const base = resolve(dirname(file), spec.replace(/\.js$/, ''))
      const hit = ['.ts', '.tsx', '/index.ts'].map((x) => base + x).find(existsSync)
      if (hit) visit(hit)
    }
  }
  visit(entry)
  return { files: [...files], bare: [...bare] }
}

it('./react не тянет nunjucks, nrd, nr-md и модули выражений', () => {
  const { files, bare } = graph(join(SRC, 'react.tsx'))
  expect(bare.filter((b) => /nunjucks|@kerneldreams\/nrd/.test(b))).toEqual([])
  const core = files.map((f) => f.slice(SRC.length + 1)).filter((f) => f.startsWith('editor/'))
  expect(core.sort()).toEqual(['editor/cond.ts', 'editor/get.ts', 'editor/types.ts'])
})
