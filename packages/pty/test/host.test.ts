/**
 * Живые тесты на настоящем tmux (свой сокет, свой каталог потоков): §7 п.1, 4, 5 и WebSocket.
 * Нет tmux — пропуск.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPtyHost, findTmux, type PtyHost } from '../src/index.js'

const tmux = findTmux()
const socket = `nr-pty-test-${process.pid}`
const dir = mkdtempSync(join(tmpdir(), 'nr-pty-'))
const opts = { socket, stateDir: join(dir, 'state'), shell: '/bin/zsh', home: dir, log: () => {} }

function keys(...args: string[]): void {
  execFileSync(tmux!, ['-L', socket, 'send-keys', '-t', '=nr-t1:', ...args])
}

describe.skipIf(!tmux)('nr-pty на tmux', () => {
  let host: PtyHost

  beforeAll(async () => {
    host = await createPtyHost(opts)
    await host.ensure('t1', { cwd: dir })
  }, 30_000)

  afterAll(async () => {
    await host?.close()
    try {
      execFileSync(tmux!, ['-L', socket, 'kill-server'])
    } catch {
      // уже нет
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('execute: вывод и код 0; false — код 1', async () => {
    const r = await host.run({ terminal: 't1', command: 'echo hello-$((40+2))', mode: 'execute', wait: 20 })
    expect(r).toMatchObject({ status: 'done', code: 0, output: 'hello-42' })
    const f = await host.run({ terminal: 't1', command: 'false', mode: 'execute' })
    expect(f).toMatchObject({ status: 'done', code: 1 })
  }, 40_000)

  it('insert: команда стоит в строке, Enter — человек', async () => {
    const pending = host.run({ terminal: 't1', command: 'echo inserted', mode: 'insert', timeout: 10 })
    await new Promise((r) => setTimeout(r, 800))
    const screen = await host.read({ terminal: 't1', lines: 3 })
    expect(screen.text).toContain('echo inserted')
    keys('Enter')
    expect(await pending).toMatchObject({ status: 'done', code: 0, output: 'inserted' })
  }, 20_000)

  it('insert без Enter — pending; строку не трогаем', async () => {
    const r = await host.run({ terminal: 't1', command: 'echo never', mode: 'insert', timeout: 1 })
    expect(r.status).toBe('pending')
    keys('C-u')
  }, 20_000)

  it('человек набирает — агент ждёт, строки не смешались', async () => {
    keys('-l', 'echo human')
    await new Promise((r) => setTimeout(r, 300))
    const busy = await host.run({ terminal: 't1', command: 'echo agent', mode: 'execute', wait: 1 })
    expect(busy).toMatchObject({ status: 'busy' })
    // Человек дописал и нажал Enter — агент, ждавший промпта, идёт следом.
    const waiting = host.run({ terminal: 't1', command: 'echo agent', mode: 'execute', wait: 10 })
    await new Promise((r) => setTimeout(r, 300))
    keys('Enter')
    expect(await waiting).toMatchObject({ status: 'done', code: 0, output: 'agent' })
    const screen = await host.read({ terminal: 't1', lines: 20 })
    expect(screen.text).toContain('human')
    expect(screen.text).not.toContain('echo humanecho agent')
  }, 30_000)

  it('пароль мимо агента: ввод при выключенном эхе в вывод не попадает (§5)', async () => {
    const run = host.run({ terminal: 't1', command: 'read -s "p?Password:"; echo; echo got-${#p}', mode: 'execute', timeout: 10 })
    await new Promise((r) => setTimeout(r, 700))
    keys('-l', 'secret-123')
    keys('Enter')
    const r = await run
    expect(r).toMatchObject({ status: 'done', code: 0 })
    expect(r.output).toContain('got-10')
    expect(r.output).not.toContain('secret-123')
    expect((await host.read({ terminal: 't1', lines: 50 })).text).not.toContain('secret-123')
  }, 20_000)

  it('перезапуск сервера: сессия подхвачена, состояние восстановлено, run работает', async () => {
    await host.close()
    host = await createPtyHost(opts)
    const list = await host.list()
    expect(list.map((t) => t.id)).toContain('t1')
    expect(list.find((t) => t.id === 't1')?.state).toBe('prompt')
    const r = await host.run({ command: 'echo after-restart', mode: 'execute' })
    expect(r).toMatchObject({ status: 'done', code: 0, output: 'after-restart', terminal: 't1' })
  }, 30_000)

  it('WebSocket: вкладка видит экран и вводит', async () => {
    const srv = createServer()
    srv.on('upgrade', (req, sock, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      host.upgrade(req, sock, head, url.pathname.split('/')[2] ?? '', url.searchParams)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty/t1/attach?cols=100&rows=30`)
    let screen = ''
    const states: string[] = []
    ws.onmessage = (e) => {
      const s = String(e.data)
      if (s[0] === 'o') screen += s.slice(1)
      if (s[0] === 's') states.push(JSON.parse(s.slice(1)).state)
    }
    await new Promise((r, j) => {
      ws.onopen = r
      ws.onerror = j
    })
    ws.send('iecho from-tab\r')
    await new Promise((r) => setTimeout(r, 50))
    const r = await host.run({ terminal: 't1', command: 'echo next', mode: 'execute', wait: 10 })
    expect(r).toMatchObject({ status: 'done', output: 'next' })
    expect(await host.read({ terminal: 't1', lines: 5 })).toMatchObject({ text: expect.stringMatching(/from-tab\n.*echo next\nnext/) })
    await new Promise((r) => setTimeout(r, 300))
    expect(screen).toContain('from-tab')
    expect(states[0]).toBe('prompt')
    ws.close()
    srv.close()
  }, 30_000)
})
