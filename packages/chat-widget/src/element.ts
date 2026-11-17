/**
 * `<nr-chat>` — Web Component чата: Shadow DOM, лента, ввод, карточки.
 *
 * Атрибуты: `backend`, `session` (`auto` — новая), `profile`, `transport`
 * (`nr` | `acp` | `local`), `auth`, `cwd`, `lang` (`ru` | `en`), `theme`
 * (`light` | `dark` | `auto`), `skin` (скин nrchat с бэкенда nr — `GET /skins/<имя>.css`,
 *), `placeholder`; для `backend="local"`
 * — `provider-url`, `provider-key`, `local-module`, `local-storage`. Смена
 * `backend`/`session`/`transport`/`auth`/`profile`/`cwd`/`provider-*` у
 * подключённого — переподключение.
 *
 * JS: `send(text)`, `stop()`, `registerTool(def, handler)`, `onContext(fn)`,
 * `sessionId`, `ready`. События (bubbles, composed): `session`, `message`,
 * `run-start`, `run-end`, `tool-call`, `error`.
 */

import { AcpTransport } from './acp-transport.js'
import { Feed } from './feed.js'
import { strings, type Strings } from './i18n.js'
import { LocalTransport, localBackendFor } from './local-transport.js'
import { NrTransport } from './nr-transport.js'
import { renderMessage, type RenderCtx } from './render.js'
import { CSS } from './styles.js'
import { SKIN_BRIDGE_CSS, fetchSkin, shadowSkinCss } from './skin.js'
import { errorText, type PageToolDef, type PageToolHandler, type Transport, type TransportHost, type WidgetOptions } from './transport.js'

const ATTRS = ['backend', 'session', 'profile', 'transport', 'auth', 'cwd', 'lang', 'theme', 'skin', 'placeholder', 'provider-url', 'provider-key', 'local-module', 'local-storage'] as const
const RECONNECT = new Set(['backend', 'session', 'transport', 'auth', 'profile', 'cwd', 'provider-url', 'provider-key', 'local-module', 'local-storage'])
/** Опция → атрибут (`providerUrl` → `provider-url`). */
const attrOf = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** База для Node/SSR: импорт бандла без DOM не должен падать. */
const Base: typeof HTMLElement = typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as typeof HTMLElement)

export class NrChatElement extends Base {
  static get observedAttributes(): readonly string[] {
    return ATTRS
  }

  /** Лента (только чтение — для страниц и тестов). */
  readonly feed = new Feed()
  private transport: Transport | undefined
  private readonly tools = new Map<string, { def: PageToolDef; handler: PageToolHandler }>()
  private contextFn: (() => unknown | Promise<unknown>) | undefined
  private opts: Partial<WidgetOptions> = {}
  private t: Strings = strings(undefined)
  private root: ShadowRoot | undefined
  private feedEl!: HTMLElement
  private input!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private statusEl!: HTMLElement
  private readonly nodes = new Map<string, HTMLElement>()
  private readonly open = new Set<string>()
  private running = false
  private connectP: Promise<void> | undefined
  private generation = 0
  private local: import('@kerneldreams/ui-protocol').ProtocolBackend | undefined

  /** Резолвится, когда сессия готова (после подключения). */
  get ready(): Promise<void> {
    return this.connectP ?? Promise.resolve()
  }

  get sessionId(): string | undefined {
    return this.transport?.sessionId
  }

  get busy(): boolean {
    return this.running
  }

  /** local: бэкенд страницы (готовый — до подключения; после — тот, что поднят). */
  get localBackend(): import('@kerneldreams/ui-protocol').ProtocolBackend | undefined {
    return this.local
  }

  set localBackend(b: import('@kerneldreams/ui-protocol').ProtocolBackend | undefined) {
    this.local = b
    this.opts = { ...this.opts, ...(b ? { localBackend: b } : {}) }
    if (!b) delete this.opts.localBackend
    if (this.isConnected) {
      this.feed.clear()
      this.schedule()
    }
  }

  /** Опции из JS (`mount`): поверх атрибутов. */
  configure(opts: Partial<WidgetOptions>): this {
    this.opts = { ...this.opts, ...opts }
    if (opts.theme) this.setAttribute('theme', opts.theme)
    this.t = strings(this.option('lang'))
    if (this.isConnected) {
      this.applyPlaceholder()
      this.feed.clear()
      this.schedule()
    }
    return this
  }

  /** Тул страницы: модель зовёт его, исполняет `handler` (nr: `sessionMeta.tools`). */
  registerTool(def: PageToolDef, handler: PageToolHandler): this {
    this.tools.set(def.name, { def, handler })
    if (this.transport?.sessionId) void this.transport.syncTools().catch((err) => this.fire('error', { message: errorText(err) }))
    return this
  }

  unregisterTool(name: string): this {
    if (this.tools.delete(name) && this.transport?.sessionId) void this.transport.syncTools().catch(() => {})
    return this
  }

  /** Снимок страницы перед каждым ходом (nr: `sessionMeta.pageContext`; acp — ресурсом в prompt). */
  onContext(fn: (() => unknown | Promise<unknown>) | undefined): this {
    this.contextFn = fn
    return this
  }

  /** Отправить сообщение (как из поля ввода). Резолвится по концу рана. */
  async send(text: string): Promise<void> {
    const msg = text.trim()
    if (!msg) return
    if (this.running) throw new Error('nr-chat: ран уже идёт')
    if (!this.connectP) this.schedule()
    await this.connectP
    const tr = this.transport
    if (!tr?.sessionId) throw new Error('nr-chat: нет сессии')
    this.setRunning(true)
    try {
      await tr.send(msg)
    } finally {
      this.setRunning(false)
    }
  }

  stop(): void {
    this.transport?.stop()
  }

  // ── жизненный цикл ───────────────────────────────────────────────────────

  connectedCallback(): void {
    if (!this.root) this.build()
    this.t = strings(this.option('lang'))
    this.applyPlaceholder()
    void this.applySkin()
    if (!this.transport) this.schedule()
  }

  disconnectedCallback(): void {
    this.generation++
    this.transport?.close()
    this.transport = undefined
    this.connectP = undefined
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (prev === next || !this.root) return
    if (name === 'lang') this.t = strings(next ?? undefined)
    if (name === 'placeholder' || name === 'lang') this.applyPlaceholder()
    if (name === 'skin' || name === 'theme' || name === 'backend' || name === 'auth') void this.applySkin()
    if (RECONNECT.has(name) && this.isConnected) {
      this.feed.clear()
      this.schedule()
    }
  }

  // ── подключение ──────────────────────────────────────────────────────────

  private option<K extends keyof WidgetOptions>(key: K): WidgetOptions[K] | undefined {
    const fromJs = this.opts[key]
    if (fromJs !== undefined) return fromJs
    const attr = this.getAttribute(attrOf(key))
    return (attr === null || attr === '' ? undefined : attr) as WidgetOptions[K] | undefined
  }

  private options(): WidgetOptions | undefined {
    const backend = this.option('backend')
    if (!backend) return undefined
    const o: WidgetOptions = { backend }
    for (const k of ['transport', 'session', 'profile', 'auth', 'cwd', 'lang', 'theme', 'placeholder', 'providerUrl', 'providerKey', 'localModule', 'localStorage', 'localBackend', 'localOptions'] as const) {
      const v = this.option(k)
      if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v
    }
    if (!o.transport) o.transport = backend === 'local' ? 'local' : /^wss?:/i.test(backend) ? 'acp' : 'nr'
    return o
  }

  /**
   * Подключиться в микротаске: атрибуты, выставленные подряд, — одним
   * подключением. Новое планирование гасит прежнее (поколение).
   */
  private schedule(): void {
    this.transport?.close()
    this.transport = undefined
    const gen = ++this.generation
    this.connectP = new Promise<void>((resolve) =>
      queueMicrotask(() => {
        if (gen !== this.generation) return resolve()
        this.connect(gen).finally(resolve)
      }),
    )
  }

  private async connect(gen: number): Promise<void> {
    const opts = this.options()
    if (!opts) return
    const contextOf = (): (() => unknown | Promise<unknown>) | undefined => this.contextFn
    const host: TransportHost = {
      feed: this.feed,
      t: this.t,
      options: opts,
      pageTools: this.tools,
      get context() {
        return contextOf()
      },
      emit: (name, detail) => this.fire(name, detail),
    }
    this.status(this.t.connecting)
    let tr: Transport | undefined
    try {
      if (opts.transport === 'local') {
        const backend = await localBackendFor(opts)
        if (gen !== this.generation) return
        this.local = backend
        tr = new LocalTransport(host, backend)
      } else tr = opts.transport === 'acp' ? new AcpTransport(host) : new NrTransport(host)
      this.transport = tr
      await tr.connect()
      if (gen !== this.generation) return void tr.close()
      this.status('')
    } catch (err) {
      if (gen !== this.generation) return
      this.status(`${this.t.connectFailed}: ${errorText(err)}`)
      this.fire('error', { message: errorText(err) })
    }
  }

  // ── скин ───────────────────────────────────────────────────────

  private skinEl: HTMLStyleElement | undefined
  private skinGen = 0
  private modeQuery: MediaQueryList | undefined

  /** Режим для правил скина: `theme` атрибутом или системный. */
  private applyMode(): void {
    const theme = this.option('theme')
    const dark = theme === 'dark' || (theme !== 'light' && (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false))
    this.setAttribute('data-nr-mode', dark ? 'dark' : 'light')
  }

  /** `skin` → CSS скина с бэкенда nr в Shadow DOM; нет атрибута — свой облик виджета. */
  private async applySkin(): Promise<void> {
    if (!this.root) return
    const gen = ++this.skinGen
    const name = this.getAttribute('skin')?.trim()
    const backend = this.option('backend')
    if (!name || !backend || !/^https?:/i.test(backend)) {
      this.skinEl?.remove()
      this.skinEl = undefined
      this.removeAttribute('data-nr-mode')
      return
    }
    if (!this.modeQuery && globalThis.matchMedia) {
      this.modeQuery = globalThis.matchMedia('(prefers-color-scheme: dark)')
      this.modeQuery.addEventListener('change', () => this.applyMode())
    }
    this.applyMode()
    try {
      const css = await fetchSkin(backend, name, this.option('auth'))
      if (gen !== this.skinGen) return
      const el = this.skinEl ?? document.createElement('style')
      el.setAttribute('data-skin', name)
      el.textContent = shadowSkinCss(css, name) + SKIN_BRIDGE_CSS
      if (!this.skinEl) {
        this.skinEl = el
        this.root.append(el)
      }
    } catch (err) {
      if (gen !== this.skinGen) return
      this.fire('error', { message: errorText(err) })
    }
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  private build(): void {
    const root = this.attachShadow({ mode: 'open' })
    this.root = root
    const style = document.createElement('style')
    style.textContent = CSS
    this.feedEl = document.createElement('div')
    this.feedEl.className = 'feed nr-feed'
    this.feedEl.setAttribute('part', 'feed')
    this.statusEl = document.createElement('div')
    this.statusEl.className = 'status-line'
    const composer = document.createElement('form')
    composer.className = 'composer nr-composer'
    composer.setAttribute('part', 'composer')
    this.input = document.createElement('textarea')
    this.input.rows = 1
    this.sendBtn = document.createElement('button')
    this.sendBtn.type = 'submit'
    this.sendBtn.className = 'primary send'
    composer.append(this.input, this.sendBtn)
    root.append(style, this.feedEl, this.statusEl, composer)

    composer.addEventListener('submit', (e) => {
      e.preventDefault()
      this.submit()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        this.submit()
      }
    })
    this.input.addEventListener('input', () => this.autosize())
    this.feed.onChange = (ids) => this.paint(ids)
    this.setRunning(false)
    this.paint(null)
  }

  private submit(): void {
    if (this.running) {
      this.stop()
      return
    }
    const text = this.input.value
    if (!text.trim()) return
    this.input.value = ''
    this.autosize()
    void this.send(text).catch((err) => {
      this.feed.add('error', [{ kind: 'text', text: errorText(err) }])
      this.fire('error', { message: errorText(err) })
    })
  }

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`
  }

  private applyPlaceholder(): void {
    if (this.input) this.input.placeholder = this.option('placeholder') ?? this.t.placeholder
    if (this.sendBtn) this.sendBtn.textContent = this.running ? this.t.stop : this.t.send
  }

  private setRunning(on: boolean): void {
    this.running = on
    if (!this.sendBtn) return
    this.sendBtn.textContent = on ? this.t.stop : this.t.send
    this.sendBtn.classList.toggle('stop', on)
    this.sendBtn.setAttribute('aria-label', this.sendBtn.textContent)
  }

  private status(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text
  }

  private ctx(): RenderCtx {
    return {
      t: this.t,
      open: this.open,
      answer: (askId, value, label) => {
        const a = this.feed.findAsk(askId)
        if (!a || a.block.answered !== undefined) return
        this.feed.update(a.message.id, () => (a.block.answered = label))
        this.transport?.answer(askId, value)
      },
    }
  }

  /** Перерисовать изменённые сообщения (`null` — всё). Прокрутка — если были внизу. */
  private paint(ids: string[] | null): void {
    if (!this.feedEl) return
    const atBottom = this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < 40
    const ctx = this.ctx()
    if (ids === null) {
      this.nodes.clear()
      this.feedEl.replaceChildren()
      for (const m of this.feed.messages) {
        const n = renderMessage(m, ctx)
        this.nodes.set(m.id, n)
        this.feedEl.append(n)
      }
    } else {
      for (const id of ids) {
        const m = this.feed.get(id)
        const prev = this.nodes.get(id)
        if (!m) {
          prev?.remove()
          this.nodes.delete(id)
          continue
        }
        const n = renderMessage(m, ctx)
        this.nodes.set(id, n)
        if (prev) prev.replaceWith(n)
        else {
          const idx = this.feed.messages.indexOf(m)
          const next = this.feed.messages.slice(idx + 1).map((x) => this.nodes.get(x.id)).find((x) => x?.isConnected)
          if (next) this.feedEl.insertBefore(n, next)
          else this.feedEl.append(n)
        }
      }
    }
    this.feedEl.querySelector('.empty')?.remove()
    if (!this.feed.messages.length) {
      const e = document.createElement('div')
      e.className = 'empty'
      e.textContent = this.t.empty
      this.feedEl.append(e)
    }
    if (atBottom) this.feedEl.scrollTop = this.feedEl.scrollHeight
  }

  private fire(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }
}

/** Зарегистрировать `<nr-chat>` (идемпотентно). */
export function defineNrChat(tag = 'nr-chat'): void {
  if (typeof customElements === 'undefined') return
  if (!customElements.get(tag)) customElements.define(tag, NrChatElement)
}

/**
 * Встроить чат в элемент страницы.
 *
 * ```js
 * const chat = mount(document.getElementById('chat'), { backend: 'http://127.0.0.1:7800' })
 * chat.registerTool({ name: 'get_state', description: '…' }, () => JSON.stringify(state))
 * ```
 */
export function mount(target: Element, opts: Partial<WidgetOptions> & { backend: string }): NrChatElement {
  defineNrChat()
  const chat = document.createElement('nr-chat') as NrChatElement
  chat.configure(opts)
  target.append(chat)
  return chat
}
