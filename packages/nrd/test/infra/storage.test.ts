import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fsStorage, isAbsolutePath, resolveStoragePath, type IStorage } from '../../src/node/storage.js'
import { memoryStorage } from '../../src/web/storage.js'
import { isOk, isErr } from '../../src/infra/result.js'

function commonTests(name: string, make: () => Promise<IStorage> | IStorage) {
  describe(name, () => {
    let s: IStorage
    beforeEach(async () => {
      s = await make()
    })

    it('round-trip write → read', async () => {
      const w = await s.write('config/models.md', 'content')
      expect(isOk(w)).toBe(true)
      const r = await s.read('config/models.md')
      expect(isOk(r)).toBe(true)
      if (isOk(r)) expect(r.value).toBe('content')
    })

    it('read отсутствующего → ok(undefined)', async () => {
      const r = await s.read('nope.md')
      expect(isOk(r)).toBe(true)
      if (isOk(r)) expect(r.value).toBeUndefined()
    })

    it('exists', async () => {
      await s.write('a.md', 'x')
      const yes = await s.exists('a.md')
      const no = await s.exists('b.md')
      if (isOk(yes)) expect(yes.value).toBe(true)
      if (isOk(no)) expect(no.value).toBe(false)
    })

    it('list под префиксом', async () => {
      await s.write('dir/a.md', '1')
      await s.write('dir/sub/b.md', '2')
      await s.write('other/c.md', '3')
      const r = await s.list('dir')
      expect(isOk(r)).toBe(true)
      if (isOk(r)) {
        expect(r.value).toContain('dir/a.md')
        expect(r.value).toContain('dir/sub/b.md')
        expect(r.value).not.toContain('other/c.md')
      }
    })

    it('delete', async () => {
      await s.write('x.md', '1')
      await s.delete('x.md')
      const r = await s.read('x.md')
      if (isOk(r)) expect(r.value).toBeUndefined()
    })
  })
}

commonTests('memoryStorage', () => memoryStorage())

describe('fsStorage', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-infra-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trip с авто-созданием директорий', async () => {
    const s = fsStorage(dir)
    await s.write('deep/nested/file.md', 'hi')
    const r = await s.read('deep/nested/file.md')
    if (isOk(r)) expect(r.value).toBe('hi')
    // реально на диске
    const onDisk = await fs.readFile(path.join(dir, 'deep', 'nested', 'file.md'), 'utf-8')
    expect(onDisk).toBe('hi')
  })

  it('read несуществующего → ok(undefined), не err', async () => {
    const s = fsStorage(dir)
    const r = await s.read('missing.md')
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value).toBeUndefined()
  })

  it('list рекурсивно с прямыми слешами', async () => {
    const s = fsStorage(dir)
    await s.write('a/b.md', '1')
    await s.write('a/c/d.md', '2')
    const r = await s.list('a')
    if (isOk(r)) {
      expect(r.value).toContain('a/b.md')
      expect(r.value).toContain('a/c/d.md')
    }
  })

  it('err когда путь — директория (read), текст ошибки есть', async () => {
    const s = fsStorage(dir)
    await fs.mkdir(path.join(dir, 'adir'))
    const r = await s.read('adir')
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message.length).toBeGreaterThan(0)
  })
})

// Абсолютность — по форме строки, не по платформе процесса ( §4):
// `S:/x` на Unix раньше клеился к root → «ресурс не найден».
describe('fsStorage: абсолютные пути', () => {
  const root = path.resolve('base-root')

  it.each([
    ['S:/x', true],
    ['S:\\x', true],
    ['/x', true],
    ['./x', false],
    ['x/y.md', false],
  ])('isAbsolutePath(%j) = %s', (p, abs) => {
    expect(isAbsolutePath(p)).toBe(abs)
  })

  it.each(['S:/x', 'S:\\x', '/x'])('абсолютный %j не клеится к root', (p) => {
    const full = resolveStoragePath(root, p)
    expect(full.startsWith(root)).toBe(false)
    expect(full).toBe(path.normalize(p))
  })

  it('./x — от root', () => {
    expect(resolveStoragePath(root, './x')).toBe(path.join(root, 'x'))
  })

  it('абсолютный путь читается из другого root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-infra-abs-'))
    try {
      const file = path.join(dir, 'abs.md')
      await fs.writeFile(file, 'abs', 'utf-8')
      const r = await fsStorage(path.join(dir, 'elsewhere')).read(file.split(path.sep).join('/'))
      expect(isOk(r)).toBe(true)
      if (isOk(r)) expect(r.value).toBe('abs')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// fsStorage проходит общий контракт тоже
describe('fsStorage (контракт)', () => {
  let dir: string
  commonTests('fs', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-infra-c-'))
    return fsStorage(dir)
  })
})
