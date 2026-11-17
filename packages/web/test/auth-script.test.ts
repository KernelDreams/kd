import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@kerneldreams/nrd'
import { compileAuthScript } from '../src/adapter/auth-script.js'
import { extractAuthScript as extractFromProfile } from '../src/adapter/profile.js'
import { loadAdapter } from '../src/adapter/load.js'

let root: string
let counterFile: string

const scriptCounter = [
  '## $auth',
  '```ts',
  "import { appendFileSync } from 'node:fs'",
  'export default async (cdp, helpers) => {',
  "  appendFileSync(process.env.NRWEB_AUTH_COUNT, 'x')",
  "  return { headers: { authorization: 'Bearer live' } }",
  '}',
  '```',
  '',
].join('\n')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nrweb-auth-'))
  counterFile = join(root, 'count.txt')
  await mkdir(join(root, 'site'), { recursive: true })
  // fetch profile WITH an inline auth script
  await writeFile(
    join(root, 'site', 'scripted.mdz'),
    '$domain: site\n$transport: fetch\n\n' + scriptCounter,
    'utf-8',
  )
  // fetch profile WITHOUT a script (static token)
  await writeFile(
    join(root, 'site', 'static.mdz'),
    ['$domain: site', '$transport: fetch', '$auth-header: Authorization', '$auth-scheme: Bearer', '$token: tkn', ''].join('\n'),
    'utf-8',
  )
  process.env.NRWEB_AUTH_COUNT = counterFile
})

afterAll(async () => {
  delete process.env.NRWEB_AUTH_COUNT
  await rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  writeFileSync(counterFile, '')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function count(): Promise<number> {
  const t = await readFile(counterFile, 'utf-8')
  return t.length
}

describe('## $auth extraction + execution', () => {
  it('extracts the block body and runs it; cdp is null for fetch', async () => {
    const text = [
      '$domain: site',
      '$transport: fetch',
      '',
      '## $auth',
      '```ts',
      'export default async (cdp, helpers) => {',
      "  return { headers: { authorization: 'Bearer ' + (cdp === null ? 'nocdp' : 'cdp') } }",
      '}',
      '```',
    ].join('\n')
    const doc = parse(text, { sigil: '$' })
    const body = extractFromProfile(doc)
    expect(body).toBeTruthy()

    const compiled = await compileAuthScript(body!)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = await compiled.value(null, {
      fetch: async () => ({ ok: true, value: { status: 200, headers: {}, body: new Uint8Array() } }),
      log: () => {},
    })
    expect(result.headers?.authorization).toBe('Bearer nocdp')
  })
})

describe('retry on 401/403 — exactly once', () => {
  it('re-auths and retries exactly once, then returns the second 401', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await loadAdapter('site/scripted', [root])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = await r.value.deliver({ method: 'GET', url: 'https://site/x' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.value.status).toBe(401)

    // one original + exactly one retry
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // auth script executed twice (initial + re-auth)
    expect(await count()).toBe(2)
  })

  it('no script → no retry (401 returned immediately)', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await loadAdapter('site/static', [root])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = await r.value.deliver({ method: 'GET', url: 'https://site/x' })
    expect(d.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('auth cache — script runs once across successful delivers', () => {
  it('caches the auth result (one execution over three 200s)', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await loadAdapter('site/scripted', [root])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await r.value.deliver({ method: 'GET', url: 'https://site/a' })
    await r.value.deliver({ method: 'GET', url: 'https://site/b' })
    await r.value.deliver({ method: 'GET', url: 'https://site/c' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await count()).toBe(1)
  })
})
