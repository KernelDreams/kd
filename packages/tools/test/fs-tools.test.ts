/**
 * Файловые тулы на каждом хосте (memory — ядро без диска, node — диск): read
 * (offset/limit, картинка), ls, find/grep (свой обход; fd/rg — Node), write,
 * edit (точно, мягко, неуникально, CRLF), граница cwd, apply_patch (мультифайл,
 * создание/удаление/переименование, смещённый ханк, атомарность).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFsTools } from '../src/fs/index.js'
import { parseUnifiedDiff } from '../src/fs/apply-patch.js'
import type { ToolContext, ToolDef, ToolResult } from '../src/types.js'
import { TEST_HOSTS, type TestHost } from './support/hosts.js'

const ctx: ToolContext = { signal: new AbortController().signal, sessionId: 's1', callId: 'c1', ask: async () => undefined }

for (const makeHost of TEST_HOSTS) {
const H0 = makeHost()
H0.cleanup()
describe(`[${H0.name}]`, () => {
let H: TestHost
let dir: string
let tools: Map<string, ToolDef>

async function run(name: string, args: Record<string, unknown>, set = tools): Promise<ToolResult> {
  const raw = await set.get(name)!.execute(args, ctx)
  return typeof raw === 'string' ? { text: raw } : raw
}

function toolsOf(opts: Omit<Parameters<typeof createFsTools>[0], 'fs'>): Map<string, ToolDef> {
  return new Map(createFsTools({ fs: H.fs, ...(H.host.exec ? { search: H.host.exec } : {}), ...opts }).map((t) => [t.name, t]))
}

beforeEach(() => {
  H = makeHost()
  dir = H.dir
  tools = toolsOf({ cwd: dir, external: false })
})
afterEach(() => H.cleanup())

const put = (rel: string, text: string | Uint8Array): Promise<void> => H.put(rel, text)
const get = (rel: string): Promise<string> => H.get(rel)

describe('read / ls', () => {
  it('read: строки, offset/limit и подсказка продолжения', async () => {
    await put('a.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    expect((await run('read', { path: 'a.txt' })).text).toContain('line 10')
    const r = await run('read', { path: 'a.txt', offset: 3, limit: 2 })
    expect(r.text).toMatch(/^line 3\nline 4\n\n\[6 more lines in file\. Use offset=5 to continue\.\]$/)
    await expect(run('read', { path: 'a.txt', offset: 50 })).rejects.toThrow(/beyond end of file/)
  })

  it('read: большой файл обрезается по строкам с offset=', async () => {
    await put('big.txt', Array.from({ length: 2500 }, (_, i) => `x${i}`).join('\n'))
    const r = await run('read', { path: 'big.txt' })
    expect(r.text).toContain('[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]')
  })

  it('read: картинка — image-part', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await put('p.png', new Uint8Array(png))
    const r = await run('read', { path: 'p.png' })
    expect(r.images?.[0]?.mimeType).toBe('image/png')
    expect(r.images?.[0]?.data).toBe(png.toString('base64'))
  })

  it('ls: папки с /, сортировка, пусто', async () => {
    await put('b.txt', '')
    await put('A/x.txt', '')
    expect((await run('ls', {})).text).toBe('A/\nb.txt')
    await H.fs.mkdir(`${dir}/empty`)
    expect((await run('ls', { path: 'empty' })).text).toBe('(empty directory)')
  })
})

describe('find / grep', () => {
  beforeEach(async () => {
    await put('src/a.ts', 'export function hello() {}\n')
    await put('src/deep/b.spec.ts', 'hello again\nnothing\n')
    await put('node_modules/x/c.ts', 'hello hidden\n')
    await put('README.md', 'Hello docs\n')
  })

  for (const external of H0.name === 'node' ? [false, true] : [false]) {
    const label = external ? 'fd/rg' : 'свой обход'
    it(`find (${label}): имя и путь`, async () => {
      const set = toolsOf({ cwd: dir, external })
      expect((await run('find', { pattern: '*.ts' }, set)).text.split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.spec.ts'])
      expect((await run('find', { pattern: 'src/**/*.spec.ts' }, set)).text).toBe('src/deep/b.spec.ts')
      expect((await run('find', { pattern: '*.none' }, set)).text).toBe('No files found matching pattern')
    })

    it(`grep (${label}): совпадения, ignoreCase, glob, контекст`, async () => {
      const set = toolsOf({ cwd: dir, external })
      const r = (await run('grep', { pattern: 'hello' }, set)).text.split('\n').sort()
      expect(r).toEqual(['src/a.ts:1: export function hello() {}', 'src/deep/b.spec.ts:1: hello again'])
      expect((await run('grep', { pattern: 'hello', ignoreCase: true, glob: '*.md' }, set)).text).toBe('README.md:1: Hello docs')
      expect((await run('grep', { pattern: 'again', context: 1 }, set)).text).toBe('src/deep/b.spec.ts:1: hello again\nsrc/deep/b.spec.ts-2- nothing')
      expect((await run('grep', { pattern: 'zzz' }, set)).text).toBe('No matches found')
    })
  }
})

describe('граница cwd', () => {
  it('выход наружу — ошибка, $fs_scope any — можно', async () => {
    const outside = await H.outside()
    await H.fs.writeText(`${outside}/o.txt`, 'secret')
    await expect(run('read', { path: `${outside}/o.txt` })).rejects.toThrow(/path outside workspace/)
    await expect(run('read', { path: '../' + 'x' })).rejects.toThrow(/path outside workspace/)
    if (H.symlink) {
      H.symlink(outside, 'link')
      await expect(run('read', { path: 'link/o.txt' })).rejects.toThrow(/path outside workspace/)
      await expect(run('write', { path: 'link/new.txt', content: 'x' })).rejects.toThrow(/path outside workspace/)
    }
    const any = toolsOf({ cwd: dir, scope: 'any', external: false })
    expect((await run('read', { path: `${outside}/o.txt` }, any)).text).toBe('secret')
  })

  it('путь в каталоге скилла — подсказка «загрузи скилл через skill» (ABC-357)', async () => {
    const outside = await H.outside()
    await H.fs.writeText(`${outside}/SKILL.md`, '# s')
    const set = toolsOf({ cwd: dir, external: false, skillSources: async () => [{ name: 'nrchat.dev', dir: outside }] })
    await expect(run('read', { path: `${outside}/SKILL.md` }, set)).rejects.toThrow(/skill "nrchat\.dev".*skill tool/)
    const plain = await H.outside()
    await expect(run('read', { path: `${plain}/x` }, set)).rejects.not.toThrow(/skill tool/)
  })
})

describe('write / edit', () => {
  it('write: создаёт каталоги, превью — диф', async () => {
    const t = tools.get('write')!
    const pv = await t.preview!({ path: 'n/a.txt', content: 'hi\n' }, ctx)
    expect(pv).toMatchObject({ kind: 'diff', path: 'n/a.txt' })
    expect((pv as { diff: string }).diff).toContain('+hi')
    const r = await run('write', { path: 'n/a.txt', content: 'hi\n' })
    expect(r.text).toBe('Successfully wrote 3 bytes to n/a.txt')
    expect(await get('n/a.txt')).toBe('hi\n')
  })

  it('edit: точная замена, диф в результате и в превью', async () => {
    await put('a.ts', 'function hello() {\n  return 1\n}\n')
    const t = tools.get('edit')!
    const args = { path: 'a.ts', edits: [{ oldText: 'hello', newText: 'greet' }] }
    const pv = (await t.preview!(args, ctx)) as { kind: string; diff: string }
    expect(pv.kind).toBe('diff')
    expect(pv.diff).toContain('-function hello() {')
    expect(pv.diff).toContain('+function greet() {')
    expect(await get('a.ts')).toContain('hello') // превью не пишет
    const r = await run('edit', args)
    expect(r.text).toContain('Successfully replaced 1 block(s) in a.ts.')
    expect(await get('a.ts')).toBe('function greet() {\n  return 1\n}\n')
    expect((r.data as { diff: string }).diff).toContain('+function greet() {')
  })

  it('edit: мягкое совпадение (кавычки, тире, хвостовые пробелы) — замена по оригиналу', async () => {
    await put('q.md', 'Say “hi” — now   \nnext\n')
    await run('edit', { path: 'q.md', edits: [{ oldText: 'Say "hi" - now\nnext', newText: 'Say bye\nnext' }] })
    expect(await get('q.md')).toBe('Say bye\nnext\n')
  })

  it('edit: неуникально / не найдено (с подсказкой) / пересечение', async () => {
    await put('d.ts', 'a = 1\nb = 1\na = 1\n')
    await expect(run('edit', { path: 'd.ts', edits: [{ oldText: 'a = 1', newText: 'x' }] })).rejects.toThrow(/Found 2 occurrences/)
    await expect(run('edit', { path: 'd.ts', edits: [{ oldText: 'b = 2', newText: 'x' }] })).rejects.toThrow(/Could not find the exact text[\s\S]*Closest matching lines/)
    await expect(run('edit', { path: 'd.ts', edits: [{ oldText: 'b = 1\na', newText: 'x' }, { oldText: 'a = 1\nb', newText: 'y' }] })).rejects.toThrow(/overlap/)
    expect(await get('d.ts')).toBe('a = 1\nb = 1\na = 1\n')
  })

  it('edit: несколько правок по исходному файлу, CRLF сохраняется', async () => {
    await put('w.txt', 'one\r\ntwo\r\nthree\r\n')
    await run('edit', { path: 'w.txt', edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'three', newText: 'THREE\nFOUR' }] })
    expect(await get('w.txt')).toBe('ONE\r\ntwo\r\nTHREE\r\nFOUR\r\n')
  })

  it('edit: старая форма oldText/newText верхнего уровня', async () => {
    await put('o.txt', 'abc\n')
    await run('edit', { path: 'o.txt', oldText: 'b', newText: 'B' })
    expect(await get('o.txt')).toBe('aBc\n')
  })
})

describe('apply_patch', () => {
  it('разбор: git-заголовки, /dev/null, rename, ограда и текст вокруг', () => {
    const files = parseUnifiedDiff(
      [
        'Here is the patch:',
        '```diff',
        'diff --git a/old.txt b/new.txt',
        'similarity index 90%',
        'rename from old.txt',
        'rename to new.txt',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
        '```',
      ].join('\n'),
    )
    expect(files).toEqual([
      { oldPath: 'old.txt', newPath: 'new.txt', hunks: [] },
      { oldPath: 'gone.txt', newPath: null, hunks: [{ oldStart: 1, lines: ['-bye'], noNewlineNew: false }] },
    ])
  })

  it('мультифайл: правка, создание, удаление, переименование с правкой', async () => {
    await put('a.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    await put('del.txt', 'x\n')
    await put('src/old.ts', 'export const v = 1\n')
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 20',
      ' const c = 3',
      '--- /dev/null',
      '+++ b/new/n.ts',
      '@@ -0,0 +1,2 @@',
      '+line1',
      '+line2',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git a/src/old.ts b/src/renamed.ts',
      'rename from src/old.ts',
      'rename to src/renamed.ts',
      '--- a/src/old.ts',
      '+++ b/src/renamed.ts',
      '@@ -1 +1 @@',
      '-export const v = 1',
      '+export const v = 2',
    ].join('\n')
    const pv = (await tools.get('apply_patch')!.preview!({ patch }, ctx)) as { diff: string }
    expect(pv.diff).toContain('+const b = 20')
    expect(pv.diff).toContain('rename src/old.ts -> src/renamed.ts')
    const r = await run('apply_patch', { patch })
    expect(r.text).toBe('Patch applied:\nM a.ts\nA new/n.ts\nD del.txt\nR src/old.ts -> src/renamed.ts')
    expect(await get('a.ts')).toBe('const a = 1\nconst b = 20\nconst c = 3\n')
    expect(await get('new/n.ts')).toBe('line1\nline2\n')
    expect(await H.exists('del.txt')).toBe(false)
    expect(await H.exists('src/old.ts')).toBe(false)
    expect(await get('src/renamed.ts')).toBe('export const v = 2\n')
  })

  it('ханк со смещением и неверными номерами, хвостовые пробелы, без счётчиков', async () => {
    await put('f.py', '# header\n# more\n\ndef f():\n    return 1   \n\ndef g():\n    return 2\n')
    const patch = ['--- f.py', '+++ f.py', '@@ -1 +1 @@', ' def f():', '-    return 1', '+    return 10', '', ' def g():'].join('\n')
    const r = await run('apply_patch', { patch })
    expect(r.text).toContain('hunk 1 applied at line 4 (offset +3) (whitespace/punctuation-tolerant match)')
    expect(await get('f.py')).toBe('# header\n# more\n\ndef f():\n    return 10\n\ndef g():\n    return 2\n')
  })

  it('из нескольких мест — ближайшее к номеру строки; CRLF файла сохраняется', async () => {
    await put('r.txt', 'x\r\ny\r\nx\r\ny\r\n')
    await run('apply_patch', { patch: ['--- r.txt', '+++ r.txt', '@@ -3,2 +3,2 @@', ' x', '-y', '+Y'].join('\n') })
    expect(await get('r.txt')).toBe('x\r\ny\r\nx\r\nY\r\n')
  })

  it('всё или ничего: один ханк не лёг — ни один файл не тронут', async () => {
    await put('ok.txt', 'a\n')
    await put('bad.txt', 'b\n')
    const patch = ['--- ok.txt', '+++ ok.txt', '@@ -1 +1 @@', '-a', '+A', '--- bad.txt', '+++ bad.txt', '@@ -1 +1 @@', '-zzz', '+Z'].join('\n')
    await expect(run('apply_patch', { patch })).rejects.toThrow(/hunk 1 \(@@ -1\) does not match bad.txt/)
    expect(await get('ok.txt')).toBe('a\n')
    expect(await get('bad.txt')).toBe('b\n')
  })

  it('создание поверх существующего и правка отсутствующего — ошибки', async () => {
    await put('e.txt', 'e\n')
    await expect(run('apply_patch', { patch: '--- /dev/null\n+++ e.txt\n@@ -0,0 +1 @@\n+x' })).rejects.toThrow(/already exists/)
    await expect(run('apply_patch', { patch: '--- nope.txt\n+++ nope.txt\n@@ -1 +1 @@\n-a\n+b' })).rejects.toThrow(/file not found: nope.txt/)
  })

  it('без перевода строки в конце — маркер сохраняется', async () => {
    await put('n.txt', 'a\nb')
    await run('apply_patch', { patch: ['--- n.txt', '+++ n.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'].join('\n') })
    expect(await get('n.txt')).toBe('a\nc')
  })
})
})
}
