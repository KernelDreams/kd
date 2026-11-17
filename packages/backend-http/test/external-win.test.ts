import { describe, expect, it } from 'vitest'
import { parseWinDrives, winFromWire, winToWire } from '../src/external.js'

// хаб на Windows (NR Pix переносной) — тот же провод, что у удалённых Windows-машин.
describe('адреса Windows-хоста', () => {
  it('провод → путь ОС', () => {
    expect(winFromWire('/E:/!!/a.png')).toBe('E:/!!/a.png')
    expect(winFromWire('/e:')).toBe('E:/')
    expect(winFromWire('/C:/')).toBe('C:/')
    expect(winFromWire('~/x')).toBe('~/x')
    expect(winFromWire('C:\\x')).toBe('C:\\x')
  })
  it('путь ОС → провод', () => {
    expect(winToWire('E:\\!!\\a.png')).toBe('/E:/!!/a.png')
    expect(winToWire('c:\\')).toBe('/C:/')
    expect(winToWire('C:/Users/D')).toBe('/C:/Users/D')
    expect(winToWire('/tmp/x')).toBe('/tmp/x')
  })
  it('диски из fsutil на любом языке', () => {
    expect(parseWinDrives('\r\nДиски: C:\\ D:\\ E:\\ S:\\ \r\n')).toEqual(['C', 'D', 'E', 'S'])
    expect(parseWinDrives('Drives: C:\\ c:\\ ')).toEqual(['C'])
    expect(parseWinDrives('')).toEqual([])
  })
})
