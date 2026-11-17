import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { parseDocument, objectContext, type Block, type IContext } from '../../src/core/index.js'
import { execBlock, execBlocks, type Executor } from '../../src/exec/index.js'
import { spawnExecutor } from '../../src/node/index.js'

// Блоки строим из настоящего mdz через parseDocument — заодно проверяем
// интеграцию с парсером. Источники собираем join('\n') и в ОДИНАРНЫХ кавычках,
// чтобы `${...}` в теле НЕ интерполировался самим тестовым файлом.
function block(...lines: string[]): Block {
  return parseDocument(lines.join('\n')).doc.root.children[0]
}

function text(ctx: IContext): string {
  return String(ctx.get(['content']) ?? '').trim()
}

let hasZx = false
try {
  createRequire(import.meta.url).resolve('zx/globals')
  hasZx = true
} catch {
  /* zx не установлен — соответствующий тест скипаем */
}

describe('execBlock — shell', () => {
  it('echo + резолв ${name}: block-local перебивает external, external тоже виден', async () => {
    const b = block('## $shell greet', '$name: world', '```cmd', 'echo ${name} ${extra}', '```')
    const external = objectContext({ name: 'OUTER', extra: 'EXTRA' })
    const r = await execBlock(b, { executor: spawnExecutor, external })
    expect(r.ok).toBe(true)
    if (r.ok) expect(text(r.value)).toBe('world EXTRA')
  })

  it('$nr-parse text (default) → content', async () => {
    const b = block('## $shell t', '```cmd', 'echo plain', '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(text(r.value)).toBe('plain')
  })
})

describe('execBlock — ts', () => {
  it('compute → JSON.stringify → stdout → parse json → IContext', async () => {
    const b = block(
      '## $ts compute',
      '$base: 40',
      '$nr-parse: json',
      '```ts',
      'const n = ${base} + 2',
      'console.log(JSON.stringify({ result: n }))',
      '```',
    )
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.get(['result'])).toBe(42)
  })
})

describe('execBlock — zx', () => {
  ;(hasZx ? it : it.skip)('$`...` исполняется (zx globals инъектированы)', async () => {
    const b = block(
      '## $zx run',
      '```ts',
      'const out = await $`node -e "console.log(7*6)"`',
      'console.log(out.stdout.trim())',
      '```',
    )
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(text(r.value)).toBe('42')
  }, 30000) // zx: холодный spawn шелла на Windows > 5s (DEBT: красный тест — был таймаут, не поломка)
})

describe('execBlock — $nr-parse', () => {
  it('json', async () => {
    const b = block('## $ts j', '$nr-parse: json', '```ts', 'console.log(JSON.stringify({ a: 1, b: "x" }))', '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.get(['a'])).toBe(1)
      expect(r.value.get(['b'])).toBe('x')
    }
  })

  it('mdd (sigil @)', async () => {
    const b = block('## $ts m', '$nr-parse: mdd', '```ts', `console.log('@name: foo')`, '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.get(['name'])).toBe('foo')
  })

  it('mdz (sigil $)', async () => {
    const b = block('## $ts z', '$nr-parse: mdz', '```ts', `console.log('$name: bar')`, '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.get(['name'])).toBe('bar')
  })

  it('text', async () => {
    const b = block('## $shell t', '```cmd', 'echo hi', '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(text(r.value)).toBe('hi')
  })
})

// Executor-эхо: stdout = команда как есть. Тесты ниже проверяют, ЧТО nrd-exec
// отдаёт исполнителю, а не что с этим сделает конкретный shell (sh раскрывает
// $HOME/${x} сам, cmd — нет; это не семантика nrd-exec).
const echoExecutor: Executor = {
  id: 'echo',
  supports: new Set(['shell']),
  run: async (input) => ({ ok: true, value: { stdout: input.code, stderr: '', code: 0 } }),
}

describe('execBlock — $nr-raw', () => {
  it('тело без резолва — ${x} уходит литералом', async () => {
    const b = block('## $shell raw', '$x: RESOLVED', '$nr-raw: true', '```cmd', 'echo ${x}', '```')
    const r = await execBlock(b, { executor: echoExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) expect(text(r.value)).toBe('echo ${x}')
  })
})

describe('execBlock — конфликт shell-синтаксиса $', () => {
  it('голый $HOME цел, ${unknown} → литерал (lenient)', async () => {
    const b = block('## $shell c', '```cmd', 'echo $HOME ${unknown}', '```')
    const external = objectContext({ known: 'x' })
    const r = await execBlock(b, { executor: echoExecutor, external })
    expect(r.ok).toBe(true)
    // nrd-exec не трогает голый $HOME и неизвестный ${unknown} — отдаёт литералом.
    if (r.ok) expect(text(r.value)).toBe('echo $HOME ${unknown}')
  })
})

describe('execBlock — ошибки', () => {
  it('code ≠ 0 → Result.err со stderr', async () => {
    const b = block('## $ts boom', '```ts', `process.stderr.write('boom-msg')`, 'process.exit(3)', '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('boom-msg')
  })

  it('нераспознанный движок → Result.err', async () => {
    const b = block('## $python p', '```py', 'print(1)', '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(false)
  })

  it('supports: $shell под executor без shell в supports → Result.err (run не зовётся)', async () => {
    const tsOnly: Executor = {
      id: 'ts-only',
      supports: new Set(['ts']),
      run: async () => {
        throw new Error('run НЕ должен вызываться')
      },
    }
    const b = block('## $shell s', '```cmd', 'echo nope', '```')
    const r = await execBlock(b, { executor: tsOnly })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('не поддерживается')
  })
})

describe('spawnExecutor — cleanup временных файлов', () => {
  it('после исполнения ts временных nrd-exec-* не прибавляется', async () => {
    const count = () => readdirSync(tmpdir()).filter((f) => f.startsWith('nrd-exec-')).length
    const before = count()
    const b = block('## $ts c', '```ts', `console.log('done')`, '```')
    const r = await execBlock(b, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    expect(count()).toBeLessThanOrEqual(before)
  })
})

describe('execBlocks — документ', () => {
  it('исполняет все exec-блоки → Record по id', async () => {
    const doc = parseDocument(
      [
        '## $shell one', '```cmd', 'echo first', '```',
        '## $ts two', '$nr-parse: json', '```ts', 'console.log(JSON.stringify({ ok: true }))', '```',
      ].join('\n'),
    )
    const r = await execBlocks(doc, { executor: spawnExecutor })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(text(r.value['one'])).toBe('first')
      expect(r.value['two'].get(['ok'])).toBe(true)
    }
  })
})
