import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseResult, runFile, runTemplate, spawnCommand } from '../src/index.js'

/** Фейковый runz: читает документ запуска, отвечает JSON; `sleep` в шаблоне — висит до SIGTERM. */
function fakeRunz(dir: string): string {
  const bin = join(dir, 'fake-runz.mjs')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
const file = process.argv[2]
const text = readFileSync(file, 'utf8')
if (!process.argv.includes('--runz-json')) process.exit(3)
if (text.includes('$sleep')) {
  process.on('SIGTERM', () => { process.stdout.write(JSON.stringify({ output: 'interrupted', exitCode: 1 }) + '\\n'); process.exit(1) })
  setInterval(() => {}, 1000)
} else if (text.includes('$env')) {
  process.stdout.write(JSON.stringify({ output: String(process.env.RR_PROBE) }) + '\\n')
} else if (text.includes('$vision')) {
  process.stdout.write(JSON.stringify({ output: 'described', outputs: [{ type: 'text', text: 'a cat' }] }) + '\\n')
} else {
  process.stderr.write('progress\\n')
  process.stdout.write(JSON.stringify({ output: 'Done', outputs: [{ type: 'image', path: '/w/gen/1.png', meta: { doc: text, file: basename(file) } }] }) + '\\n')
}
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('parseResult', () => {
  it('последняя строка stdout — ScriptResult; outputs всех типов, мусор отброшен', () => {
    const r = parseResult(
      'noise\n' +
        JSON.stringify({
          output: 'Done',
          outputs: [{ type: 'image', path: '/w/1.png', meta: { seed: 7 } }, { type: 'text', text: 't' }, { type: 'file', path: '/w/a.txt' }, { type: 'image' }, 5],
        }),
      0,
    )
    expect(r).toEqual({
      ok: true,
      outputs: [{ type: 'image', path: '/w/1.png', meta: { seed: 7 } }, { type: 'text', text: 't' }, { type: 'file', path: '/w/a.txt' }],
      output: 'Done',
      exitCode: 0,
    })
  })
  it('без outputs — ok по коду; exitCode из JSON; не JSON — не ok с текстом', () => {
    expect(parseResult(JSON.stringify({ output: 'plain' }), 0)).toEqual({ ok: true, outputs: [], output: 'plain', exitCode: 0 })
    expect(parseResult(JSON.stringify({ output: 'boom', exitCode: 1, outputs: [] }), 1)).toMatchObject({ ok: false, exitCode: 1, output: 'boom' })
    expect(parseResult('runz: script not found', 1)).toMatchObject({ ok: false, output: 'runz: script not found' })
  })
})

describe('runTemplate', () => {
  it('материализует документ рядом с шаблоном, зовёт runz --runz-json, удаляет файл запуска', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-run-'))
    const template = join(dir, 'generate.md')
    writeFileSync(template, '$type: comfy\n$prompt: default\n')
    const r = await runTemplate({ template, values: { prompt: 'apple' }, runz: [process.execPath, fakeRunz(dir)], timeoutMs: 10_000 })
    expect(r.ok).toBe(true)
    const img = r.outputs[0]
    expect(img?.type).toBe('image')
    if (img?.type !== 'image') return
    expect(img.path).toBe('/w/gen/1.png')
    expect(img.meta!.doc).toContain('$prompt: "apple"')
    expect(img.meta!.file).toMatch(/^\.generate\.run-[0-9a-f]{8}\.md$/)
    expect(r.stderr).toContain('progress')
    expect(readdirSync(dir).filter((f) => f.includes('.run-'))).toEqual([])
  })

  it('текстовый результат (vision) и расширение .mdz сохраняется у файла запуска', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-text-'))
    const template = join(dir, 'describe.mdz')
    writeFileSync(template, '$type: vision\n$vision: 1\n')
    const r = await runTemplate({ template, values: {}, runz: [process.execPath, fakeRunz(dir)], timeoutMs: 10_000 })
    expect(r).toMatchObject({ ok: true, outputs: [{ type: 'text', text: 'a cat' }], output: 'described' })
  })

  it('onLine: строки stdout/stderr по мере вывода, JSON-результат не приходит', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-lines-'))
    const template = join(dir, 'generate.md')
    writeFileSync(template, '$type: comfy\n')
    const lines: string[] = []
    const r = await runTemplate({
      template,
      values: { models: ['a', 'b, c'] },
      runz: [process.execPath, fakeRunz(dir)],
      timeoutMs: 10_000,
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
    })
    expect(r.ok).toBe(true)
    expect(lines).toEqual(['stderr:progress'])
    const img = r.outputs[0]
    expect(img?.type === 'image' && img.meta!.doc).toContain('$models: $["a", "b, c"]')
  })

  it('env уходит процессу', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-env-'))
    const template = join(dir, 'e.md')
    writeFileSync(template, '$env: 1\n')
    const r = await runTemplate({ template, values: {}, runz: [process.execPath, fakeRunz(dir)], timeoutMs: 10_000, env: { ...process.env, RR_PROBE: 'yes' } })
    expect(r.output).toBe('yes')
  })

  it('abort → SIGTERM процессу, aborted, файл запуска удалён', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-abort-'))
    const template = join(dir, 'generate.md')
    writeFileSync(template, '$type: comfy\n$sleep: 1\n')
    const ac = new AbortController()
    const p = runTemplate({ template, values: {}, runz: [process.execPath, fakeRunz(dir)], signal: ac.signal, timeoutMs: 10_000 })
    setTimeout(() => ac.abort(), 300)
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.output).toBe('interrupted')
    expect(readdirSync(dir).filter((f) => f.includes('.run-'))).toEqual([])
  })

  it('хост выходит посреди запуска → файл запуска удалён, runz получает SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-exit-'))
    const template = join(dir, 'generate.md')
    writeFileSync(template, '$sleep: 1\n')
    const bin = fakeRunz(dir)
    const host = join(dir, 'host.mjs')
    writeFileSync(
      host,
      `import { runTemplate } from ${JSON.stringify(join(import.meta.dirname, '..', 'dist', 'index.js'))}\n` +
        `runTemplate({ template: ${JSON.stringify(template)}, values: {}, runz: [process.execPath, ${JSON.stringify(bin)}], timeoutMs: 60000 })\n` +
        `setTimeout(() => process.exit(0), 400)\n`,
    )
    const { spawnSync } = await import('node:child_process')
    spawnSync(process.execPath, [host], { timeout: 10_000 })
    expect(readdirSync(dir).filter((f) => f.includes('.run-'))).toEqual([])
  })

  it('таймаут → timedOut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-to-'))
    const template = join(dir, 'generate.md')
    writeFileSync(template, '$sleep: 1\n')
    const r = await runTemplate({ template, values: {}, runz: [process.execPath, fakeRunz(dir)], timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
  })
})

/** Фейковый runz для файла как есть: печатает аргументы, пишет в stderr, отвечает JSON; `--sleep` — висит до SIGTERM. */
function fakeRunzFile(dir: string): string {
  const bin = join(dir, 'fake-runz-file.mjs')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const argv = process.argv.slice(2)
if (argv.at(-1) !== '--runz-json') process.exit(3)
if (argv.includes('--sleep')) {
  process.stdout.write('waiting\\n')
  // Внук держит stdout, как sleep у $shell-блока: SIGTERM одному runz оставил бы его.
  const { spawn } = await import('node:child_process')
  const kid = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] })
  process.stdout.write('kid=' + kid.pid + '\\n')
  process.on('SIGTERM', () => process.exit(143))
  setInterval(() => {}, 1000)
} else {
  process.stdout.write('file=' + argv[0].split('/').pop() + '\\n')
  process.stdout.write('args=' + argv.slice(1, -1).join(' ') + '\\n')
  process.stderr.write('warn 1\\nwarn 2')
  process.stdout.write(JSON.stringify({ output: 'ok', outputs: [{ type: 'file', path: '/w/out.txt' }] }) + '\\n')
}
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('runFile', () => {
  it('файл как есть + аргументы; строки stdout/stderr по мере вывода, JSON-результат — не строка', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-file-'))
    const file = join(dir, 'task.mdz')
    writeFileSync(file, '$title: t\n')
    const lines: string[] = []
    const r = await runFile({
      file,
      args: ['--prompt=кот', '-v'],
      runz: [process.execPath, fakeRunzFile(dir)],
      timeoutMs: 10_000,
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
    })
    expect(r).toMatchObject({ ok: true, output: 'ok', exitCode: 0, outputs: [{ type: 'file', path: '/w/out.txt' }] })
    expect(lines.filter((l) => l.startsWith('stdout:'))).toEqual(['stdout:file=task.mdz', 'stdout:args=--prompt=кот -v'])
    expect(lines.filter((l) => l.startsWith('stderr:'))).toEqual(['stderr:warn 1', 'stderr:warn 2'])
    // Файл запуска не создаётся: исполняется сам документ.
    expect(readdirSync(dir).filter((f) => f.includes('.run-'))).toEqual([])
  })

  it('последняя строка не JSON — это вывод, а не результат; abort → SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-file-abort-'))
    const file = join(dir, 'long.mdz')
    writeFileSync(file, '$title: t\n')
    const lines: string[] = []
    const ac = new AbortController()
    const seen: string[] = []
    const p = runFile({ file, args: ['--sleep'], runz: [process.execPath, fakeRunzFile(dir)], signal: ac.signal, timeoutMs: 10_000, onLine: (_s, l) => lines.push(l) })
    // Обычная строка уходит сразу, не дожидаясь следующей: до отмены она уже здесь.
    setTimeout(() => {
      seen.push(...lines)
      ac.abort()
    }, 400)
    const started = Date.now()
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.ok).toBe(false)
    expect(lines[0]).toBe('waiting')
    expect(seen.some((l) => l.startsWith('kid='))).toBe(true)
    // Отмена гасит группу: внук не держит stdout, `close` — сразу, а не через 30 с.
    expect(Date.now() - started).toBeLessThan(5_000)
    const kid = Number(lines.find((l) => l.startsWith('kid='))?.slice(4))
    expect(kid).toBeGreaterThan(0)
    await new Promise((res) => setTimeout(res, 100))
    expect(() => process.kill(kid, 0)).toThrow()
  })
})

describe('уборка при выходе хоста (ABC-163)', () => {
  it('runFile после runTemplate в том же процессе не стирает документ пользователя', { timeout: 60_000 }, async () => {
    const { spawnSync } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'runz-run-exit-'))
    const bin = fakeRunz(dir)
    const tpl = join(dir, 'tpl.md')
    const doc = join(dir, 'user.mdz')
    writeFileSync(tpl, '# t\n')
    writeFileSync(doc, '# user\n')
    const host = join(dir, 'host.mjs')
    // Хост — отдельный процесс на собранном пакете (`npm test` собирает его до vitest;
    // сборка здесь же сносила бы dist под параллельными тестами задач).
    const entry = new URL('../dist/index.js', import.meta.url).href
    writeFileSync(
      host,
      `import { runTemplate, runFile } from ${JSON.stringify(entry)}\n` +
        `const runz = [process.execPath, ${JSON.stringify(bin)}]\n` +
        `await runTemplate({ template: ${JSON.stringify(tpl)}, values: {}, runz })\n` +
        `await runFile({ file: ${JSON.stringify(doc)}, runz })\n`,
    )
    const r = spawnSync(process.execPath, [host], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(doc)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.includes('.run-'))).toEqual([])
  })
})

describe('spawnCommand — чем запустить runz (ABC-300)', () => {
  it('POSIX — как есть, без оболочки', () => {
    expect(spawnCommand(['runz'], ['a.md', '--x=1'], 'darwin')).toEqual({ command: 'runz', args: ['a.md', '--x=1'] })
    expect(spawnCommand(['/usr/bin/node', '/r/runz.ts'], ['a.md'], 'linux')).toEqual({ command: '/usr/bin/node', args: ['/r/runz.ts', 'a.md'] })
  })

  it('win32, [node.exe, runz.ts] — напрямую', () => {
    expect(spawnCommand(['C:\\node\\node.exe', 'S:\\runz\\bin\\runz.ts'], ['job'], 'win32')).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['S:\\runz\\bin\\runz.ts', 'job'],
    })
  })

  it('win32, голый runz (runz.cmd) — cmd /d /s /c, аргументы в кавычках, метасимволы дважды через ^', () => {
    const c = spawnCommand(['runz'], ['S:\\a b\\run.md', '--q=x&y', '--runz-json'], 'win32')
    expect(c.command).toMatch(/cmd(\.exe)?$/i)
    expect(c.windowsVerbatimArguments).toBe(true)
    expect(c.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(c.args[3]).toBe('"runz ^^^"S:\\a^^^ b\\run.md^^^" ^^^"--q=x^^^&y^^^" ^^^"--runz-json^^^""')
  })

  it('win32, явный .cmd с пробелом в пути; кавычка в аргументе — по правилам CRT', () => {
    const c = spawnCommand(['C:\\Program Files\\runz.cmd'], ['say "hi"'], 'win32')
    expect(c.args[3]).toBe('"C:\\Program^ Files\\runz.cmd ^^^"say^^^ \\^^^"hi\\^^^"^^^""')
  })
})
