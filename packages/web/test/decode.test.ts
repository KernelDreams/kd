import { describe, it, expect } from 'vitest'
import { asText, asJson } from '../src/decode.js'
import type { WebResponse } from '../src/types.js'

function res(bytes: Uint8Array): WebResponse {
  return { status: 200, headers: {}, body: bytes }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('asText', () => {
  it('decodes utf-8 bytes to text', () => {
    expect(asText(res(enc('héllo ✓')))).toBe('héllo ✓')
  })
})

describe('asJson', () => {
  it('parses valid JSON → ok', () => {
    const r = asJson<{ a: number }>(res(enc('{"a":1}')))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.a).toBe(1)
  })

  it('invalid JSON → err (not a throw)', () => {
    const r = asJson(res(enc('{not json')))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(Error)
  })
})
