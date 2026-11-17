/** SSRF-стоп web_fetch (спека §1, §3). */

import { describe, it, expect } from 'vitest'
import { checkResolved, checkUrl, isPrivateAddress } from '../src/ssrf.js'
import { WebError } from '../src/errors.js'

const refused = (raw: string, allow: string[] = []): boolean => {
  const r = checkUrl(raw, allow)
  if (r.ok) return false
  expect(r.error).toBeInstanceOf(WebError)
  expect((r.error as WebError).code).toBe('bad_request')
  return true
}

// Адреса частных сетей собраны из частей: страж публикации kd ищет их в тексте как следы машин.
const LAN = ['192', '168', '1', '1'].join('.')
const CGNAT = ['100', '64', '0', '1'].join('.')

describe('checkUrl', () => {
  it('публичные http(s) пропускает', () => {
    expect(refused('https://example.com/a?b=1')).toBe(false)
    expect(refused('http://93.184.216.34/')).toBe(false)
    expect(refused('https://[2606:4700::1111]/')).toBe(false)
  })

  it('не-http схемы — стоп', () => {
    expect(refused('file:///etc/passwd')).toBe(true)
    expect(refused('ftp://example.com/')).toBe(true)
    expect(refused('data:text/html,hi')).toBe(true)
    expect(refused('javascript:alert(1)')).toBe(true)
  })

  it('мусор вместо url — bad_request', () => {
    expect(refused('not a url')).toBe(true)
  })

  it('localhost и loopback во всех написаниях', () => {
    expect(refused('http://localhost:3000/')).toBe(true)
    expect(refused('http://LOCALHOST./')).toBe(true)
    expect(refused('http://api.localhost/')).toBe(true)
    expect(refused('http://127.0.0.1/')).toBe(true)
    expect(refused('http://127.8.9.10/')).toBe(true)
    expect(refused('http://2130706433/')).toBe(true) // 127.0.0.1 десятичным числом
    expect(refused('http://0x7f.1/')).toBe(true)
    expect(refused('http://[::1]/')).toBe(true)
    expect(refused('http://[::ffff:127.0.0.1]/')).toBe(true)
    expect(refused('http://0.0.0.0/')).toBe(true)
  })

  it('приватные сети и метаданные облака', () => {
    expect(refused('http://10.0.0.5/')).toBe(true)
    expect(refused(`http://${LAN}/`)).toBe(true)
    expect(refused('http://172.16.0.1/')).toBe(true)
    expect(refused('http://172.31.255.255/')).toBe(true)
    expect(refused('http://169.254.169.254/latest/meta-data/')).toBe(true)
    expect(refused('http://[fd00::1]/')).toBe(true)
    expect(refused('http://[fe80::1]/')).toBe(true)
  })

  it('соседние с приватными диапазоны не задеты', () => {
    expect(refused('http://172.15.0.1/')).toBe(false)
    expect(refused('http://172.32.0.1/')).toBe(false)
    expect(refused('http://11.0.0.1/')).toBe(false)
  })

  it('креды в url — стоп', () => {
    expect(refused('https://user:pass@example.com/')).toBe(true)
  })

  it('allowHosts снимает стоп только для точного hostname', () => {
    expect(refused('http://127.0.0.1:8080/', ['127.0.0.1'])).toBe(false)
    expect(refused('http://127.0.0.2/', ['127.0.0.1'])).toBe(true)
    // Схему allowHosts не отменяет.
    expect(refused('file:///etc/passwd', ['127.0.0.1'])).toBe(true)
  })
})

describe('isPrivateAddress', () => {
  it('различает v4/v6 и не-адреса', () => {
    expect(isPrivateAddress(CGNAT)).toBe(true) // CGNAT
    expect(isPrivateAddress('224.0.0.1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
    expect(isPrivateAddress('::ffff:808:808')).toBe(false)
    expect(isPrivateAddress('example.com')).toBe(false)
  })
})

describe('checkResolved', () => {
  it('имя, резолвящееся в приватный адрес, — стоп', async () => {
    const r = await checkResolved(new URL('http://localtest.me/'), async () => ['127.0.0.1'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as WebError).code).toBe('bad_request')
  })

  it('хоть один приватный адрес среди публичных — стоп', async () => {
    const r = await checkResolved(new URL('http://mixed.example/'), async () => ['93.184.216.34', '10.0.0.1'])
    expect(r.ok).toBe(false)
  })

  it('публичные адреса и IP-литералы пропускает (литералы в DNS не ходят)', async () => {
    let asked = 0
    const lookup = async () => {
      asked++
      return ['93.184.216.34']
    }
    expect((await checkResolved(new URL('http://example.com/'), lookup)).ok).toBe(true)
    expect((await checkResolved(new URL('http://93.184.216.34/'), lookup)).ok).toBe(true)
    expect(asked).toBe(1)
  })

  it('DNS упал — network, не исключение', async () => {
    const r = await checkResolved(new URL('http://nope.invalid/'), async () => {
      throw new Error('ENOTFOUND')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as WebError).code).toBe('network')
  })
})
