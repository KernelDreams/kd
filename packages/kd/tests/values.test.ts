/**
 * Tab по данным (§6): значения видов из блоков `## $complete` и встроенных источников —
 * машины (`## $hosts`), боты (`$bots`), сессии, модели провайдера; сеть — до 300 мс,
 * не успел — пусто и обновление в стороне, протухший кэш — сразу.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { complete, completeAll } from '../src/complete-fast.js'
import { cwdKey, netValues, pick } from '../src/complete-values.js'
import { main, type Io } from '../src/node/cli.js'
import type { CompletionCache } from '../src/node/cache.js'

let root: string
let env: NodeJS.ProcessEnv
let server: Server
let port = 0
let delay = 0
let hits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () =>
      setTimeout(() => {
        if (req.url === '/v1/models') {
          res.end(JSON.stringify({ data: [{ id: 'm-alpha' }, { id: 'm-beta' }] }))
          return
        }
        // Как MCP: JSON внутри строки, ответ SSE.
        const items = JSON.stringify({ items: [{ project_key: 'AB', number: 12, title: 'первая' }, { project_key: 'AB', number: 7, title: 'вторая' }] })
        res.setHeader('content-type', 'text/event-stream')
        res.end(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: items }] }, auth: req.headers.authorization, body })}\n\n`)
      }, delay),
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port

  root = mkdtempSync(join(tmpdir(), 'kd-values-'))
  const home = join(root, 'home', '.kd')
  const work = join(root, 'w')
  mkdirSync(join(work, '.kd', 'tools'), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, 'bots'), { recursive: true })
  writeFileSync(join(root, 'bots', 'cat.json'), '{}')
  writeFileSync(join(root, 'bots', 'dog.mdz'), '')
  writeFileSync(join(root, 'hosts.mdz'), ['## $hosts alpha', '$ssh: a', '', '## $hosts beta', '$ssh: b'].join('\n'))
  writeFileSync(join(root, 'config.md'), ['$bots: ' + join(root, 'bots'), '', '## $tracker', '$token: t-secret', ''].join('\n'))
  writeFileSync(
    join(home, 'settings.mdz'),
    [
      `$layers: $[${join(root, 'config.md')}]`,
      '',
      '## $complete host',
      `$blocks: ${join(root, 'hosts.mdz')}`,
      '$section: hosts',
      '',
      '## $complete skill',
      '$list: $[one, two]',
      '',
      '## $complete task',
      `$url: http://127.0.0.1:${port}/mcp`,
      '$headers.authorization: Bearer ${tracker.token}',
      `$body: '{"a":1}'`,
      '$path: result.content.0.text.items',
      '$value: "{project_key}-{number}"',
      '$label: title',
    ].join('\n'),
  )
  writeFileSync(join(home, 'providers.mdz'), ['$default_provider: local', '', '## $provider local', '$type: openai', `$base_url: http://127.0.0.1:${port}/v1`, '$api_key: ${env.LOCAL_KEY}'].join('\n'))
  writeFileSync(
    join(work, '.kd', 'tools', 'pick.mdz'),
    ['$description: выбор', '', '## $form', '$host: string? $pos=1 $kind=host // Машина', '$model: string? // Модель', '$bot: string? $kind=bot // Бот', '$session: string? $kind=session // Сессия', '$skill: string? // Скилл'].join('\n'),
  )
  writeFileSync(join(work, '.kd', 'links.mdz'), ["## $link task", "$pattern: '[A-Z]{2}-\\d+'", '$kind: task'].join('\n'))
  mkdirSync(join(home, 'sessions', cwdKey(work)), { recursive: true })
  writeFileSync(join(home, 'sessions', cwdKey(work), '2026-11-15-a.mds'), '')
  env = { PATH: process.env.PATH, HOME: join(root, 'home'), KD_HOME: home }
  const io: Io = { stdout: () => {}, stderr: () => {}, readStdin: async () => '', interactive: false, cwd: work, env }
  await main([], io)
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  rmSync(root, { recursive: true, force: true })
})

const cache = (): CompletionCache => JSON.parse(readFileSync(join(root, 'home', '.kd', 'cache', 'catalog.json'), 'utf8')) as CompletionCache
const cacheDir = (): string => join(root, 'home', '.kd', 'cache')

describe('Tab по данным', () => {
  it('источники собраны в кэш: заявленные и встроенные, ключ блока подставлен', () => {
    const v = cache().values
    expect(v.map((s) => s.kind).sort()).toEqual(['bot', 'host', 'model', 'session', 'skill', 'task'])
    expect(v.find((s) => s.kind === 'task')!.headers!.authorization).toBe('Bearer t-secret')
    // Ключ провайдера остаётся ссылкой на окружение до вызова.
    expect(v.find((s) => s.kind === 'model')!.headers!.authorization).toBe('Bearer ${env.LOCAL_KEY}')
  })
  it('локальные: машины позиционным словом и полем, боты, скиллы списком, сессии папки', () => {
    const w = join(root, 'w')
    expect(complete(['pick', ''], cache(), w)).toEqual(expect.arrayContaining(['alpha', 'beta']))
    expect(complete(['pick', '--host=b'], cache(), w)).toEqual(['--host=beta'])
    expect(complete(['pick', '--bot='], cache(), w).sort()).toEqual(['--bot=cat', '--bot=dog'])
    expect(complete(['pick', '--skill=t'], cache(), w)).toEqual(['--skill=two'])
    expect(complete(['pick', '--session='], cache(), w)).toEqual(['--session=2026-11-15-a'])
  })
  it('сеть: модели провайдера по умолчанию с ключом из окружения, задачи из SSE с JSON в строке', async () => {
    const w = join(root, 'w')
    const out = await completeAll(['pick', '--model=m-a'], cache(), w, cacheDir(), { LOCAL_KEY: 'k' })
    expect(out).toEqual(['--model=m-alpha'])
    const tasks = await completeAll(['AB-1'], cache(), w, cacheDir(), {})
    expect(tasks).toContain('AB-12\tпервая')
    expect(tasks.some((l) => l.startsWith('AB-7'))).toBe(false)
  })
  it('не успел за бюджет — пусто и обновление в стороне; протухший кэш — сразу и обновление', async () => {
    const dir = mkdtempSync(join(root, 'c-'))
    const src = [{ kind: 'model', url: `http://127.0.0.1:${port}/v1/models`, path: 'data', value: 'id', ttl: 1 }]
    delay = 500
    const asked: string[] = []
    const t = Date.now()
    expect(await netValues(src, 'model', dir, {}, { budget: 100, refresh: (k) => asked.push(k) })).toEqual([])
    expect(Date.now() - t).toBeLessThan(400)
    expect(asked).toEqual(['model'])
    delay = 0
    expect(await netValues(src, 'model', dir, {}, { force: true })).toEqual(['m-alpha', 'm-beta'])
    hits = 0
    expect(await netValues(src, 'model', dir, {}, { refresh: (k) => asked.push(k) })).toEqual(['m-alpha', 'm-beta'])
    expect(hits).toBe(0) // свежий — из кэша
    await new Promise((r) => setTimeout(r, 1100))
    expect(await netValues(src, 'model', dir, {}, { refresh: (k) => asked.push(k) })).toEqual(['m-alpha', 'm-beta'])
    expect(hits).toBe(0)
    expect(asked).toEqual(['model', 'model'])
  })
  it('путь по ответу: строки и объекты, шаблон значения, нет массива — пусто', () => {
    expect(pick('["a","b"]', '', 'id')).toEqual(['a', 'b'])
    expect(pick({ x: { y: [{ id: 1 }, { id: null }] } }, 'x.y', 'id')).toEqual(['1'])
    expect(pick({ x: 1 }, 'x.y', 'id')).toEqual([])
  })
})
