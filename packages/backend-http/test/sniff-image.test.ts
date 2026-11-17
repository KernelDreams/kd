import { describe, expect, it } from 'vitest'
import { sniffImageMime } from '../src/store-backend.js'

describe('sniffImageMime (ABC-609/610)', () => {
  it('png / jpeg / webp по сигнатуре, прочее — undefined', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeUndefined()
  })
})
