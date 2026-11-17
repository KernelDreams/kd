/**
 * Хост-тест Node (процессы — только у Node-хоста). exec + process: foreground (код выхода, ошибка), уход в фон по yieldMs,
 * poll с курсором и ожиданием, write в stdin, kill всей группы (дети sh),
 * отмена рана убивает процесс, killAll, превью — команда и cwd.
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExecTools } from '../src/exec/exec.js'
import { createProcessRegistry } from '../src/node/processes.js'
import type { ProcessRegistry } from '../src/host.js'
import { fsOf } from '@kerneldreams/chat-store/fs'
import { createNodeFileSystem } from '@kerneldreams/chat-store/node-fs'
import type { ToolContext, ToolDef, ToolResult } from '../src/types.js'

let dir: string
let processes: ProcessRegistry
let exec: ToolDef
let proc: ToolDef

const ctxOf = (signal = new AbortController().signal, sessionId = 's1'): ToolContext => ({ signal, sessionId, callId: 'c', ask: async () => undefined })

async function call(t: ToolDef, args: Record<string, unknown>, ctx = ctxOf()): Promise<ToolResult> {
  const raw = await t.execute(args, ctx)
  return typeof raw === 'string' ? { text: raw } : raw
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nr-exec-'))
  processes = createProcessRegistry()
  ;[exec, proc] = createExecTools({ cwd: dir, processes, fs: fsOf(createNodeFileSystem()) }) as [ToolDef, ToolDef]
})
afterEach(() => {
  processes.killAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('exec', () => {
  it('foreground: вывод, код 0; ненулевой код — isError', async () => {
    const ok = await call(exec, { command: 'echo hi; echo err >&2' })
    expect(ok.text).toBe('hi\nerr\n\n[exit code 0]')
    expect(ok.isError).toBeUndefined()
    const bad = await call(exec, { command: 'echo nope; exit 3' })
    expect(bad.text).toBe('nope\n\n[exit code 3]')
    expect(bad.isError).toBe(true)
    expect(processes.list()).toEqual([]) // завершённые не копятся
  })

  it('workdir, env и граница cwd', async () => {
    execSync(`mkdir -p ${join(dir, 'sub')}`)
    expect((await call(exec, { command: 'pwd; echo $FOO', workdir: 'sub', env: { FOO: 'bar' } })).text).toMatch(/sub\nbar\n/)
    await expect(call(exec, { command: 'pwd', workdir: '/' })).rejects.toThrow(/path outside workspace/)
  })

  it('ABC-738: NR_SESSION — id сессии вызова; явный env главнее', async () => {
    expect((await call(exec, { command: 'echo $NR_SESSION' })).text).toMatch(/^s1\n/)
    expect((await call(exec, { command: 'echo $NR_SESSION', env: { NR_SESSION: 'x' } })).text).toMatch(/^x\n/)
  })

  it('превью — команда и cwd', async () => {
    expect(await exec.preview!({ command: 'npm test', workdir: '.' }, ctxOf())).toEqual({ kind: 'command', command: 'npm test', cwd: dir })
  })

  it('yieldMs → фон, poll по курсору, kill убивает группу', async () => {
    const r = await call(exec, { command: 'echo start; sleep 30 & echo $! > child.pid; wait', yieldMs: 300 })
    expect(r.text).toMatch(/running in the background: processId p1/)
    expect(r.text).toContain('start')
    const id = (r.data as { processId: string }).processId
    const childPid = Number(execSync(`cat ${join(dir, 'child.pid')}`).toString().trim())
    expect(alive(childPid)).toBe(true)

    const p1 = await call(proc, { action: 'poll', processId: id })
    expect(p1.text).toBe('(no new output)\n\n[process p1: running]')
    expect((await call(proc, { action: 'list' })).text).toMatch(/^p1 {2}running {2}pid \d+ {2}\d+s {2}echo start/)

    const k = await call(proc, { action: 'kill', processId: id })
    expect(k.text).toBe('Process p1 killed.')
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(childPid)).toBe(false) // и ребёнок sh
  })

  it('poll с waitMs ждёт нового вывода и конца', async () => {
    const r = await call(exec, { command: 'sleep 0.3; echo later; sleep 0.3; echo done', background: true })
    const id = (r.data as { processId: string }).processId
    const p = await call(proc, { action: 'poll', processId: id, waitMs: 5000 })
    expect(p.text).toContain('later')
    await processes.wait(id, 5000)
    const end = await call(proc, { action: 'poll', processId: id })
    expect(end.text).toBe('done\n\n[process p1: exited with code 0]')
  })

  it('write в stdin', async () => {
    const r = await call(exec, { command: 'read line; echo "got $line"', yieldMs: 100 })
    const id = (r.data as { processId: string }).processId
    await call(proc, { action: 'write', processId: id, input: 'hello\n' })
    const p = await call(proc, { action: 'poll', processId: id, waitMs: 3000 })
    expect(p.text).toContain('got hello')
  })

  it('отмена рана во время ожидания — процесс убит, ошибка aborted', async () => {
    const ac = new AbortController()
    const pending = call(exec, { command: 'sleep 30', yieldMs: 10_000 }, ctxOf(ac.signal))
    await new Promise((r) => setTimeout(r, 100))
    const pid = processes.list()[0]!.pid!
    ac.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(pid)).toBe(false)
  })

  it('процесс чужой сессии не виден; killAll гасит всё', async () => {
    const r = await call(exec, { command: 'sleep 30', background: true })
    const id = (r.data as { processId: string }).processId
    await expect(call(proc, { action: 'poll', processId: id }, ctxOf(undefined, 'other'))).rejects.toThrow(/no process p1 in this session/)
    const pid = processes.get(id)!.pid!
    expect(processes.killAll()).toBe(1)
    await processes.wait(id, 2000)
    expect(alive(pid)).toBe(false)
  })

  it('timeoutSeconds убивает фоновый процесс', async () => {
    const r = await call(exec, { command: 'sleep 30', background: true, timeoutSeconds: 0.3 })
    const id = (r.data as { processId: string }).processId
    expect(await processes.wait(id, 3000)).toBe(true)
    const p = await call(proc, { action: 'poll', processId: id })
    expect(p.text).toMatch(/timeout: killed after 0s[\s\S]*\[process p1: killed/)
  })
})

describe('exec: запрет-лист (ABC-345)', () => {
  it('команда под правилом — отказ результатом тула без запуска; прочие идут', async () => {
    const [ex] = createExecTools({
      cwd: dir,
      processes,
      fs: fsOf(createNodeFileSystem()),
      deny: ['\\brunz\\s+release\\b', { pattern: 'launchctl\\b.*studio\\.prod\\.', reason: 'prod-стенд' }],
    }) as [ToolDef]
    const r = await call(ex, { command: `touch ${join(dir, 'x')} && runz release --dist chat` })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/deny list/)
    expect((r.data as { denied?: boolean }).denied).toBe(true)
    expect(processes.list()).toHaveLength(0)
    expect(() => execSync(`test -e ${join(dir, 'x')}`)).toThrow()
    const p = await call(ex, { command: 'launchctl kickstart -k gui/501/studio.prod.nr' })
    expect(p.text).toContain('prod-стенд')
    const ok = await call(ex, { command: 'echo fine' })
    expect(ok.isError).toBeFalsy()
    expect(ok.text).toContain('fine')
  })
})

describe('askpass (ABC-357)', () => {
  it('SUDO_ASKPASS: хелпер спрашивает через ask, пароль идёт процессу, не в вывод и не в данные', async () => {
    const asked: Array<{ kind: string; payload: unknown }> = []
    const ctx: ToolContext = { ...ctxOf(), ask: async (kind, payload) => (asked.push({ kind, payload }), 's3cret') }
    // Хелпер = то, что вызвал бы sudo: SUDO_ASKPASS "Password:".
    const r = await call(exec, { command: 'got=$("$SUDO_ASKPASS" "[sudo] password:"); [ "$got" = "$(printf s3c%s ret)" ] && echo match || echo mismatch' }, ctx)
    expect(r.text).toContain('match')
    expect(r.text).not.toContain('s3cret')
    expect(JSON.stringify(r.data)).not.toContain('s3cret')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.kind).toBe('text')
    expect(asked[0]!.payload).toMatchObject({ question: '[sudo] password:', secret: true })
  })

  it('sudo в PATH — шим с -A, а при -n/-S вызов не трогается', async () => {
    const ctx: ToolContext = { ...ctxOf(), ask: async () => 'x' }
    const r = await call(exec, { command: 'command -v sudo' }, ctx)
    expect(r.text).toContain('nr-askpass-')
    expect(r.text).toMatch(/\/sudo\n/)
  })

  it('отказ пользователя (пустой ответ) — хелпер выходит с ошибкой; сокет и скрипт убраны', async () => {
    const ctx: ToolContext = { ...ctxOf(), ask: async () => '' }
    const r = await call(exec, { command: 'echo "$SUDO_ASKPASS" > ap.txt; "$SUDO_ASKPASS" "p:"; echo rc=$?' }, ctx)
    expect(r.text).toContain('rc=1')
    const { readFileSync, existsSync } = await import('node:fs')
    expect(existsSync(readFileSync(join(dir, 'ap.txt'), 'utf-8').trim())).toBe(false)
  })

  it('не пустой пароль с пробелами и $ доходит как есть', async () => {
    const ctx: ToolContext = { ...ctxOf(), ask: async () => 'p a$s "x"' }
    const r = await call(exec, { command: 'got=$("$SUDO_ASKPASS" "p:"); [ "$got" = \'p a$s "x"\' ] && echo same || echo diff' }, ctx)
    expect(r.text).toContain('same')
  })
})

describe('shellOf (ABC-496)', () => {
  it('POSIX — /bin/sh -c, Windows — cmd.exe /d /s /c в кавычках', async () => {
    const { shellOf } = await import('../src/node/processes.js')
    expect(shellOf('echo hi', false)).toEqual(['/bin/sh', ['-c', 'echo hi']])
    const [sh, args] = shellOf('dir "C:\\x" & ver', true)
    expect(sh).toMatch(/cmd\.exe$/i)
    expect(args).toEqual(['/d', '/s', '/c', '"dir "C:\\x" & ver"'])
  })
})

describe('вывод Windows: UTF-8 или cp866 (ABC-496)', () => {
  it('cp866 — по первому не-ASCII куску, UTF-8 — как есть, обрыв UTF-8 на стыке кусков', async () => {
    const { createOutputDecoder, decodeCp866 } = await import('../src/node/oem.js')
    const cp = Buffer.from([0x8f, 0xa0, 0xaf, 0xaa, 0xa0, 0x20, 0xe0, 0xa5, 0xe4, 0xf1]) // «Папка рефё» в cp866
    expect(decodeCp866(cp)).toBe('Папка рефё')
    const oem = createOutputDecoder(true)
    expect(oem(Buffer.from('dir\r\n'))).toBe('dir\r\n')
    expect(oem(cp)).toBe('Папка рефё')
    const u = createOutputDecoder(true)
    const b = Buffer.from('Привет')
    expect(u(b.subarray(0, 3)) + u(b.subarray(3))).toBe('Привет')
    const posix = createOutputDecoder(false)
    expect(posix(Buffer.from('ок'))).toBe('ок')
  })
})
