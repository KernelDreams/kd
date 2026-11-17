import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAdapter } from '../src/adapter/load.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nrweb-profiles-'))
  // bots: base + one account
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', '_base.md'),
    ['$domain: bots', '$transport: fetch', '$auth-header: Authorization', '$auth-scheme: Bearer', ''].join('\n'),
    'utf-8',
  )
  await writeFile(join(root, 'bots', 'julian.mdz'), ['$[[_base.md]]', '$token: sk-julian', ''].join('\n'), 'utf-8')
  // a non-.mdz file that must be ignored by the search
  await writeFile(join(root, 'bots', 'plain.md'), '$domain: bots\n$transport: fetch\n', 'utf-8')
  // ambiguity: same short name in two domains
  await mkdir(join(root, 'da'), { recursive: true })
  await mkdir(join(root, 'db'), { recursive: true })
  await writeFile(join(root, 'da', 'twin.mdz'), '$domain: da\n$transport: fetch\n', 'utf-8')
  await writeFile(join(root, 'db', 'twin.mdz'), '$domain: db\n$transport: fetch\n', 'utf-8')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('profile attrText — Json5Object (NTS-261, nrd-core 2.0)', () => {
  it('object-valued attribute reads as undefined, not "[object Object]"', async () => {
    const dir = join(root, 'j5')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'obj.mdz'),
      '$transport: fetch\n$domain: j5\n$base-url: https://x.example\n$headers: {auth: \'raw\', retries: 2}\n',
    )
    const r = await loadAdapter('j5/obj', [root])
    expect(r.ok).toBe(true)
    if (r.ok) {
      // объектный атрибут не должен просочиться текстом ни в одно строковое поле
      for (const v of Object.values(r.value)) {
        if (typeof v === 'string') expect(v).not.toContain('[object Object]')
      }
    }
  })
})

describe('loadAdapter — lookup & $[[include]]', () => {
  it('loads bots/julian, inherits _base.md via include, transport=fetch', async () => {
    const r = await loadAdapter('bots/julian', [root])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.transport).toBe('fetch')
      expect(r.value.domain).toBe('bots')
    }
  })

  it('deliver hangs Authorization: Bearer <token> from the profile', async () => {
    const seen: { headers?: Record<string, string> } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.headers = init.headers as Record<string, string>
        return new Response('ok', { status: 200 })
      }),
    )
    const r = await loadAdapter('bots/julian', [root])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = await r.value.deliver({ method: 'GET', url: 'https://api.bots.example/me' })
    expect(d.ok).toBe(true)
    expect(seen.headers?.Authorization).toBe('Bearer sk-julian')
  })

  it('resolves a short unique name across roots', async () => {
    const r = await loadAdapter('julian', [root])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.domain).toBe('bots')
  })

  it('never picks up _base (short name "base" → not found)', async () => {
    const r = await loadAdapter('base', [root])
    expect(r.ok).toBe(false)
  })

  it('ignores non-.mdz files (short name "plain" → not found)', async () => {
    const r = await loadAdapter('plain', [root])
    expect(r.ok).toBe(false)
  })

  it('ambiguous short name → err asking for a full name', async () => {
    const r = await loadAdapter('twin', [root])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('ambiguous')
  })
})
