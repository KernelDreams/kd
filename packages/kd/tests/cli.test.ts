/**
 * Вход kd (§3, §4, §6, §7, §10): каталог на чистой машине, конфликт проекта, коды 0–4,
 * конверт --json, недостающее поле без терминала, --params из stdin, переносная копия.
 * Нужна сборка пакета (тулы комплекта — dist/tools).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, type Io } from '../src/node/cli.js'

let root: string
let home: string
let work: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kd-cli-'))
  home = join(root, 'home')
  work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface Run {
  code: number
  out: string
  err: string
}

async function kd(argv: string[], o: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}): Promise<Run> {
  let out = ''
  let err = ''
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, KD_HOME: join(home, '.kd'), KD_SECRETS: 'file', ...o.env }
  const io: Io = {
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    readStdin: async () => o.stdin ?? '',
    interactive: false,
    cwd: o.cwd ?? work,
    env,
  }
  const code = await main(argv, io)
  return { code, out, err }
}

const tool = (dir: string, name: string, src: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), src)
}

describe('§3 каталог и слои', () => {
  it('чистая машина (нет ~/Studio и ~/.runz) — каталог комплекта', async () => {
    const r = await kd([])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^completion\s+/m)
    expect(r.out).toMatch(/^provider\s+/m)
    expect(r.out).toMatch(/^info\s+/m)
  })
  it('проект не перекрывает тул комплекта — громкая ошибка с обоими путями', async () => {
    tool(join(work, '.kd', 'tools'), 'provider.mjs', 'export default () => ({ output: "чужой" })\n')
    const r = await kd(['provider'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/provider: .*\.kd\/tools\/provider\.mjs \(проект\) и .*dist\/tools\/provider\.mjs \(kit\)/)
  })
  it('проект добавляет свой тул', async () => {
    tool(join(work, '.kd', 'tools'), 'hello.mjs', 'export const tool = { description: "привет", fields: { who: "string $pos=1 // Кому" } }\nexport default (ctx) => ({ output: "привет, " + ctx.get(["who"]) })\n')
    expect((await kd([])).out).toMatch(/^hello\s+привет/m)
    expect(await kd(['hello', 'мир'])).toMatchObject({ code: 0, out: 'привет, мир\n' })
  })
  it('студийный профиль: $layers добавляет каталоги тулов', async () => {
    const studio = join(root, 'studio-tools')
    tool(studio, 'stu.mjs', 'export default () => ({ output: "студия" })\n')
    mkdirSync(join(home, '.kd'), { recursive: true })
    writeFileSync(join(home, '.kd', 'settings.mdz'), `$layers: $[${studio}]\n`)
    expect(await kd(['stu'])).toMatchObject({ code: 0, out: 'студия\n' })
  })
})

describe('§3 коды выхода', () => {
  beforeEach(() => {
    const d = join(work, '.kd', 'tools')
    tool(d, 'boom.mjs', 'export default () => { throw new Error("сломался") }\n')
    tool(d, 'stop.mjs', 'export default () => { throw Object.assign(new Error("занято дольше потолка"), { exitCode: 4 }) }\n')
    tool(d, 'llm.mjs', 'export const tool = { description: "с моделью", needs: ["model"], fields: { q: "string? $rest // Вопрос" } }\nexport default () => ({ output: "ответ" })\n')
    tool(d, 'need.mjs', 'export const tool = { fields: { url: "string $pos=1 // Адрес" } }\nexport default (c) => ({ output: String(c.get(["url"])) })\n')
  })
  it('0 — готово', async () => expect((await kd(['need', 'x'])).code).toBe(0))
  it('1 — тул упал', async () => {
    const r = await kd(['boom'])
    expect(r.code).toBe(1)
    expect(r.err + r.out).toMatch(/сломался/)
  })
  it('2 — неверный вызов; последняя строка stderr — исправленная команда', async () => {
    const r = await kd(['need'])
    expect(r.code).toBe(2)
    expect(r.err.trim().split('\n').pop()).toBe('kd need --url=<Адрес>')
    expect((await kd(['need', 'a', 'b'])).code).toBe(2)
    expect((await kd(['никто'])).code).toBe(2)
  })
  it('3 — нет провайдера: без терминала до старта, быстрее секунды', async () => {
    const t = Date.now()
    const r = await kd(['llm', 'привет'])
    expect(r.code).toBe(3)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r.err.trim().split('\n').pop()).toMatch(/^kd provider add /)
  })
  it('тул без $needs: model работает без единого ключа', async () => expect((await kd(['info', join(work)])).code).toBe(0))
  it('3 → провайдер добавлен — тул идёт', async () => {
    expect((await kd(['provider', 'add', 'openrouter', '--key=sk-test'])).code).toBe(0)
    expect((await kd(['llm', 'привет'])).code).toBe(0)
  })
  it('4 — прерван с сохранённым состоянием', async () => {
    const r = await kd(['stop'])
    expect(r.code).toBe(4)
    expect(r.err).toMatch(/той же командой/)
  })
  it('--json — конверт одной строкой', async () => {
    const ok = await kd(['--json', 'need', 'x'])
    expect(JSON.parse(ok.out)).toEqual({ ok: true, code: 0, artifacts: [], output: 'x' })
    const bad = await kd(['--json', 'need'])
    const j = JSON.parse(bad.out)
    expect(j).toMatchObject({ ok: false, code: 2, error: { field: 'url', fix: 'kd need --url=<Адрес>' } })
  })
  it('--dry: тул не заявил всухую — код 2, не исполняется', async () => {
    const r = await kd(['--dry', 'need', 'x'])
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
  })
  it('служебный флаг runz после имени — код 2 с подсказкой, тул не исполняется', async () => {
    const mark = join(root, 'ran')
    tool(join(work, '.kd', 'tools'), 'touchy.mjs', `import { writeFileSync } from 'node:fs'\nexport default () => { writeFileSync(${JSON.stringify(mark)}, '1'); return { output: 'ran' } }\n`)
    const r = await kd(['touchy', 'x', '--runz-dry'])
    expect(r.code).toBe(2)
    expect(existsSync(mark)).toBe(false)
    expect(r.err).toMatch(/служебные флаги kd стоят до имени: kd --dry/)
    expect(r.err.trim().split('\n').pop()).toBe('kd --dry touchy x')
    const doc = join(work, 'recipe.mdz')
    writeFileSync(doc, '$handler: nothing\n')
    const d = await kd([doc, '--runz-debug'])
    expect(d.code).toBe(2)
    expect(d.err.trim().split('\n').pop()).toBe(`kd -v ${doc}`)
  })
  it('--params - байтами из PowerShell (here-string → stdin): хвост \\r\\n, CRLF целиком, BOM — один объект', async () => {
    tool(join(work, '.kd', 'tools'), 'echo2.mjs', "export const tool = { description: 'эхо', fields: { url: 'string // Адрес', prompt: 'string? // Текст' } }\nexport default (ctx) => ({ output: JSON.stringify({ url: ctx.get(['url']), prompt: ctx.get(['prompt']) }) })\n")
    // Ровно то, что pwsh 7 и PowerShell 5.1 ($OutputEncoding = UTF-8) отдали node на laptop.
    const ps = '$tool: echo2\n$url: "C:\\path\\with \\"quotes\\" and $dollar `tick"\n\n## $prompt\n````\n--- разделитель ---\n## $form\n```js\nconst s = \'a\\\\b\' + "c\\"d";\n```\nÜnïcödé — тест\n````\r\n'
    const want = JSON.stringify({ url: 'C:\\path\\with "quotes" and $dollar `tick', prompt: '--- разделитель ---\n## $form\n```js\nconst s = \'a\\\\b\' + "c\\"d";\n```\nÜnïcödé — тест' })
    for (const stdin of [ps, ps.replace(/\r?\n/g, '\r\n'), '\ufeff' + ps]) {
      const r = await kd(['echo2', '--params', '-'], { stdin })
      expect(r.code).toBe(0)
      expect(r.out.trim()).toBe(want)
    }
  })
  it('--params - из stdin (mdz и JSON) и --поле=-', async () => {
    expect((await kd(['need', '--params', '-'], { stdin: '$url: "a b"\n' })).out).toBe('a b\n')
    expect((await kd(['need', '--params', '-'], { stdin: '{"url":"c\\\\d"}' })).out).toBe('c\\d\n')
    expect((await kd(['need', '--url=-'], { stdin: 'из stdin' })).out).toBe('из stdin\n')
  })
})

describe('§4 что угодно → тул', () => {
  it('документ без исполняемого — показать; файл другого вида — действия по виду', async () => {
    writeFileSync(join(work, 'README.md'), '# Заголовок\n\nтекст\n')
    expect(await kd(['README.md'])).toMatchObject({ code: 0, out: '# Заголовок\n\nтекст\n' })
    writeFileSync(join(work, 'a.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000', 'hex'))
    const r = await kd(['a.png'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/пиксели: 2×3/)
  })
  it('адрес по правилам ссылок: группы шаблона ложатся в вызов; действие словом', async () => {
    const d = join(work, '.kd')
    tool(join(d, 'tools'), 'bot.mjs', 'export const tool = { fields: { url: "string $pos=1 $kind=bot // Бот" }, actions: { show: { default: true }, play: {} } }\nexport default (c) => ({ output: c.get(["action"]) + " " + c.get(["url"]) })\n')
    writeFileSync(
      join(d, 'links.mdz'),
      ["## $link bot", "$pattern: 'https://bots\\.example/(?<slug>[\\w-]+)'", '$kind: bot', '', '## $action bot.show', '$for: bot', '$run: kd', '$cmd: bot show ${text}', '$default: true', '', '## $action bot.play', '$for: bot', '$run: kd', '$cmd: bot play ${text}'].join('\n'),
    )
    expect((await kd(['https://bots.example/cat'])).out).toBe('show https://bots.example/cat\n')
    expect((await kd(['https://bots.example/cat', 'play'])).out).toBe('play https://bots.example/cat\n')
    expect((await kd(['play', 'https://bots.example/cat'])).code).toBe(2) // «play» — не тул и не объект
    // опечатка в действии и лишнее слово не уходят молча действию по умолчанию
    const typo = await kd(['https://bots.example/cat', 'plya'])
    expect(typo.code).toBe(2)
    expect(typo.err).toMatch(/может быть «play»/)
    expect((await kd(['https://bots.example/cat', 'nonsense'])).code).toBe(2)
    // всухую действие-команда не исполняется
    writeFileSync(join(d, 'links.mdz'), ["## $link bot", "$pattern: 'https://bots\\.example/(?<slug>[\\w-]+)'", '$kind: bot', '', '## $action bot.touch', '$for: bot', '$run: exec', '$cmd: touch touched.txt', '$default: true'].join('\n'))
    const dry = await kd(['--dry', 'https://bots.example/cat', 'touch'])
    expect(dry.code).toBe(0)
    expect(dry.out).toMatch(/touch над «https:\/\/bots.example\/cat» → touch touched.txt \(ничего не запущено\)/)
    expect(existsSync(join(work, 'touched.txt'))).toBe(false)
  })
  it('ничего не подошло — код 2 со списком умений', async () => {
    const r = await kd(['https://nowhere.example/x'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/kd умеет/)
  })
})

describe('§10 копии', () => {
  it('переносная копия не оставляет ничего в ~/.kd', async () => {
    const copy = join(root, 'portable')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'kd-copy.mdz'), '$mode: portable\n$id: pix\n')
    const r = await kd([], { env: { KD_COPY_DIR: copy } })
    expect(r.code).toBe(0)
    expect(existsSync(join(home, '.kd'))).toBe(false)
    expect(readdirSync(join(copy, 'data'))).toContain('cache')
  })
  it('ключ, введённый в системном kd, виден установленной сборке', async () => {
    expect((await kd(['provider', 'add', 'anthropic', '--key=sk-sys'])).code).toBe(0)
    const copy = join(root, 'installed')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'kd-copy.mdz'), '$mode: installed\n$id: pix\n')
    tool(join(work, '.kd', 'tools'), 'llm.mjs', 'export const tool = { needs: ["model"] }\nexport default () => ({ output: process.env.ANTHROPIC_API_KEY })\n')
    const r = await kd(['llm'], { env: { KD_COPY_DIR: copy } })
    expect(r).toMatchObject({ code: 0, out: 'sk-sys\n' })
  })
})

describe('§10 регистрация сборки', () => {
  it('установленная сборка регистрируется сама, и `kd photo.png edit` открывает её', async () => {
    const app = join(root, 'pix')
    mkdirSync(app, { recursive: true })
    const marker = join(root, 'opened.txt')
    writeFileSync(join(app, 'kd-copy.mdz'), '$mode: installed\n$id: pix\n$name: KD Pix\n$links: $[kd-links.mdz]\n')
    writeFileSync(join(app, 'kd-links.mdz'), ['## $action image.edit', '$for: image', '$title: открыть в KD Pix', '$run: exec', `$cmd: echo "\${path}" > ${marker}`].join('\n'))
    expect((await kd([], { env: { KD_COPY_DIR: app } })).code).toBe(0)
    expect(existsSync(join(home, '.kd', 'apps', 'pix.mdz'))).toBe(true)
    writeFileSync(join(work, 'photo.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'))
    const r = await kd(['photo.png', 'edit'])
    expect(r.code).toBe(0)
    expect(require('node:fs').readFileSync(marker, 'utf8').trim()).toBe(join(work, 'photo.png'))
    // `kd app` видит регистрацию; снятие — файл уходит; сборки нет — пропуск с сообщением
    expect((await kd(['app'])).out).toMatch(/pix\s+/)
    rmSync(app, { recursive: true, force: true })
    const gone = await kd([])
    expect(gone.code).toBe(0)
    expect(gone.err).toMatch(/pix\.mdz: сборки по пути .* нет — регистрация пропущена/)
    expect((await kd(['app', 'unregister', 'pix'])).code).toBe(0)
    expect(existsSync(join(home, '.kd', 'apps', 'pix.mdz'))).toBe(false)
  })
})
