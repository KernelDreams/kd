// `runz test`: сбор файлов и резолв цели через реестр runz.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  collectTestFiles,
  findTestTarget,
  isTestFile,
  registerHookPath,
  testArgv,
} from '../src/test-runner.ts'

let root: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-test-runner-'))
  fs.mkdirSync(path.join(root, 'appz', 'demo', 'test'), { recursive: true })
  fs.mkdirSync(path.join(root, 'appz', 'demo', 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'appz', 'demo', 'index.ts'), 'export default () => ({})\n')
  fs.writeFileSync(path.join(root, 'appz', 'demo', 'test', 'a.test.ts'), '')
  fs.writeFileSync(path.join(root, 'appz', 'demo', 'test', 'b.test.ts'), '')
  fs.writeFileSync(path.join(root, 'appz', 'demo', 'test', 'helper.ts'), '')
  fs.writeFileSync(path.join(root, 'appz', 'demo', 'node_modules', 'x', 'z.test.ts'), '')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('runz test — сбор файлов', () => {
  it('распознаёт имя файла теста', () => {
    expect(isTestFile('a.test.ts')).toBe(true)
    expect(isTestFile('a.test.mts')).toBe(true)
    expect(isTestFile('a.ts')).toBe(false)
    expect(isTestFile('test.ts')).toBe(false)
  })

  it('собирает рекурсивно, node_modules не обходит', () => {
    const files = collectTestFiles(path.join(root, 'appz', 'demo'))
    expect(files.map((f) => path.basename(f))).toEqual(['a.test.ts', 'b.test.ts'])
  })

  it('фильтр — подстрока пути', () => {
    const files = collectTestFiles(path.join(root, 'appz', 'demo'), 'b.test')
    expect(files).toHaveLength(1)
  })

  it('файл целью — сам файл', () => {
    const f = path.join(root, 'appz', 'demo', 'test', 'a.test.ts')
    expect(collectTestFiles(f)).toEqual([f])
    expect(collectTestFiles(path.join(root, 'appz', 'demo', 'index.ts'))).toEqual([])
  })
})

describe('runz test — резолв цели', () => {
  const opts = () => ({
    cwd: path.join(root, 'nowhere'),
    projectDir: null,
    paths: [path.join(root, 'appz')],
  })

  it('имя резолвится через $paths (как у runz <script>)', () => {
    expect(findTestTarget('demo', opts())).toBe(path.join(root, 'appz', 'demo'))
  })

  it('неизвестное имя — null, а не тихий cwd', () => {
    expect(findTestTarget('nosuch', opts())).toBeNull()
  })

  it('явный путь резолвится напрямую', () => {
    const dir = path.join(root, 'appz', 'demo')
    expect(findTestTarget(dir, opts())).toBe(dir)
    expect(findTestTarget(path.join(root, 'appz', 'nope'), opts())).toBeNull()
  })

  it('preload-модуль хука существует', () => {
    expect(fs.existsSync(registerHookPath())).toBe(true)
  })

  it('хук для --import — file URL, на Windows тоже (ABC-300)', () => {
    const win = testArgv('S:\\Projects\\runz\\register-hook.ts', ['S:\\appz\\a.test.ts'], ['--x'], true)
    expect(win).toEqual(['--import', 'file:///S:/Projects/runz/register-hook.ts', '--test', '--x', 'S:\\appz\\a.test.ts'])
    const posix = testArgv('/r/register-hook.ts', ['/a/b.test.ts'], [], false)
    expect(posix).toEqual(['--import', 'file:///r/register-hook.ts', '--test', '/a/b.test.ts'])
  })
})
