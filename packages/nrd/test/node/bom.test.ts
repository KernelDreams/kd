// UTF-8 BOM в начале файла не съедает первый атрибут — ни в корне,
// ни во включённом файле, ни в базе `$nr-extends`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadProgram, readTextSync, readTextWithIncludes } from '../../src/node/index.js'

const BOM = '﻿'
let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-bom-'))
  fs.writeFileSync(path.join(dir, 'with.mdz'), BOM + '$type: rz\n$cmd: action\n')
  fs.writeFileSync(path.join(dir, 'without.mdz'), '$type: rz\n$cmd: action\n')
  fs.writeFileSync(path.join(dir, 'inc.mdz'), BOM + '$a: 1\n')
  fs.writeFileSync(path.join(dir, 'root.mdz'), BOM + '$[[inc]]\n$b: 2\n')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('BOM в файловом loader’е nrd/node', () => {
  it('readTextSync снимает ведущий BOM', () => {
    expect(readTextSync(path.join(dir, 'with.mdz'))).toBe('$type: rz\n$cmd: action\n')
  })

  it('программа из файла с BOM идентична программе без BOM', () => {
    const a = loadProgram(path.join(dir, 'with.mdz'))
    const b = loadProgram(path.join(dir, 'without.mdz'))
    expect(a.root).toEqual(b.root)
    expect(a.root.attrs.map((x) => x.key[0])).toEqual(['type', 'cmd'])
  })

  it('BOM включённого файла не попадает в середину текста', () => {
    expect(readTextWithIncludes(path.join(dir, 'root.mdz'))).toBe('$a: 1\n\n$b: 2\n')
  })
})
