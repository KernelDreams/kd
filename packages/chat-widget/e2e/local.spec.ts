/**
 * Приёмка вживую: `<nr-chat backend="local">` — бэкенд в странице (сборка из NR_CHAT_LOCAL_BACKEND_DIST;
 * виджет его не везёт — без переменной набор пропускается)
 * (demo/local.html, статика 7820), без сервера: провайдер — гейт `nr` по ключу
 * (из `models.json` окружения стенда), проект и сессии — OPFS, kv — IndexedDB.
 *
 *  (a) plain чат через local — стрим;
 *  (b) агент без exec: создать index.html и style.css, переименовать класс во
 *      всех файлах — write/edit над OPFS, апрув-карточки, файлы в zip;
 *  (c) apply_patch над OPFS;
 *  (d) скилл из skillbox (MCP HTTP напрямую, CORS skillbox): каталог в system,
 *      skill(name) работает, кэш (индекс — IndexedDB, файлы — OPFS) переживает
 *      перезагрузку;
 *  (e) exec в профиле — тул не объявлен, модель не зацикливается;
 *  (f) сессия переживает перезагрузку; экспорт .mds читается стендом nr.
 *
 * Модель — `glm-5.3-flash`. Ключи — из окружения стенда (не из репы):
 * NR_CHAT_LOCAL_PROVIDER / NR_CHAT_LOCAL_KEY, иначе `<env>/models.json`;
 * skillbox — NR_CHAT_SKILLBOX_KEY, иначе `client_air` из `~/.runz/config.md`.
 */

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { NR_BACKEND } from '../playwright.config'

const ENV_DIR = process.env.NR_CHAT_ENV_DIR ?? join(homedir(), 'Studio', 'envs')

function provider(): { url: string; key: string } | undefined {
  if (process.env.NR_CHAT_LOCAL_PROVIDER) return { url: process.env.NR_CHAT_LOCAL_PROVIDER, key: process.env.NR_CHAT_LOCAL_KEY ?? '' }
  try {
    const p = JSON.parse(readFileSync(join(ENV_DIR, 'models.json'), 'utf-8')).providers?.nr
    return p?.baseUrl ? { url: p.baseUrl, key: p.apiKey ?? '' } : undefined
  } catch {
    return undefined
  }
}

function skillboxKey(): string | undefined {
  if (process.env.NR_CHAT_SKILLBOX_KEY) return process.env.NR_CHAT_SKILLBOX_KEY
  try {
    const text = readFileSync(join(homedir(), '.runz', 'config.md'), 'utf-8')
    const block = text.split(/^## /m).find((b) => b.startsWith('$skillbox'))
    return block?.match(/^\$client_air:\s*(\S+)/m)?.[1]
  } catch {
    return undefined
  }
}

const P = provider()
test.skip(!P, 'нет провайдера: NR_CHAT_LOCAL_PROVIDER или models.json окружения')

async function open(page: Page, profile: string, extra: Record<string, string> = {}): Promise<void> {
  const q = new URLSearchParams({ provider: P!.url, key: P!.key, profile, ...extra })
  await page.goto(`/demo/local.html?${q}`)
  await page.waitForFunction(() => !!(document.getElementById('chat') as any)?.sessionId, undefined, { timeout: 60_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__runEnds = 0
    w.__tools = []
    const el = document.getElementById('chat')!
    el.addEventListener('run-end', () => (w.__runEnds += 1))
    el.addEventListener('tool-call', (e: Event) => w.__tools.push((e as CustomEvent).detail))
  })
}

/** Чистое хранилище страницы (OPFS + IndexedDB) — до первого подключения. */
async function wipe(page: Page): Promise<void> {
  await page.goto('/demo/local.html')
  await page.evaluate(async () => {
    localStorage.clear()
    const root = await navigator.storage.getDirectory()
    for await (const [n] of (root as any).entries()) await root.removeEntry(n, { recursive: true })
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase('nr-backend')
      req.onsuccess = req.onerror = req.onblocked = () => r(undefined)
    })
  })
}

async function say(page: Page, text: string): Promise<number> {
  const n = await page.evaluate(() => (window as any).__runEnds as number)
  const box = page.locator('#chat textarea').last()
  await expect(page.locator('#chat .status-line')).toBeEmpty()
  await box.fill(text)
  await box.press('Enter')
  return n + 1
}

async function ended(page: Page, n: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__runEnds as number), { timeout: 180_000 }).toBeGreaterThanOrEqual(n)
}

/** Разрешать карточки апрува, пока ран идёт. */
async function approveUntil(page: Page, n: number, tone: 'allow' | 'session' = 'session'): Promise<number> {
  let clicks = 0
  for (;;) {
    if ((await page.evaluate(() => (window as any).__runEnds as number)) >= n) return clicks
    const btn = page.locator(`#chat [data-ask="tool_approval"] button.${tone}`).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click()
      clicks++
    }
    await page.waitForTimeout(300)
  }
}

const fsCall = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(async ([fn, args]) => {
    const fs = (document.getElementById('chat') as any).localBackend.host.fs
    const r = await fs[fn as string](...(args as unknown[]))
    if (!r.ok) throw new Error(String(r.error))
    return r.value instanceof Uint8Array ? new TextDecoder().decode(r.value) : r.value
  }, [fn, args] as const)

const recipeTools = (page: Page) =>
  page.evaluate(async () => {
    const el = document.getElementById('chat') as any
    const b = el.localBackend
    const h = await b.history(el.sessionId)
    const last = h.messages.filter((m: any) => m.role === 'assistant').at(-1)
    const view = await b.messages.prompt(el.sessionId, last.id)
    return { tools: view.recipe.tools as string[], system: view.system as string, calls: h.messages.flatMap((m: any) => m.parts.filter((p: any) => p.type === 'tool_use').map((p: any) => p.meta.name)) }
  })

test.skip(!process.env.NR_CHAT_LOCAL_BACKEND_DIST, 'NR_CHAT_LOCAL_BACKEND_DIST не задан — бэкенда страницы нет')

test('(a) plain чат через local — стрим', async ({ page }) => {
  await wipe(page)
  await open(page, 'chat')
  expect(await page.evaluate(() => (document.getElementById('chat') as any).localBackend.host.storage)).toBe('opfs')
  const n = await say(page, 'Ответь ровно одним словом: привет')
  await expect(page.locator('#chat .msg.assistant.live')).toHaveCount(1)
  await ended(page, n)
  await expect(page.locator('#chat .msg.assistant').last()).toContainText(/привет/i)
})

test('(b) агент без exec: index.html + style.css, переименование класса во всех файлах — write/edit над OPFS, апрувы, zip', async ({ page }) => {
  await wipe(page)
  await open(page, 'agent')
  const n = await say(
    page,
    'Создай два файла тулом write: index.html (страница с <div class="card">Привет</div> и подключённым style.css) и style.css (правило .card { color: red; }). ' +
      'Затем переименуй класс card в tile во всех файлах тулом edit. Без вопросов.',
  )
  const clicks = await approveUntil(page, n)
  expect(clicks, 'апрув-карточки').toBeGreaterThan(0)
  await ended(page, n)
  const html = await fsCall(page, 'read', '/project/index.html')
  const css = await fsCall(page, 'read', '/project/style.css')
  expect(html).toMatch(/class="tile"/)
  expect(html).not.toMatch(/class="card"/)
  expect(css).toMatch(/\.tile/)
  expect(css).not.toMatch(/\.card/)
  const { calls } = await recipeTools(page)
  expect(calls).toContain('write')
  expect(calls.some((c) => c === 'edit' || c === 'write')).toBe(true)
  await expect(page.getByTestId('files')).toContainText('index.html')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('zip').click()])
  const zip = readFileSync((await download.path())!)
  const text = zip.toString('latin1')
  expect(text).toContain('index.html')
  expect(text).toContain('style.css')
  expect(text).toContain('class="tile"')
})

test('(c) apply_patch над OPFS', async ({ page }) => {
  await wipe(page)
  await open(page, 'agent')
  await fsCall(page, 'write', '/project/app.js', 'const a = 1\nconst b = 2\nconsole.log(a + b)\n')
  const patch = ['--- a/app.js', '+++ b/app.js', '@@ -1,3 +1,3 @@', ' const a = 1', '-const b = 2', '+const b = 40', ' console.log(a + b)'].join('\n')
  const n = await say(page, `Примени этот патч тулом apply_patch как есть, без правок:\n\n\`\`\`diff\n${patch}\n\`\`\``)
  await approveUntil(page, n)
  await ended(page, n)
  expect(await fsCall(page, 'read', '/project/app.js')).toBe('const a = 1\nconst b = 40\nconsole.log(a + b)\n')
  expect((await recipeTools(page)).calls).toContain('apply_patch')
})

test('(d) скилл из skillbox: каталог в system, skill(name), кэш в IndexedDB/OPFS переживает перезагрузку', async ({ page }) => {
  const key = skillboxKey()
  test.skip(!key, 'нет ключа skillbox (NR_CHAT_SKILLBOX_KEY или client_air в ~/.runz/config.md)')
  await wipe(page)
  await open(page, 'skills', { 'skillbox-key': key! })
  // Первая сверка на пустом кэше качает все файлы скиллов — ран ждёт её не дольше 5 с
  // (как Node-хост с пустым кэшем); приёмка ждёт её конца.
  await expect.poll(() => page.evaluate(() => (document.getElementById('chat') as any).localBackend.skills?.status()?.online === true), { timeout: 120_000 }).toBe(true)
  const n = await say(page, 'Загрузи скилл dev-skill тулом skill и назови одним предложением, о чём он.')
  await ended(page, n)
  const r = await recipeTools(page)
  expect(r.system).toContain('<available_skills>')
  expect(r.system).toContain('dev-skill')
  expect(r.calls).toContain('skill')
  const res = await page.evaluate(async () => {
    const el = document.getElementById('chat') as any
    const h = await el.localBackend.history(el.sessionId)
    return h.messages.flatMap((m: any) => m.parts.filter((p: any) => p.type === 'tool_result' && p.meta.name === 'skill').map((p: any) => ({ text: p.text, error: p.meta.error })))
  })
  expect(res.some((x: { text?: string; error?: boolean }) => !x.error && /<skill name="dev-skill"/.test(x.text ?? ''))).toBe(true)

  await page.reload()
  await page.waitForFunction(() => !!(document.getElementById('chat') as any)?.sessionId, undefined, { timeout: 60_000 })
  const cache = await page.evaluate(async () => {
    const host = (document.getElementById('chat') as any).localBackend.host
    const keys = (await host.kv.list('skills/')).value as string[]
    const index = (await host.kv.get(keys[0])).value as { skills: Array<{ name: string; rev: string }> }
    const dev = index.skills.find((s) => s.name === 'dev-skill')!
    const server = keys[0]!.split('/')[1]
    const file = (await host.fs.read(`/.cache/nr/skills/${server}/dev-skill@${dev.rev}/SKILL.md`)).value as string | undefined
    return { keys, hasFile: !!file && file.includes('dev-skill') }
  })
  expect(cache.keys.length).toBe(1)
  expect(cache.hasFile).toBe(true)
})

test('(e) exec в профиле — тул не объявлен, модель не зацикливается', async ({ page }) => {
  await wipe(page)
  await open(page, 'agent-exec')
  const n = await say(page, 'Выполни команду `ls -la` тулом exec и перескажи результат.')
  await approveUntil(page, n, 'allow')
  await ended(page, n)
  const r = await recipeTools(page)
  expect(r.tools).not.toContain('exec')
  expect(r.tools).not.toContain('process')
  expect(r.tools).toContain('write')
  expect(r.calls.filter((c) => c === 'exec')).toHaveLength(0)
  expect(r.calls.length, 'вызовов тулов').toBeLessThanOrEqual(6)
  await expect(page.locator('#chat .msg.assistant').last()).not.toBeEmpty()
})

test('(f) сессия переживает перезагрузку; экспорт .mds читается стендом nr', async ({ page }) => {
  await wipe(page)
  await open(page, 'chat')
  const n = await say(page, 'Запомни слово ЖИРАФ-226 и ответь «ок».')
  await ended(page, n)
  const sid = await page.evaluate(() => (document.getElementById('chat') as any).sessionId as string)

  await page.reload()
  await page.waitForFunction(() => !!(document.getElementById('chat') as any)?.sessionId, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => (document.getElementById('chat') as any).sessionId)).toBe(sid)
  await expect(page.locator('#chat .msg.user').first()).toContainText('ЖИРАФ-226')
  await expect(page.locator('#chat .msg.assistant')).toHaveCount(1)

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('mds').click()])
  const name = download.suggestedFilename()
  expect(name).toMatch(new RegExp(`_${sid}\\.mds$`))
  // Стенд nr: тот же формат сессий (pi-драйвер, .mds pi/2) — файл в его каталоге читается как есть.
  const dir = join(ENV_DIR, 'sessions', `--${ENV_DIR.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  test.skip(!existsSync(dir), `нет каталога сессий стенда ${dir}`)
  const dst = join(dir, name)
  copyFileSync((await download.path())!, dst)
  try {
    const res = await fetch(`${NR_BACKEND}/sessions/${encodeURIComponent(sid)}/history`)
    const body = (await res.json()) as { ok: boolean; result: { messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> } }
    expect(body.ok).toBe(true)
    const msgs = body.result.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0]!.parts.find((p) => p.type === 'text')!.text).toContain('ЖИРАФ-226')
  } finally {
    rmSync(dst, { force: true })
  }
})
