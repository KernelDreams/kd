// Агент на локальном node тем же загрузчиком, что уходит в ssh: `node -e <загрузчик>`, первая строка — агент.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLine, bootstrapCode } from '../index.js'

let home
let proc
let next = 1
const waiting = new Map()
const events = []
let hello

function call(op, args = {}) {
  const id = next++
  proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
  return new Promise((ok) => waiting.set(id, ok))
}
async function must(op, args) {
  const r = await call(op, args)
  assert.equal(r.ok, true, `${op}: ${r.error}`)
  return r.result
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'nr-agent-'))
  proc = spawn(process.execPath, ['-e', bootstrapCode()], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const gotHello = new Promise((ok) => {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (m.event === 'hello') ok(m)
        else if (m.event) events.push(m)
        else waiting.get(m.id)?.(m)
      }
    })
  })
  // агент и первый запрос одним куском: остаток после первой строки не теряется
  proc.stdin.write(agentLine() + `${JSON.stringify({ id: 0, op: 'ping' })}\n`)
  waiting.set(0, () => {})
  hello = await gotHello
  await must('init', { deny: [{ prefix: join(home, '.ssh') }, { prefix: join(hello.realHome, '.ssh') }, { re: '^(?:.*/)?\\.env[^/]*$' }] })
})

after(() => {
  proc.stdin.end()
  rmSync(home, { recursive: true, force: true })
})

test('hello: версия, дом, что умеет', () => {
  assert.equal(hello.version, '0.2.0')
  assert.equal(hello.home, home)
  assert.equal(typeof hello.caps.tar, 'boolean')
})

test('до init — отказ', async () => {
  const p = spawn(process.execPath, ['-e', bootstrapCode()], { stdio: ['pipe', 'pipe', 'inherit'] })
  p.stdin.write(agentLine() + `${JSON.stringify({ id: 1, op: 'stat', args: { path: '/' } })}\n`)
  const out = await new Promise((ok) => {
    let b = ''
    p.stdout.on('data', (d) => {
      b += d
      if (b.split('\n').length > 2) ok(b)
    })
  })
  p.kill()
  const r = JSON.parse(out.split('\n')[1])
  assert.equal(r.ok, false)
  assert.match(r.error, /init/)
})

test('stat, list, ~ и закрытые пути', async () => {
  mkdirSync(join(home, 'a'))
  writeFileSync(join(home, 'a', 'x.txt'), 'привет')
  writeFileSync(join(home, 'a', '.env'), 'SECRET=1')
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id'), 'k')
  symlinkSync(join(home, '.ssh'), join(home, 'a', 'keys'))
  const st = await must('stat', { path: '~/a/x.txt' })
  assert.equal(st.path, join(home, 'a', 'x.txt'))
  assert.equal(st.size, Buffer.byteLength('привет'))
  assert.equal((await must('stat', { path: '~/nope' })).exists, false)
  const names = (await must('list', { path: '~/a' })).map((e) => e.name)
  assert.deepEqual(names, ['x.txt'])
  assert.equal((await call('stat', { path: '~/.ssh/id' })).code, 'forbidden')
  assert.equal((await call('read', { path: '~/a/keys/id' })).code, 'forbidden')
  assert.equal((await call('list', { path: 'rel' })).code, 'bad_request')
})

test('read кусками, write с ревизией, put/finish', async () => {
  const p = join(home, 'b.bin')
  const data = Buffer.alloc(100_000, 7)
  const w = await must('write', { path: p, data: data.toString('base64'), revision: null })
  assert.equal((await call('write', { path: p, data: '', revision: null })).code, 'conflict')
  assert.equal((await call('write', { path: p, data: '', revision: 'old' })).code, 'conflict')
  await must('write', { path: p, data: data.toString('base64'), revision: w.revision })
  const c = await must('read', { path: p, offset: 99_000, length: 5000 })
  assert.equal(Buffer.from(c.data, 'base64').length, 1000)
  assert.equal(c.eof, true)
  const tmp = join(home, 'in', '.nr-tmp-c')
  await must('put', { path: tmp, offset: 0, data: Buffer.from('abc').toString('base64') })
  await must('put', { path: tmp, offset: 3, data: Buffer.from('def').toString('base64') })
  await must('finish', { tmp, to: join(home, 'in', 'c.txt'), mtimeMs: Date.parse('2020-01-01T00:00:00Z') })
  assert.equal(readFileSync(join(home, 'in', 'c.txt'), 'utf8'), 'abcdef')
  assert.equal((await must('stat', { path: join(home, 'in', 'c.txt') })).mtime, '2020-01-01T00:00:00.000Z')
  assert.equal((await call('put', { path: join(home, 'in', 'c.txt'), data: '' })).code, 'bad_request')
})

test('mkdir, rename, copy, delete в корзину', async () => {
  await must('mkdir', { path: '~/m/n' })
  writeFileSync(join(home, 'm', 'n', 'f'), '1')
  await must('copy', { from: '~/m', to: '~/m2' })
  assert.equal(readFileSync(join(home, 'm2', 'n', 'f'), 'utf8'), '1')
  assert.equal((await call('copy', { from: '~/m', to: '~/m2' })).code, 'conflict')
  assert.equal((await call('rename', { from: '~/m', to: '~/m/n/x' })).code, 'bad_request')
  await must('rename', { from: '~/m2', to: '~/m3' })
  const d = await must('delete', { path: '~/m3' })
  assert.equal(d.trashed, join(home, '.nr-trash', home.slice(1), 'm3'))
  assert.ok(existsSync(join(d.trashed, 'n', 'f')))
  await must('delete', { path: '~/m', permanent: true })
  assert.ok(!existsSync(join(home, 'm')))
  assert.equal((await call('delete', { path: '~' })).code, 'forbidden')
})

test('walk, search, disk', async () => {
  mkdirSync(join(home, 's', 'deep'), { recursive: true })
  writeFileSync(join(home, 's', 'one.md'), 'alpha\nbeta GAMMA\n')
  writeFileSync(join(home, 's', 'deep', 'two.txt'), 'gamma')
  const w = await must('walk', { path: '~/s' })
  assert.deepEqual(w.entries.map((e) => e.rel), ['', 'deep', 'deep/two.txt', 'one.md'])
  const byName = await must('search', { path: '~/s', nameRe: '^(?:.*/)?[^/]*\\.md$' })
  assert.deepEqual(byName.map((h) => h.path), [join(home, 's', 'one.md')])
  const byText = await must('search', { path: '~/s', textRe: 'gamma', textFlags: 'iu' })
  assert.deepEqual(byText.map((h) => [h.line, h.at]), [[1, 0], [2, 5]])
  const dk = await must('disk', { path: '~' })
  assert.ok(dk.total > 0 && dk.free >= 0)
})

test('watch: событие на новый файл, unwatch', async () => {
  mkdirSync(join(home, 'w'))
  const { watch } = await must('watch', { path: '~/w' })
  writeFileSync(join(home, 'w', 'new.txt'), 'x')
  const deadline = Date.now() + 3000
  while (!events.some((e) => e.watch === watch) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  const ev = events.find((e) => e.watch === watch)
  assert.ok(ev, 'нет события')
  assert.ok(ev.paths.some((p) => p.endsWith('new.txt') || p === join(home, 'w')))
  await must('unwatch', { watch })
})

test('exec без шелла', async () => {
  const r = await must('exec', { cmd: process.execPath, args: ['-e', 'process.stdout.write("ok")'] })
  assert.deepEqual([r.code, r.stdout], [0, 'ok'])
})
