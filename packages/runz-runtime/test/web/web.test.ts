import { describe, it, expect, afterEach } from 'vitest'
import { serve } from '../../src/web/index.ts'
import type { ServeHandle } from '../../src/web/index.ts'
import { runzHome } from '../../src/home.ts'

// Встроенные скрипты — у CLI runz (вне kd до шага 7): тесты на них идут при RUNZ_HOME=<репа runz>.
const withCli = !!runzHome()

let handle: ServeHandle | null = null

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
})

describe('@kerneldreams/runz-runtime/web', () => {
  it.skipIf(!withCli)('GET /scripts lists built-in scripts', async () => {
    handle = await serve({ port: 0 })
    // port 0 → OS picks; read actual port from the server address
    const addr = handle.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : handle.port
    const res = await fetch(`http://127.0.0.1:${port}/scripts`)
    expect(res.status).toBe(200)
    const json = await res.json() as { scripts: string[] }
    expect(json.scripts).toContain('template')
    expect(json.scripts).toContain('chat')
  })

  it.skipIf(!withCli)('POST /run executes a script through the runtime', async () => {
    handle = await serve({ port: 0 })
    const addr = handle.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : handle.port
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'template', args: { body: 'hi ${name}', name: 'web' } }),
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { output: string; exitCode: number }
    expect(json.output).toBe('hi web')
    expect(json.exitCode).toBe(0)
  })

  it('rejects requests without the bearer key', async () => {
    handle = await serve({ port: 0, key: 'secret123' })
    const addr = handle.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : handle.port

    const unauth = await fetch(`http://127.0.0.1:${port}/scripts`)
    expect(unauth.status).toBe(401)

    const auth = await fetch(`http://127.0.0.1:${port}/scripts`, {
      headers: { Authorization: 'Bearer secret123' },
    })
    expect(auth.status).toBe(200)
  })

  it('returns 404 for unknown routes', async () => {
    handle = await serve({ port: 0 })
    const addr = handle.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : handle.port
    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
  })
})
