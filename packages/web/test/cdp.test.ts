import { describe, it, expect } from 'vitest'
import { buildFetchExpression } from '../src/transport/cdp.js'
import type { WebRequest } from '../src/types.js'

describe('buildFetchExpression', () => {
  it('text/json body is embedded as a string literal', () => {
    const req: WebRequest = {
      method: 'POST',
      url: 'https://api.site/x',
      headers: { 'content-type': 'application/json' },
      body: '{"q":1}',
    }
    const expr = buildFetchExpression(req)
    expect(expr).toContain('fetch("https://api.site/x"')
    expect(expr).toContain('method: "POST"')
    expect(expr).toContain('init.body = "{\\"q\\":1}"')
    expect(expr).toContain('bodyBase64')
  })

  it('binary body goes through a base64 → Uint8Array bridge', () => {
    const req: WebRequest = {
      method: 'PUT',
      url: 'https://s3/put',
      body: new Uint8Array([0, 1, 2, 250]),
    }
    const expr = buildFetchExpression(req)
    expect(expr).toContain('Uint8Array.from(atob(')
    // AAEC+g== is base64 of [0,1,2,250]
    expect(expr).toContain('AAEC+g==')
  })

  it('multipart assembles FormData in the page and never sets Content-Type', () => {
    const req: WebRequest = {
      method: 'POST',
      url: 'https://s3/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=xxx', authorization: 'Bearer t' },
      body: {
        kind: 'multipart',
        fields: { key: 'v', policy: 'p' },
        file: {
          field: 'file',
          bytes: new Uint8Array([9, 9]),
          filename: 'a.png',
          mime: 'image/png',
        },
      },
    }
    const expr = buildFetchExpression(req)
    expect(expr).toContain('new FormData()')
    expect(expr).toContain('__fd.append("key", "v")')
    expect(expr).toContain('__fd.append("policy", "p")')
    expect(expr).toContain('new Blob([Uint8Array.from(atob(')
    expect(expr).toContain('"image/png"')
    expect(expr).toContain('"a.png"')
    expect(expr).toContain('init.body = __fd')
    // Content-Type stripped from headers, Authorization kept.
    expect(expr).not.toContain('multipart/form-data')
    expect(expr).toContain('"authorization":"Bearer t"')
  })

  it('credentials mode is emitted when set', () => {
    const expr = buildFetchExpression(
      { method: 'GET', url: 'https://x' },
      { credentials: 'include' },
    )
    expect(expr).toContain('init.credentials = "include"')
  })
})
