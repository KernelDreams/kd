/**
 * Настоящий браузер для веба: Chromium облачного профиля nr-browser по
 * CDP (`NR_WEB_BROWSER_CDP` — порт или `http://127.0.0.1:<порт>`, профиль `shop` —
 * 9303). Два применения:
 *
 * - `browserGet` — web_fetch упёрся в 403/429/анти-бот: страница открывается во
 *   временной вкладке профиля (куки, входы и прохождение капчи человеком — там),
 *   html отдаётся тому же `htmlToText`, вкладка закрывается;
 * - `AgentTab` — постоянная вкладка агента для тулов `browser_*` (tools-browser.ts).
 *
 * CDP — `CDPClient` из nr-web; браузер всегда на этой машине (`localhost:<порт>`).
 * Входы в магазины делает человек в окне профиля; модель видит только то, что
 * вернули тулы, пароли и одноразовые коды (BLIK) в вывод не попадают.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CDPClient, getTabs, newTab } from '@kerneldreams/web'
import type { WebEnv } from './search/types.js'

export const PAGE_TIMEOUT_MS = 25_000
/** Сколько ждать, пока JS-заглушка (Cloudflare «Just a moment») пропустит сама. */
export const CHALLENGE_WAIT_MS = 8_000

/** Порт CDP браузера из окружения; нет — браузера нет. */
export function browserPort(env: WebEnv): number | undefined {
  const raw = (env.NR_WEB_BROWSER_CDP ?? '').trim()
  if (!raw) return undefined
  const m = /(?:^|:)(\d{2,5})\/?$/.exec(raw)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

/** Окно профиля для человека — подсказка в ошибках «нужен человек». */
export function browserWindowHint(env: WebEnv): string {
  return env.NR_WEB_BROWSER_WINDOW ? ` (окно браузера: ${env.NR_WEB_BROWSER_WINDOW})` : ''
}

/**
 * Страница — заглушка анти-бота или капча, а не содержимое. По заголовку и телу:
 * Cloudflare, DataDome (Allegro), PerimeterX, Akamai, Amazon Robot Check.
 */
export function isChallenge(title: string, html: string): boolean {
  const t = title.toLowerCase()
  if (/just a moment|attention required|access denied|robot check|are you a robot|captcha|pardon our interruption|chwileczk/.test(t)) return true
  return /captcha-delivery\.com|cf-chl-|challenge-platform|px-captcha|_Incapsula_Resource|api-services-support@amazon\.com|validateCaptcha|bots use DuckDuckGo too/i.test(
    html.slice(0, 200_000),
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function abortable(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('запрос отменён'), { name: 'AbortError' })
}

/** Сессия CDP одной вкладки: eval по значению, навигация, ожидание загрузки. */
export class TabSession {
  constructor(
    readonly client: CDPClient,
    readonly targetId: string,
  ) {}

  static async open(port: number, url: string): Promise<TabSession> {
    const t = await newTab(port, url)
    if (!t.ok) throw t.error
    if (!t.value.webSocketDebuggerUrl || !t.value.id) throw new Error('у новой вкладки нет debugger url')
    const client = new CDPClient(t.value.webSocketDebuggerUrl, 30_000)
    await client.connect()
    return new TabSession(client, t.value.id)
  }

  static async attach(port: number, targetId: string): Promise<TabSession | undefined> {
    const tabs = await getTabs(port)
    if (!tabs.ok) throw tabs.error
    const tab = tabs.value.find((x) => x.id === targetId)
    if (!tab?.webSocketDebuggerUrl) return undefined
    const client = new CDPClient(tab.webSocketDebuggerUrl, 30_000)
    await client.connect()
    return new TabSession(client, targetId)
  }

  async eval<T>(expression: string): Promise<T> {
    const res = await this.client.send<any>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'eval exception')
    return res.result?.value as T
  }

  async navigate(url: string): Promise<void> {
    const r = await this.client.send<{ errorText?: string }>('Page.navigate', { url })
    if (r.errorText) throw new Error(`${url}: ${r.errorText}`)
  }

  /** Ждём `complete` (или срок), затем короткую тишину — SPA дорисовывает выдачу. */
  async settle(timeoutMs = PAGE_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + timeoutMs
    await sleep(300)
    while (Date.now() < until) {
      abortable(signal)
      const state = await this.eval<string>('document.readyState').catch(() => 'loading')
      if (state === 'complete') break
      await sleep(250)
    }
    await sleep(600)
  }

  /** Заглушка анти-бота: ждём, пока JS-проверка пропустит сама, до `CHALLENGE_WAIT_MS`. */
  async waitChallenge(signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + CHALLENGE_WAIT_MS
    for (;;) {
      const { title, html } = await this.page()
      if (!isChallenge(title, html)) return false
      if (Date.now() >= until) return true
      abortable(signal)
      await sleep(1000)
    }
  }

  /** Снимок страницы; посреди перехода документа ещё нет — короткие повторы. */
  async page(): Promise<{ url: string; title: string; html: string }> {
    const expr = '({ url: location.href, title: document.title, html: document.documentElement ? document.documentElement.outerHTML : "" })'
    let last: { url: string; title: string; html: string } = { url: '', title: '', html: '' }
    for (let i = 0; i < 20; i++) {
      last = await this.eval<typeof last>(expr).catch(() => last)
      if (last.html !== '') return last
      await sleep(250)
    }
    return last
  }

  close(): void {
    this.client.close()
  }
}

export async function closeTarget(port: number, targetId: string): Promise<void> {
  await fetch(`http://localhost:${port}/json/close/${targetId}`).catch(() => undefined)
}

export interface BrowserPage {
  url: string
  title: string
  html: string
  /** Заглушка не ушла — нужен человек в окне профиля. */
  challenge: boolean
}

/** Страница во временной вкладке профиля: открыть, дождаться, забрать html, закрыть. */
export async function browserGet(port: number, url: string, signal?: AbortSignal): Promise<BrowserPage> {
  const tab = await TabSession.open(port, url)
  try {
    await tab.settle(PAGE_TIMEOUT_MS, signal)
    const challenge = await tab.waitChallenge(signal)
    const p = await tab.page()
    return { ...p, challenge }
  } finally {
    tab.close()
    await closeTarget(port, tab.targetId)
  }
}

/**
 * Вкладка агента: одна на браузер, переживает вызовы и рестарт процесса (id
 * вкладки — в файле во временном каталоге). Закрыли руками — откроется новая.
 * Навигация, клики и ввод тулов `browser_*` идут сюда.
 */
export class AgentTab {
  private session: TabSession | undefined

  constructor(
    readonly port: number,
    private readonly idFile = join(tmpdir(), `nr-agent-tab-${port}`),
  ) {}

  private savedId(): string | undefined {
    try {
      return readFileSync(this.idFile, 'utf8').trim() || undefined
    } catch {
      return undefined
    }
  }

  async get(): Promise<TabSession> {
    if (this.session) {
      const alive = await this.session.eval<number>('1').catch(() => 0)
      if (alive === 1) return this.session
      this.session.close()
      this.session = undefined
    }
    const id = this.savedId()
    if (id) {
      const again = await TabSession.attach(this.port, id).catch(() => undefined)
      if (again) return (this.session = again)
    }
    const s = await TabSession.open(this.port, 'about:blank')
    try {
      writeFileSync(this.idFile, s.targetId)
    } catch {
      /* без файла вкладка живёт до рестарта процесса */
    }
    return (this.session = s)
  }
}
