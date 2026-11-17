import { describe, it, expect } from 'vitest'
import {
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  attachmentKind,
  attachmentLimits,
  attachmentPart,
  estimateTokens,
} from '../src/index.js'
import type { AttachmentPutResult, Capabilities, Message, MessagesOps, Part } from '../src/index.js'

const utf8 = (s: string) => new TextEncoder().encode(s)

// ────────────────────────────────────────────────────────────────────────────
// attachmentKind (attachments-spec §3)
// ────────────────────────────────────────────────────────────────────────────

describe('attachmentKind', () => {
  it('текст по mime: text/*, json, +json, с параметрами', () => {
    expect(attachmentKind('a', 'text/plain')).toBe('text')
    expect(attachmentKind('a', 'text/markdown; charset=utf-8')).toBe('text')
    expect(attachmentKind('a', 'application/json')).toBe('text')
    expect(attachmentKind('a', 'application/vnd.api+json')).toBe('text')
  })

  it('исходники по расширению — даже с чужим mime (.ts → video/mp2t)', () => {
    expect(attachmentKind('main.ts', 'video/mp2t')).toBe('text')
    expect(attachmentKind('lib.rs', 'application/octet-stream')).toBe('text')
    expect(attachmentKind('notes.md')).toBe('text')
    expect(attachmentKind('Dockerfile')).toBe('text')
  })

  it('картинки по mime и по расширению без mime', () => {
    expect(attachmentKind('x.bin', 'image/png')).toBe('image')
    expect(attachmentKind('photo.JPG')).toBe('image')
    // SVG с image-mime — картинка: так её прислали
    expect(attachmentKind('logo.svg', 'image/svg+xml')).toBe('image')
  })

  it('прочее v1 не принимает', () => {
    expect(attachmentKind('doc.pdf', 'application/pdf')).toBeUndefined()
    expect(attachmentKind('archive.zip')).toBeUndefined()
    // расширение картинки с явно чужим mime — не угадываем
    expect(attachmentKind('fake.png', 'application/pdf')).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// attachmentPart — готовая часть для put → {ref, part}
// ────────────────────────────────────────────────────────────────────────────

describe('attachmentPart', () => {
  it('текстовый файл: text = содержимое, tokens — estimateTokens', () => {
    const text = '# Заметка\n\nдвадцать восемь символов'
    const part = attachmentPart({ name: 'note.md', data: utf8(text), mime: 'text/markdown', ref: 'r1' })
    expect(part).toEqual({
      type: 'file',
      text,
      meta: { name: 'note.md', mime: 'text/markdown', ref: 'r1', tokens: estimateTokens(text) },
    })
  })

  it('BOM срезается, пустой/чужой mime у текста → text/plain', () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('x = 1')])
    const part = attachmentPart({ name: 'a.py', data, mime: 'application/octet-stream', ref: 'r' })
    expect(part).toMatchObject({ type: 'file', text: 'x = 1', meta: { mime: 'text/plain' } })
  })

  it('картинка: без текста и токенов, mime из расширения, alt = имя', () => {
    const part = attachmentPart({ name: 'shot.png', data: new Uint8Array([0x89, 0x50]), ref: 'r2' })
    expect(part).toEqual({ type: 'image', meta: { ref: 'r2', alt: 'shot.png', mime: 'image/png' } })
  })

  it('лимит: больше maxBytes → bad_request с текстом для человека', () => {
    const err = (() => {
      try {
        attachmentPart({ name: 'big.txt', data: new Uint8Array(11), mime: 'text/plain', ref: 'r', maxBytes: 10 })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AttachmentRejectedError)
    expect((err as AttachmentRejectedError).code).toBe('bad_request')
    expect((err as Error).message).toMatch(/big\.txt.*лимит/)
  })

  it('лимит по умолчанию — 2 МБ (§3)', () => {
    expect(DEFAULT_ATTACHMENT_MAX_BYTES).toBe(2_000_000)
    const ok = new Uint8Array(DEFAULT_ATTACHMENT_MAX_BYTES).fill(0x61)
    expect(attachmentPart({ name: 'a.txt', data: ok, ref: 'r' }).type).toBe('file')
    expect(() => attachmentPart({ name: 'a.txt', data: new Uint8Array(DEFAULT_ATTACHMENT_MAX_BYTES + 1), ref: 'r' })).toThrow(
      AttachmentRejectedError,
    )
  })

  it('неподдержанный тип и не-UTF-8 текст → bad_request', () => {
    expect(() => attachmentPart({ name: 'a.pdf', data: utf8('%PDF'), mime: 'application/pdf', ref: 'r' })).toThrow(
      /не поддержан/,
    )
    expect(() => attachmentPart({ name: 'a.txt', data: new Uint8Array([0xff, 0xfe, 0x00]), ref: 'r' })).toThrow(
      /UTF-8/,
    )
  })
})

describe('estimateTokens', () => {
  // ascii / 4.4 + nonAscii / 2.75, вверх (attachments-spec §2)
  it('пустой текст — ноль, непустой — хотя бы один', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('ж')).toBe(1)
  })

  it('латиница — 4.4 символа на токен', () => {
    expect(estimateTokens('a'.repeat(44))).toBe(10)
    expect(estimateTokens('a'.repeat(45))).toBe(11)
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBe(10) // 44
  })

  it('кириллица — 2.75 символа на токен, плотнее прежних chars/3.5', () => {
    expect(estimateTokens('я'.repeat(55))).toBe(20)
    const text = 'Съешь же ещё этих мягких французских булок, да выпей чаю' // 46 не-ASCII + 10 ASCII
    expect(estimateTokens(text)).toBe(19) // 10 / 4.4 + 46 / 2.75 = 19.0
    expect(estimateTokens(text)).toBeGreaterThan(Math.ceil(text.length / 3.5))
  })

  it('код — ASCII-класс, дешевле прежних chars/3.5', () => {
    const code = 'export function add(a: number, b: number): number {\n  return a + b\n}\n' // 69
    expect(estimateTokens(code)).toBe(16) // 69 / 4.4
    expect(estimateTokens(code)).toBeLessThan(Math.ceil(code.length / 3.5))
  })

  it('смешанный текст — сумма классов', () => {
    expect(estimateTokens('abcd' + 'жжжж')).toBe(3) // 4 / 4.4 + 4 / 2.75 = 2.36
  })

  it('эмодзи — по code points: суррогатная пара — один символ', () => {
    expect('😀'.repeat(11).length).toBe(22)
    expect(estimateTokens('😀'.repeat(11))).toBe(4) // 11 / 2.75, а не 22 / 2.75 = 8
    expect(estimateTokens('👍🏽')).toBe(1) // два code point
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Capabilities.attachments: true | объект (bool остаётся валидным)
// ────────────────────────────────────────────────────────────────────────────

describe('attachmentLimits', () => {
  it('нормализует обе формы capability', () => {
    expect(attachmentLimits({})).toBeUndefined()
    expect(attachmentLimits({ attachments: false })).toBeUndefined()
    expect(attachmentLimits({ attachments: true })).toEqual({})
    const caps: Capabilities = { protocol: 1, attachments: { maxBytes: 2_000_000, mimes: ['text/*', 'image/*'] } }
    expect(attachmentLimits(caps)).toEqual({ maxBytes: 2_000_000, mimes: ['text/*', 'image/*'] })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Контракт put → append (компилируемость = тест)
// ────────────────────────────────────────────────────────────────────────────

describe('put → messages.append', () => {
  it('часть из put кладётся в append как есть, сообщение без рана', async () => {
    const log: Message[] = []
    const messages: MessagesOps = {
      async append(_sid, parts: Part[], opts) {
        const msg: Message = { id: `m${log.length + 1}`, role: opts?.role ?? 'user', parts }
        log.push(msg)
        return msg
      },
    }
    const put = async (name: string, data: Uint8Array, mime?: string): Promise<AttachmentPutResult> => {
      const ref = `ref-${name}`
      return { ref, part: attachmentPart({ name, data, mime, ref }) }
    }

    const { part } = await put('a.md', utf8('текст'), 'text/markdown')
    const msg = await messages.append!('s1', [part])
    expect(msg).toMatchObject({ role: 'user', parts: [{ type: 'file', text: 'текст', meta: { ref: 'ref-a.md' } }] })
    const caps: Capabilities = { protocol: 1, edits: { append: true }, attachments: true }
    expect(caps.edits?.append).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// attachments.get (v1.10) и run.continue
// ────────────────────────────────────────────────────────────────────────────

describe('attachmentContent / attachmentDataUrl / canGetAttachment', async () => {
  const { attachmentContent, attachmentDataUrl, canGetAttachment, canContinue } = await import('../src/index.js')

  it('картинка — base64, mime нормализован', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
    const c = attachmentContent({ ref: 'a.png', data: png, mime: 'Image/PNG; x=1' })
    expect(c).toEqual({ ref: 'a.png', content: btoa(String.fromCharCode(...png)), encoding: 'base64', size: 6, mime: 'image/png' })
    expect(attachmentDataUrl(c)).toBe(`data:image/png;base64,${c.content}`)
  })

  it('текст — utf8, без mime — поле не появляется', () => {
    const c = attachmentContent({ ref: 'n.md', data: utf8('# привет') })
    expect(c).toEqual({ ref: 'n.md', content: '# привет', encoding: 'utf8', size: utf8('# привет').byteLength })
    expect(attachmentDataUrl({ ...c, mime: 'image/svg+xml' })).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('# привет')}`)
    expect(attachmentDataUrl(c)).toMatch(/^data:application\/octet-stream;/)
  })

  it('гейты capability', () => {
    expect(canGetAttachment({})).toBe(false)
    expect(canGetAttachment({ attachments: true })).toBe(false)
    expect(canGetAttachment({ attachments: { get: true } })).toBe(true)
    expect(canContinue({})).toBe(false)
    expect(canContinue({ run: {} })).toBe(false)
    expect(canContinue({ run: { continue: true } })).toBe(true)
  })
})
