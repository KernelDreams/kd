import { createHash, createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hmacSha256, rawSignMessage, sha256, signRaw } from '../src/sign.js'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('sign (ABC-844)', () => {
  it('sha256 совпадает с node:crypto на разных длинах (границы блока)', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = new Uint8Array(randomBytes(n))
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
  it('hmac совпадает с node:crypto, ключ длиннее блока и UTF-8', () => {
    for (const key of ['k', 'x'.repeat(100), 'ключ-🔑']) {
      expect(hex(hmacSha256(key, '/путь/картинка.png\nmini\n256'))).toBe(createHmac('sha256', key).update('/путь/картинка.png\nmini\n256').digest('hex'))
    }
  })
  it('signRaw — base64url HMAC сообщения path\\nhost\\nthumb', () => {
    const msg = rawSignMessage({ path: '/a b/c.png', thumb: 512 })
    expect(msg).toBe('/a b/c.png\n\n512')
    expect(signRaw('key', { path: '/a b/c.png', thumb: 512 })).toBe(createHmac('sha256', 'key').update(msg).digest('base64url'))
  })
})
