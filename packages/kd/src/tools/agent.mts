/**
 * `kd agent "задача"` (kd-cli-spec §9) — цикл агента (расширение `agent`) в текущей папке одним процессом, без стенда
 * (наследник nr-code): тулы файлов и шелла, MCP и скиллы профиля, компакция. `--check=<команда>` —
 * «готово» решает проверка: ран → проверка → хвост вывода агенту → до зелёного или `--max-rounds`.
 * Сессии — `<данные kd>/sessions/<папка>/` (`.mds`), `-c` — продолжить последнюю, `-r` — выбрать.
 * Подтверждений нет (§8): тулы разрешены, ограничение — средой. Вопрос агента — ящик вопросов:
 * терминал / окно `kd ui`, без человека — умолчание.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { agentHelper, loadBackendNr } from '@kerneldreams/runz-runtime'
import type { IContext } from '@kerneldreams/nrd'
import { ask, hubOf } from '../node/inbox.js'
import { hostOf } from '../node/host.js'
import { openWindow, type WindowHandle } from '../node/window.js'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'

export const tool = {
  description: 'агент в текущей папке: тулы файлов и шелла, цикл до зелёной проверки',
  fields: {
    task: 'text? $rest // Задача',
    check: 'string? // Команда проверки: «готово» — её код 0',
    'max-rounds': 'number? 1..50 // Раундов не больше',
    model: 'string? $kind=model // Модель (иначе — провайдера по умолчанию)',
    provider: 'string? // Провайдер (иначе — по умолчанию)',
    agent: 'string? // Профиль агента (id или путь .mds/.mdz)',
    continue: 'checkbox // Продолжить последнюю сессию этой папки',
    resume: 'checkbox // Выбрать сессию этой папки',
    session: 'string? // Сессия: id или путь .mds',
    cwd: 'string? $kind=file // Рабочая папка (по умолчанию — текущая)',
    ui: 'checkbox // Окно с лентой и вопросами (kd ui)',
  },
  defaults: { 'max-rounds': 5 },
  aliases: { c: 'continue', r: 'resume' },
  needs: ['model'],
  examples: ['kd agent "почини тесты" --check="npm test"', 'kd agent -c "дальше"', 'kd agent --ui "разбери репу"'],
}

/** Ответ `ask_user` без человека (nr-code): реши сам. */
const DECIDE = 'Человека в прогоне нет. Реши сам, допущение назови в ответе.'

type Ctx = IContext

const str = (ctx: Ctx, k: string): string => {
  const v = ctx.get([k])
  // Только скаляр: `provider` в цепочке — ещё и блоки `## $provider <имя>` конфига.
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

/** Папка сессий для рабочей папки. */
export function sessionsDir(data: string, cwd: string): string {
  return join(data, 'sessions', resolve(cwd).replace(/^\/+/, '').replace(/[\\/:]+/g, '__') || 'root')
}

function sessionsOf(dir: string): Array<{ file: string; mtime: number }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mds'))
    .map((f) => ({ file: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

function runCheck(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (b: Buffer): void => {
      out += b.toString('utf8')
      if (out.length > 2_000_000) out = out.slice(-1_000_000)
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', (e) => (out += `\n[проверка: ${e.message}]`))
    child.on('close', (code) => done({ code: code ?? 1, output: out }))
  })
}

const tail = (t: string, n = 60): string => t.replace(/\s+$/, '').split('\n').slice(-n).join('\n')

/** Агент kd над папкой: без подтверждений, вопросы — ящиком (терминал, окна, без человека — умолчание). */
export async function makeAgent(ctx: Ctx, cwd: string, dir: string, log: (m: string) => void, o: { terminal?: boolean } = {}) {
  const host = hostOf()
  const data = host?.layers.copy.dataDir ?? process.cwd()
  const home = host?.layers.copy.readsShared ? host.layers.copy.sharedHome : data
  const terminal = o.terminal !== false && host?.io.interactive && host.io.ask ? host.io.ask : undefined
  // Агент — расширение (слот `agent`): в открытом kd его нет — понятная ошибка до всего остального.
  await loadBackendNr(ctx, 'kd agent')
  const a = await agentHelper(ctx, cwd, log)({
    cwd,
    store: { dir },
    toolPolicy: 'auto',
    askDefaults: { ask_user: DECIDE },
    ...(str(ctx, 'model') ? { model: str(ctx, 'model') } : {}),
    ...(str(ctx, 'agent') ? { profile: str(ctx, 'agent') } : {}),
    ...(str(ctx, 'provider') ? { provider: str(ctx, 'provider') } : {}),
    ask: async ({ question, options }: { question: string; options: string[] }) => {
      // Есть хаб (`$hub` настроек, `KD_HUB`) — вопрос дублируется туда: «Ждёт тебя» в nrchat, уведомление.
      const hub = host ? hubOf(host.layers.settings, host.io.env) : hubOf({}, process.env)
      const r = await ask(home, { question, options, default: options[0] ?? DECIDE, from: `kd agent ${basename(cwd)}`, ...(terminal ? { terminal } : {}), ...(hub ? { hub, warn: log } : {}) })
      if (r.by === 'default') log(`kd agent: вопрос «${question}» — взято умолчание: ${r.answer}`)
      return r.by === 'human' ? r.answer : `${r.answer} (взято умолчание: человек не ответил)`
    },
  } as never)
  return { a, home }
}

export default async function agent(ctx: Ctx, meta: { dataDir?: string }): Promise<{ output: string; exitCode?: number }> {
  const host = hostOf()
  const data = host?.layers.copy.dataDir ?? meta.dataDir ?? process.cwd()
  const cwd = resolve(str(ctx, 'cwd') || host?.io.cwd || process.cwd())
  const dir = sessionsDir(data, cwd)
  mkdirSync(dir, { recursive: true })
  let file = ''
  const given = str(ctx, 'session')
  if (given) file = given.endsWith('.mds') ? resolve(cwd, given) : join(dir, `${given}.mds`)
  else if (ctx.get(['continue']) === true) {
    const last = sessionsOf(dir)[0]
    if (!last) return { output: `kd agent: в ${cwd} сессий нет — начните без -c`, exitCode: 2 }
    file = join(dir, last.file)
  } else if (ctx.get(['resume']) === true) {
    const list = sessionsOf(dir)
    if (!list.length) return { output: `kd agent: в ${cwd} сессий нет`, exitCode: 2 }
    if (!host?.io.interactive || !host.io.ask) return { output: `kd agent: -r без терминала — укажите --session=<id>:\n${list.map((s) => `  ${s.file.replace(/\.mds$/, '')}`).join('\n')}`, exitCode: 2 }
    host.io.stderr(list.slice(0, 20).map((s, i) => `  ${i + 1}) ${s.file.replace(/\.mds$/, '')}  ${new Date(s.mtime).toLocaleString()}`).join('\n') + '\n')
    const n = Number((await host.io.ask('сессия: ')).trim())
    if (!list[n - 1]) return { output: 'kd agent: выбор не сделан', exitCode: 2 }
    file = join(dir, list[n - 1]!.file)
  }
  const resumed = !!file && existsSync(file)
  if (!file) file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mds`)
  const text = str(ctx, 'task')
  if (!text && !resumed && ctx.get(['ui']) !== true) return { output: 'kd agent: нужна задача\nkd agent "что сделать"', exitCode: 2 }
  const log = (m: string): void => void process.stderr.write(`${m}\n`)
  // Сессия путём — её папка и есть стор (kd chat <файл.mds>).
  const { a, home } = await makeAgent(ctx, cwd, given.endsWith(".mds") ? dirname(file) : dir, log)
  let win: WindowHandle | undefined
  try {
    const session = (await a.session({ file: basename(file), ...(resumed ? {} : { title: `kd agent: ${basename(cwd)}`, meta: { workspace: { cwd } } }) } as never)) as unknown as {
      id: string
      run(i: unknown): Promise<{ lastText(): string }>
    }
    log(`kd agent: сессия ${file}${resumed ? ' (продолжение)' : ''}; модель ${a.model ?? 'по умолчанию'}; папка ${cwd}`)
    // Окно (§9): тот же бэкенд по HTTP на loopback — лента прогона видна в <nr-chat>, вопросы — формой.
    if (ctx.get(['ui']) === true) {
      win = await openWindow((a as unknown as { backend: ProtocolBackend }).backend, { home, title: `агент · ${basename(cwd)}`, cwd, session: session.id })
      log(`kd agent: окно ${win.url}`)
    }
    const result = await loop(session, text, ctx, cwd, file, log)
    if (win) {
      log('kd agent: окно открыто — Ctrl+C закрыть')
      await untilSignal()
    }
    return result
  } finally {
    await win?.close()
    await a.close()
  }
}

async function loop(session: { run(i: unknown): Promise<{ lastText(): string }> }, text: string, ctx: Ctx, cwd: string, file: string, log: (m: string) => void): Promise<{ output: string; exitCode?: number }> {
  const check = str(ctx, 'check')
  const max = Math.max(1, Number(ctx.get(['max-rounds']) ?? 5) || 5)
  let prompt: string | undefined = text || undefined
  if (!prompt && ctx.get(['ui']) === true && !check) return { output: `сессия: ${file}` }
  let last = ''
  for (let round = 1; round <= max; round++) {
    log(`kd agent: раунд ${round}/${max}`)
    const r = await session.run(prompt ? { text: prompt } : {})
    last = r.lastText()
    if (!check) return { output: last }
    const c = await runCheck(check, cwd)
    log(`kd agent: проверка «${check}» — код ${c.code}`)
    if (c.code === 0) return { output: `${last}\n\nпроверка зелёная за ${round} раунд(а); сессия: ${file}` }
    prompt = [`Проверка \`${check}\` не прошла (код ${c.code}). Хвост вывода (60 строк):`, '```', tail(c.output), '```', 'Исправь причину и доведи до зелёной проверки. Тесты не ослабляй.'].join('\n')
  }
  return { output: `${last}\n\nпроверка так и не прошла за ${max} раунд(ов); продолжить: kd agent -c\nсессия: ${file}`, exitCode: 1 }
}

/** Ждать Ctrl+C / SIGTERM. */
export function untilSignal(): Promise<void> {
  return new Promise((r) => {
    const done = (): void => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      r()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}
