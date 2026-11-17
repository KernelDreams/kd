/**
 * §9: ящик вопросов (без человека — умолчание сразу; открытое окно — ответ файлом; срок — умолчание),
 * `kd agent` без расширения агента — понятная ошибка (полный ход — тесты расширения студии), грязный текст через `--params -`
 * в шелле (zsh / bash).
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerQuestion, ask, listQuestions, registerFace } from '../src/node/inbox.js'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kd-agent-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ящик вопросов', () => {
  it('человека нет (ни терминала, ни окна) — умолчание сразу, файла вопроса нет', async () => {
    const t = Date.now()
    const r = await ask(dir, { question: 'ветка?', options: ['master', 'dev'], default: 'master' })
    expect(r).toEqual({ answer: 'master', by: 'default' })
    expect(Date.now() - t).toBeLessThan(200)
    expect(listQuestions(dir)).toEqual([])
  })
  it('открыто окно — вопрос в ящике, ответ любым лицом', async () => {
    const off = registerFace(dir, 'ui')
    try {
      const p = ask(dir, { question: 'ветка?', options: ['master', 'dev'], default: 'master', pollMs: 20, timeoutMs: 5000 })
      await new Promise((r) => setTimeout(r, 60))
      const [q] = listQuestions(dir)
      expect(q).toMatchObject({ question: 'ветка?', options: ['master', 'dev'], default: 'master' })
      expect(answerQuestion(dir, q!.id, 'dev')).toBe(true)
      expect(await p).toEqual({ answer: 'dev', by: 'human' })
      expect(listQuestions(dir)).toEqual([])
    } finally {
      off()
    }
  })
  it('срок вышел — умолчание, прогон не висит', async () => {
    const off = registerFace(dir, 'ui')
    try {
      expect(await ask(dir, { question: 'q', default: 'd', timeoutMs: 80, pollMs: 20 })).toEqual({ answer: 'd', by: 'default' })
    } finally {
      off()
    }
  })
  it('есть хаб: вопрос дублируется туда (сервис questions), ответ из хаба — в ящик; после — снят с хаба', async () => {
    const { createServer } = await import('node:http')
    const { createQuestions } = await import('@kerneldreams/backend-http')
    const q = createQuestions({ dir: join(dir, 'hub') })
    const seen: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        seen.push(`${req.url} ${req.headers.authorization ?? ''}`)
        const m = /^\/api\/services\/questions\/(\w+)$/.exec(req.url ?? '')
        try {
          const result = await q.call(m![1]!, (JSON.parse(body) as { args: unknown }).args)
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const hub = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, key: 'k1' }
    const off = registerFace(dir, 'ui')
    try {
      const p = ask(dir, { question: 'ветка?', options: ['master', 'dev'], default: 'master', pollMs: 20, hubPollMs: 30, timeoutMs: 5000, from: 'kd agent x', hub })
      await new Promise((r) => setTimeout(r, 150))
      const [open] = q.list()
      expect(open).toMatchObject({ question: 'ветка?', options: ['master', 'dev'], default: 'master', from: 'kd agent x' })
      expect(listQuestions(dir).map((x) => x.id)).toEqual([open!.id])
      q.answer(open!.id, 'dev')
      expect(await p).toEqual({ answer: 'dev', by: 'human' })
      await new Promise((r) => setTimeout(r, 100))
      expect(q.get(open!.id)).toBeNull()
      expect(seen.every((s) => s.endsWith('Bearer k1'))).toBe(true)
      expect(seen.some((s) => s.startsWith('/api/services/questions/cancel'))).toBe(true)
    } finally {
      off()
      server.close()
    }
  })
  it('хаб недоступен — одна строка предупреждения, вопрос только в ящике; человека нет — в хаб не ходит', async () => {
    const warns: string[] = []
    expect(await ask(dir, { question: 'q', default: 'd', hub: { url: 'http://127.0.0.1:1/api' }, warn: (w) => warns.push(w) })).toEqual({ answer: 'd', by: 'default' })
    expect(warns).toEqual([])
    const off = registerFace(dir, 'ui')
    try {
      expect(await ask(dir, { question: 'q', default: 'd', timeoutMs: 300, pollMs: 20, hub: { url: 'http://127.0.0.1:1/api' }, warn: (w) => warns.push(w) })).toEqual({ answer: 'd', by: 'default' })
      expect(warns.length).toBe(1)
      expect(warns[0]).toMatch(/не принял вопрос/)
    } finally {
      off()
    }
  })
  it('адрес хаба: $hub / $hub_key настроек, KD_HUB сильнее, off — нет', async () => {
    const { hubOf } = await import('../src/node/inbox.js')
    expect(hubOf({ hub: 'http://h/api/', hub_key: 'x' }, {})).toEqual({ url: 'http://h/api', key: 'x' })
    expect(hubOf({ hub: 'http://h/api' }, { KD_HUB: 'http://e/api' })).toEqual({ url: 'http://e/api' })
    expect(hubOf({ hub: 'off' }, {})).toBeUndefined()
    expect(hubOf({}, {})).toBeUndefined()
  })
  it('терминал прогона — вопрос там же', async () => {
    const r = await ask(dir, { question: 'q', default: 'd', terminal: async () => 'да', pollMs: 20 })
    expect(r).toEqual({ answer: 'да', by: 'human' })
  })
})

describe('kd agent без расширения агента', () => {
  // Агент — слот расширения `agent` (runz-runtime extensions): в открытом kd его нет.
  it('понятное сообщение и ненулевой код, без падения импортом', () => {
    mkdirSync(join(dir, 'kd'), { recursive: true })
    mkdirSync(join(dir, 'w'), { recursive: true })
    writeFileSync(join(dir, 'kd', 'providers.mdz'), '$default_provider: mock\n\n## $provider mock\n$type: mock\n')
    const r = spawnSync(process.execPath, [BIN, 'agent', 'сделай'], {
      cwd: join(dir, 'w'),
      env: { PATH: process.env.PATH, HOME: join(dir, 'home'), KD_HOME: join(dir, 'kd') },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/kd agent: агент .* не установлен/)
    expect(r.stderr + r.stdout).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/)
  })
  it('kd acp — то же: «ACP-агент не установлен», без падения импортом', () => {
    mkdirSync(join(dir, 'kd'), { recursive: true })
    mkdirSync(join(dir, 'w'), { recursive: true })
    writeFileSync(join(dir, 'kd', 'providers.mdz'), '$default_provider: mock\n\n## $provider mock\n$type: mock\n')
    const r = spawnSync(process.execPath, [BIN, 'acp'], {
      cwd: join(dir, 'w'),
      env: { PATH: process.env.PATH, HOME: join(dir, 'home'), KD_HOME: join(dir, 'kd'), KD_NO_OPEN: '1' },
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/kd acp: ACP-агент .* не установлен/)
  })
})

describe('грязный текст через --params - в шелле', () => {
  const DIRTY = 'кавычки "двойные" и \'одинарные\', обратный \\ слеш, `код`, $HOME, строка\n---\n## $заголовок\n````\nфенс\n````'
  const shells = ['bash', 'zsh'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0)
  for (const sh of shells) {
    it(sh, () => {
      mkdirSync(join(dir, 'w', '.kd', 'tools'), { recursive: true })
      writeFileSync(join(dir, 'w', '.kd', 'tools', 'echo.mjs'), 'export const tool = { fields: { text: "text // Текст" } }\nexport default (c) => ({ output: JSON.stringify(c.get(["text"])) })\n')
      const json = JSON.stringify({ text: DIRTY })
      writeFileSync(join(dir, 'p.json'), json)
      const r = spawnSync(sh, ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} echo --params - < ${JSON.stringify(join(dir, 'p.json'))}`], {
        cwd: join(dir, 'w'),
        env: { PATH: process.env.PATH, HOME: join(dir, 'home'), KD_HOME: join(dir, 'kd') },
        encoding: 'utf8',
      })
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toBe(DIRTY)
    })
  }
})
