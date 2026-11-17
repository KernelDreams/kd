/** Ядро пакета без Node (как хост-контракт): `node:`, Buffer, process — только в src/node/. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('граница ядра', () => {
  it('node: и Buffer/process — только в src/node/', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const files: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n)
        if (statSync(f).isDirectory()) walk(f)
        else if (f.endsWith('.ts')) files.push(f)
      }
    }
    walk(src)
    const offenders = files
      .filter((f) => !relative(src, f).startsWith('node'))
      .filter((f) => /node:|\bBuffer\.|\bprocess\.(env|cwd|pid|platform|kill|stderr|stdout|exit)/.test(readFileSync(f, 'utf-8').replace(/`process\.platform`/g, '')))
      .map((f) => relative(src, f))
    expect(offenders).toEqual([])
  })

  it('без pi-ai, nunjucks, протокола и backend-http', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const all: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n)
        if (statSync(f).isDirectory()) walk(f)
        else all.push(readFileSync(f, 'utf-8'))
      }
    }
    walk(src)
    expect(all.join('\n')).not.toMatch(/(from|import\()\s*['"][^'"]*(pi-ai|nunjucks|nr-ui-protocol|backend-http)/)
  })
})
