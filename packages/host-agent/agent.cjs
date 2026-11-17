/**
 * nr-host-agent — транспорт панели файлов на удалённый хост (nr-far.dev/specs/hosts-spec.md §2).
 *
 * Ничего не ставится на хост: хаб запускает `ssh -T <alias> <node> -e <загрузчик>`, загрузчик читает
 * первую строку входа (этот файл в base64) и исполняет её; дальше вход и выход — JSON-строки:
 *
 *   → {id, op, args}                       запрос
 *   ← {id, ok: true, result}               ответ
 *   ← {id, ok: false, error, code}         ошибка (`not_found`, `forbidden`, `conflict`, `bad_request`)
 *   ← {event: 'hello', …}                  при старте: версия, ОС, дом, что умеет хост
 *   ← {event: 'update', watch, paths}      слежение
 *
 * Пути на проводе — POSIX-абсолютные; на Windows `C:\Users\x` ↔ `/C:/Users/x`. Закрытые пути
 * (`~/.ssh`, ключи) хаб присылает в `init` — агент проверяет их и по реальному пути (симлинки).
 * Один файл, без зависимостей: живёт, пока жив ssh.
 */
'use strict'

const fs = require('fs')
const fsp = fs.promises
const P = require('path').posix
const os = require('os')
const cp = require('child_process')
const crypto = require('crypto')

const VERSION = '0.2.0'
const WIN = process.platform === 'win32'

/** Кусок байтов на провод, не больше. */
const CHUNK_MAX = 4 * 1024 * 1024
/** Окно склейки событий слежения, мс; больше путей — `['']` («перечитай всё»). */
const WATCH_DEBOUNCE_MS = 200
const WATCH_MAX_PATHS = 500
/** Поиск: каталоги мимо, файлы больше — мимо, дольше — отдать найденное. */
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.nr-trash', '.cache', 'dist'])
const SEARCH_MAX_FILE_BYTES = 2000000
const SEARCH_TIMEOUT_MS = 15000
const WALK_MAX = 200000

// ─── пути ────────────────────────────────────────────────────────────────────

/** Путь провода → путь ОС. */
function toNative(p) {
  if (!WIN) return p
  const m = /^\/([A-Za-z]):(\/.*)?$/.exec(p)
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`
  return p.replace(/\//g, '\\')
}

/** Путь ОС → путь провода. */
function toWire(n) {
  if (!WIN) return n
  const m = /^([A-Za-z]):(.*)$/.exec(n)
  if (m) return `/${m[1].toUpperCase()}:${m[2].replace(/\\/g, '/') || '/'}`
  return n.replace(/\\/g, '/')
}

const HOME = toWire(os.homedir())
const TRASH = P.join(HOME, '.nr-trash')
const THUMBS = P.join(HOME, '.cache', 'nr-thumbs')

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function expand(p) {
  return p === '~' ? HOME : p.startsWith('~/') ? P.join(HOME, p.slice(2)) : p
}

/** Корень пути: `/` или `/C:/`. */
function isRoot(p) {
  return p === '/' || /^\/[A-Za-z]:\/?$/.test(p)
}

function absOf(raw) {
  const p = expand(String(raw == null ? '' : raw).trim())
  if (p === '' || !P.isAbsolute(p)) throw fail('bad_request', `нужен абсолютный путь или ~/…: «${raw}»`)
  let n = P.normalize(p)
  if (n.length > 1 && n.endsWith('/') && !isRoot(n)) n = n.slice(0, -1)
  if (WIN && /^\/[A-Za-z]:$/.test(n)) n += '/'
  return n
}

// ─── закрытые пути ───────────────────────────────────────────────────────────

/**
 * Сессия агента `s`: правила от хаба (`s.rules`: `{prefix}` — путь и всё под ним, `{re}` — регэксп по
 * пути без ведущего `/`), корни машины (`s.roots`: вне них — закрыто; ставит установленный агент, nr-mcp),
 * слежение и провод. По ssh сессия одна на процесс, в nr-mcp — своя у каждого подключения хаба.
 */
function underRoot(roots, abs) {
  return roots.some((r) => abs === r || isRoot(r) || abs.startsWith(`${r}/`))
}

function denied(s, abs) {
  if (s.roots && !underRoot(s.roots, abs)) return true
  const rules = s.rules
  if (!rules) return false
  for (const r of rules) {
    if (r.prefix !== undefined) {
      if (abs === r.prefix || abs.startsWith(`${r.prefix}/`)) return true
    } else if (r.re.test(abs.replace(/^\/+/, ''))) return true
  }
  return false
}

async function real(abs) {
  try {
    return toWire(await fsp.realpath(toNative(abs)))
  } catch {
    return null
  }
}

async function allowed(s, raw) {
  const abs = absOf(raw)
  if (denied(s, abs)) throw fail('forbidden', `путь закрыт: ${abs}`)
  const r = await real(abs)
  if (r && denied(s, r)) throw fail('forbidden', `путь закрыт: ${abs}`)
  return { abs, real: r }
}

async function existing(s, raw) {
  const a = await allowed(s, raw)
  if (!a.real) throw fail('not_found', `файла нет: ${a.abs}`)
  return a
}

let realHome = HOME
try {
  realHome = toWire(fs.realpathSync(toNative(HOME)))
} catch {
  // нет дома — как есть
}

/** Под запись: сам путь (не цель симлинка), закрытое — и по реальному родителю; корень и дом — нет. */
async function writable(s, raw) {
  const { abs } = await allowed(s, raw)
  if (isRoot(abs) || abs === HOME || abs === realHome) throw fail('forbidden', `путь закрыт: ${abs}`)
  const parent = await real(P.dirname(abs))
  if (parent && denied(s, P.join(parent, P.basename(abs)))) throw fail('forbidden', `путь закрыт: ${abs}`)
  return abs
}

async function realOfNew(abs) {
  const tail = []
  for (let p = abs; ; p = P.dirname(p)) {
    const r = await real(p)
    if (r) return tail.length ? P.join(r, ...tail.reverse()) : r
    if (p === P.dirname(p)) return abs
    tail.push(P.basename(p))
  }
}

const exists = (abs) => fsp.lstat(toNative(abs)).then(() => true, () => false)
const rev = (st) => `${st.mtimeMs}:${st.size}`

async function move(from, to) {
  try {
    await fsp.rename(toNative(from), toNative(to))
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fsp.cp(toNative(from), toNative(to), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await fsp.rm(toNative(from), { recursive: true, force: true })
  }
}

// ─── что умеет хост ──────────────────────────────────────────────────────────

function which(cmd) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(WIN ? ';' : ':')) {
    if (!dir) continue
    for (const e of exts) {
      const f = require('path').join(dir, cmd + e)
      try {
        if (fs.statSync(f).isFile()) return f
      } catch {
        // нет — дальше
      }
    }
  }
  return null
}

const tools = {
  sips: process.platform === 'darwin' ? which('sips') : null,
  qlmanage: process.platform === 'darwin' ? which('qlmanage') : null,
  ffmpeg: which('ffmpeg'),
  magick: which('magick') || (WIN ? null : which('convert')),
  rg: which('rg'),
  tar: which('tar'),
  git: which('git'),
}

const caps = {
  thumb: tools.sips ? 'sips' : tools.ffmpeg ? 'ffmpeg' : tools.magick ? 'magick' : null,
  video: Boolean(tools.qlmanage || tools.ffmpeg),
  rg: Boolean(tools.rg),
  tar: Boolean(tools.tar),
  git: Boolean(tools.git),
  watch: true,
}

function run(cmd, args, timeout = 30000) {
  return new Promise((ok, bad) => cp.execFile(cmd, args, { timeout, windowsHide: true }, (err) => (err ? bad(err) : ok())))
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.avif'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])

async function makeThumb(src, out, px, kind) {
  const s = toNative(src)
  const o = toNative(out)
  if (kind === 'image' && tools.sips) {
    await run(tools.sips, ['-s', 'format', 'png', '-Z', String(px), s, '--out', o])
  } else if (kind === 'video' && tools.qlmanage) {
    const dir = `${out}.ql`
    await fsp.mkdir(toNative(dir), { recursive: true })
    try {
      await run(tools.qlmanage, ['-t', '-s', String(px), '-o', toNative(dir), s])
      await fsp.rename(toNative(P.join(dir, `${P.basename(src)}.png`)), o)
    } finally {
      await fsp.rm(toNative(dir), { recursive: true, force: true })
    }
  } else if (tools.ffmpeg) {
    const vf = `scale='min(${px},iw)':'min(${px},ih)':force_original_aspect_ratio=decrease`
    await run(tools.ffmpeg, ['-v', 'error', '-y', ...(kind === 'video' ? ['-ss', '1'] : []), '-i', s, '-vf', vf, '-frames:v', '1', o], 60000)
  } else if (kind === 'image' && tools.magick) {
    await run(tools.magick, [`${s}[0]`, '-thumbnail', `${px}x${px}>`, o])
  } else return false
  return fs.existsSync(o)
}

// ─── операции ────────────────────────────────────────────────────────────────

function entryOf(dir, name, st) {
  const kind = st && st.isDirectory() ? 'dir' : 'file'
  return { name, path: P.join(dir, name), kind, ...(st && kind === 'file' ? { size: st.size } : {}), ...(st ? { mtime: st.mtime.toISOString() } : {}) }
}

async function list({ path }, s) {
  const { abs, real: r } = await existing(s, path)
  const dirents = await fsp.readdir(toNative(r), { withFileTypes: true })
  const out = []
  for (const d of dirents) {
    const p = P.join(abs, d.name)
    if (denied(s, p)) continue
    if (d.isSymbolicLink()) {
      const t = await real(p)
      if (t && denied(s, t)) continue
    }
    const st = await fsp.stat(toNative(p)).catch(() => null)
    // битый симлинк — как есть, без размера и даты
    out.push(st ? entryOf(abs, d.name, st) : { name: d.name, path: p, kind: d.isDirectory() ? 'dir' : 'file' })
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return out
}

async function stat({ path }, s) {
  const { abs, real: r } = await allowed(s, path)
  if (!r) return { path: abs, exists: false }
  const st = await fsp.stat(toNative(r))
  const kind = st.isDirectory() ? 'dir' : 'file'
  return { path: abs, exists: true, kind, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs, ...(kind === 'file' ? { size: st.size, revision: rev(st) } : {}) }
}

/** Кусок файла: `offset`, `length` (≤ 4 МБ). */
async function read({ path, offset = 0, length = CHUNK_MAX }, s) {
  const { real: r } = await existing(s, path)
  const fh = await fsp.open(toNative(r), 'r')
  try {
    const st = await fh.stat()
    if (st.isDirectory()) throw fail('bad_request', `это каталог: ${path}`)
    const len = Math.max(0, Math.min(CHUNK_MAX, Number(length) || 0, st.size - offset))
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, offset + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return { data: buf.subarray(0, got).toString('base64'), size: st.size, revision: rev(st), eof: offset + got >= st.size }
  } finally {
    await fh.close()
  }
}

async function write({ path, data, revision }, s) {
  const abs = await writable(s, path)
  const target = (await real(abs)) || abs
  if (revision !== undefined) {
    const st = await fsp.stat(toNative(target)).catch(() => null)
    if (revision === null && st) throw fail('conflict', `файл уже есть: ${path}`)
    if (revision !== null && (!st || rev(st) !== revision)) throw fail('conflict', `файл изменился: ${path}`)
  }
  await fsp.mkdir(toNative(P.dirname(target)), { recursive: true })
  const tmp = P.join(P.dirname(target), `.nr-tmp-${P.basename(target)}-${process.pid}-${Date.now()}`)
  await fsp.writeFile(toNative(tmp), Buffer.from(String(data || ''), 'base64'))
  await fsp.rename(toNative(tmp), toNative(target))
  return { revision: rev(await fsp.stat(toNative(target))) }
}

/** Перенос байтов кусками: `put` во временный файл, `finish` — на место с датой. */
async function put({ path, offset = 0, data }, s) {
  const abs = await writable(s, path)
  if (!P.basename(abs).startsWith('.nr-tmp-')) throw fail('bad_request', 'put: только во временный .nr-tmp-*')
  await fsp.mkdir(toNative(P.dirname(abs)), { recursive: true })
  const fh = await fsp.open(toNative(abs), offset === 0 ? 'w' : 'r+')
  try {
    const buf = Buffer.from(String(data || ''), 'base64')
    await fh.write(buf, 0, buf.length, offset)
  } finally {
    await fh.close()
  }
  return {}
}

async function finish({ tmp, to, mtimeMs, overwrite }, s) {
  const t = await writable(s, tmp)
  const dest = await writable(s, to)
  if ((await exists(dest)) && !overwrite) {
    await fsp.rm(toNative(t), { force: true })
    throw fail('conflict', `уже есть: ${to}`)
  }
  if (overwrite) await fsp.rm(toNative(dest), { recursive: true, force: true })
  await fsp.mkdir(toNative(P.dirname(dest)), { recursive: true })
  await fsp.rename(toNative(t), toNative(dest))
  if (typeof mtimeMs === 'number') await fsp.utimes(toNative(dest), new Date(), new Date(mtimeMs)).catch(() => {})
  return {}
}

async function mkdir({ path }, s) {
  await fsp.mkdir(toNative(await writable(s, path)), { recursive: true })
  return {}
}

async function rename({ from, to }, s) {
  const f = await writable(s, from)
  if (!(await exists(f))) throw fail('not_found', `файла нет: ${from}`)
  const t = await writable(s, to)
  if (t === f) return {}
  if (await exists(t)) throw fail('conflict', `уже есть: ${to}`)
  const fr = await realOfNew(f)
  const tr = await realOfNew(t)
  if (tr.startsWith(`${fr}/`)) throw fail('bad_request', `нельзя перенести каталог в самого себя: ${to}`)
  await fsp.mkdir(toNative(P.dirname(t)), { recursive: true })
  await move(f, t)
  return {}
}

async function remove({ path, permanent }, s) {
  const t = await writable(s, path)
  if (!(await exists(t))) throw fail('not_found', `файла нет: ${path}`)
  if (permanent || t === TRASH || t.startsWith(`${TRASH}/`)) {
    await fsp.rm(toNative(t), { recursive: true, force: true })
    return {}
  }
  const rel = t.replace(/^\/+/, '').replace(/:/g, '')
  let dest = P.join(TRASH, rel)
  if (await exists(dest)) dest = P.join(TRASH, `${rel}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await fsp.mkdir(toNative(P.dirname(dest)), { recursive: true })
  await move(t, dest)
  return { trashed: dest }
}

async function copy({ from, to, overwrite }, s) {
  const { real: f } = await existing(s, from)
  const t = await writable(s, to)
  const tr = await realOfNew(t)
  if (tr === f || tr.startsWith(`${f}/`)) throw fail('bad_request', `нельзя копировать в самого себя: ${to}`)
  if ((await exists(t)) && !overwrite) throw fail('conflict', `уже есть: ${to}`)
  await fsp.mkdir(toNative(P.dirname(t)), { recursive: true })
  await fsp.cp(toNative(f), toNative(t), { recursive: true, force: overwrite === true, errorOnExist: overwrite !== true, preserveTimestamps: true })
  return {}
}

/** Дерево под путём для переноса между хостами: `rel` от корня (корень — `''`). */
async function walk({ path, limit = WALK_MAX }, s) {
  const { abs, real: r } = await existing(s, path)
  const out = []
  async function go(relDir, realDir) {
    const st = await fsp.lstat(toNative(realDir))
    if (st.isSymbolicLink()) {
      const t = await fsp.stat(toNative(realDir)).catch(() => null)
      if (!t || t.isDirectory()) return
      out.push({ rel: relDir, kind: 'file', size: t.size, mtimeMs: t.mtimeMs })
      return
    }
    if (!st.isDirectory()) {
      if (st.isFile()) out.push({ rel: relDir, kind: 'file', size: st.size, mtimeMs: st.mtimeMs })
      return
    }
    out.push({ rel: relDir, kind: 'dir', mtimeMs: st.mtimeMs })
    for (const name of (await fsp.readdir(toNative(realDir))).sort()) {
      if (out.length >= limit) throw fail('bad_request', `больше ${limit} файлов: ${abs}`)
      const relChild = relDir ? `${relDir}/${name}` : name
      if (denied(s, P.join(abs, relChild)) || name.startsWith('.nr-tmp-')) continue
      await go(relChild, P.join(realDir, name))
    }
  }
  await go('', r)
  return { path: abs, entries: out }
}

async function search({ path, nameRe, textRe, textFlags, limit = 500 }, s) {
  const { abs, real: r } = await existing(s, path)
  const name = nameRe ? new RegExp(nameRe) : null
  const text = textRe ? new RegExp(textRe, textFlags || '') : null
  if (!name && !text) throw fail('bad_request', 'search: нужен glob или query')
  const hits = []
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  async function go(dirAbs, dirReal) {
    if (hits.length >= limit || Date.now() > deadline) return
    let dirents
    try {
      dirents = await fsp.readdir(toNative(dirReal), { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      if (hits.length >= limit || Date.now() > deadline) return
      const pa = P.join(dirAbs, d.name)
      const pr = P.join(dirReal, d.name)
      if (denied(s, pa) || d.name.startsWith('.nr-tmp-')) continue
      if (d.isDirectory()) {
        if (!SEARCH_SKIP.has(d.name)) await go(pa, pr)
        continue
      }
      if (!d.isFile()) continue
      if (name && !name.test(pa.slice(abs.length + 1))) continue
      if (!text) {
        hits.push({ path: pa, line: 0, text: '', at: -1 })
        continue
      }
      const st = await fsp.stat(toNative(pr)).catch(() => null)
      if (!st || st.size > SEARCH_MAX_FILE_BYTES) continue
      const buf = await fsp.readFile(toNative(pr)).catch(() => null)
      if (!buf || buf.includes(0)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        const m = text.exec(lines[i])
        if (text.global) text.lastIndex = 0
        if (m) hits.push({ path: pa, line: i + 1, text: lines[i], at: m.index })
      }
    }
  }
  await go(abs, r)
  return hits
}

function watch({ path, recursive }, s) {
  const abs = absOf(path)
  if (denied(s, abs)) throw fail('forbidden', `путь закрыт: ${abs}`)
  let r
  try {
    r = toWire(fs.realpathSync(toNative(abs)))
  } catch {
    throw fail('not_found', `файла нет: ${abs}`)
  }
  const id = s.nextWatch++
  const pending = new Set()
  let timer = null
  const flush = () => {
    timer = null
    const paths = pending.size > WATCH_MAX_PATHS ? [''] : [...pending]
    pending.clear()
    if (paths.length) s.emit({ event: 'update', watch: id, paths })
  }
  const w = s.watchDir(toNative(r), recursive === true, (name) => {
    const n = name ? String(name).replace(/\\/g, '/') : ''
    if (n.split('/').some((x) => x.startsWith('.nr-tmp-'))) return
    const p = n === '' ? abs : P.join(abs, n)
    if (denied(s, p)) return
    pending.add(p)
    if (!timer) timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
  }, () => s.emit({ event: 'update', watch: id, paths: [''] }))
  s.watchers.set(id, { w, stop: () => timer && clearTimeout(timer) })
  return { watch: id }
}

function unwatch({ watch: id }, s) {
  const e = s.watchers.get(id)
  if (e) {
    e.stop()
    e.w.close()
    s.watchers.delete(id)
  }
  return {}
}

async function disk({ path }, s) {
  const { real: r } = await existing(s, path)
  const st = await fsp.statfs(toNative(r))
  return { total: st.blocks * st.bsize, free: st.bavail * st.bsize }
}

async function thumb({ path, px = 256 }, s) {
  if (!caps.thumb) return null
  const { real: r } = await existing(s, path)
  const ext = P.extname(r).toLowerCase()
  const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null
  if (!kind || (kind === 'video' && !caps.video)) return null
  const st = await fsp.stat(toNative(r))
  if (!st.isFile()) return null
  const side = Math.min(1024, Math.max(32, Math.round(px) || 256))
  const key = crypto.createHash('sha1').update(`${r}\0${st.mtimeMs}\0${st.size}\0${side}`).digest('hex')
  const out = P.join(THUMBS, key.slice(0, 2), `${key}.png`)
  if (!fs.existsSync(toNative(out))) {
    await fsp.mkdir(toNative(P.dirname(out)), { recursive: true })
    const ok = await makeThumb(r, out, side, kind).catch(() => false)
    if (!ok) return null
  }
  return { path: out, size: fs.statSync(toNative(out)).size }
}

function execCwd(s, cwd) {
  const abs = absOf(cwd)
  if (denied(s, abs)) throw fail('forbidden', `путь закрыт: ${abs}`)
  return abs
}

/** Команда хоста без шелла (git этапа 3); вывод — до 4 МБ. */
function exec({ cmd, args = [], cwd, timeout = 30000 }, s) {
  return new Promise((ok) => {
    cp.execFile(String(cmd), args.map(String), { cwd: cwd ? toNative(execCwd(s, cwd)) : undefined, timeout, maxBuffer: CHUNK_MAX, windowsHide: true }, (err, stdout, stderr) => {
      ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })
    })
  })
}

function init({ deny }, s) {
  s.rules = (Array.isArray(deny) ? deny : []).map((r) => (typeof r.prefix === 'string' ? { prefix: r.prefix } : { re: new RegExp(r.re) }))
  return { home: HOME }
}

const OPS = { init, ping: () => ({}), stat, list, read, write, put, finish, mkdir, rename, delete: remove, copy, walk, search, watch, unwatch, disk, thumb, exec }

// ─── провод ──────────────────────────────────────────────────────────────────

/** `fs.watch` прямо в этом потоке; nr-mcp подменяет на поток слежения. */
function fsWatchDir(native, recursive, onName, onError) {
  const w = fs.watch(native, { recursive }, (_ev, name) => onName(name ? String(name) : ''))
  w.on('error', onError)
  return w
}

/**
 * Сессия агента: `emit(msg)` — ответы и события наружу, `roots` — корни машины (POSIX-пути провода),
 * `watchDir(native, recursive, onName, onError) → {close}` — своё слежение. Ответ — `handle(line)`,
 * `close()` снимает слежение, `hello` — первое сообщение.
 */
function createAgent(o) {
  const opts = o || {}
  const s = {
    rules: null,
    roots: Array.isArray(opts.roots) && opts.roots.length ? opts.roots.map((r) => absOf(r)) : null,
    watchers: new Map(),
    nextWatch: 1,
    emit: opts.emit || ((msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)),
    watchDir: opts.watchDir || fsWatchDir,
  }
  async function call(req) {
    const fn = Object.prototype.hasOwnProperty.call(OPS, req.op) ? OPS[req.op] : null
    try {
      if (!fn) throw fail('not_supported', `агент не умеет «${req.op}»`)
      if (!s.rules && req.op !== 'init' && req.op !== 'ping') throw fail('bad_request', 'агент: сначала init')
      return { id: req.id, ok: true, result: (await fn(req.args || {}, s)) ?? null }
    } catch (err) {
      const code = typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : err.code === 'ENOENT' ? 'not_found' : err.code === 'EEXIST' ? 'conflict' : err.code === 'EACCES' || err.code === 'EPERM' ? 'forbidden' : undefined
      return { id: req.id, ok: false, error: err.message || String(err), ...(code ? { code } : {}) }
    }
  }
  return {
    hello: { event: 'hello', version: VERSION, os: process.platform, arch: process.arch, node: process.version, home: HOME, realHome, caps, ...(s.roots ? { roots: s.roots } : {}) },
    /** Запрос объектом → ответ объектом (HTTP-провод nr-mcp). */
    call,
    /** Строка провода → ответ в `emit`. */
    async handle(line) {
      let req
      try {
        req = JSON.parse(line)
      } catch {
        return s.emit({ event: 'error', error: 'битая строка запроса' })
      }
      s.emit(await call(req))
    },
    close() {
      for (const [, e] of s.watchers) {
        e.stop()
        e.w.close()
      }
      s.watchers.clear()
    },
  }
}

if (typeof module === 'object' && module && module.exports) module.exports = { createAgent, VERSION }

// По ssh: загрузчик оставил остаток входа в `__nrRest` — одна сессия на процесс, провод — stdin/stdout.
if (typeof globalThis.__nrRest === 'string') {
  const agent = createAgent()
  process.on('uncaughtException', (err) => process.stdout.write(`${JSON.stringify({ event: 'error', error: String(err && err.message) })}\n`))
  let buf = globalThis.__nrRest
  delete globalThis.__nrRest
  const drain = () => {
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) void agent.handle(line)
    }
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    drain()
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdout.write(`${JSON.stringify(agent.hello)}\n`)
  drain()
}
