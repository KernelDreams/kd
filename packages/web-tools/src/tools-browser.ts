/**
 * Тулы `browser_*`: агент ходит по магазину в настоящем браузере
 * профиля nr-browser (`NR_WEB_BROWSER_CDP`) — открыть, посмотреть, нажать,
 * заполнить, извлечь карточку товара.
 *
 * Вид страницы — не скриншот и не полное дерево доступности (страница поиска
 * Amazon — 380 тыс. знаков), а сжатый список: заголовки, текст, элементы
 * управления с рефами `[r12]`, с потолком знаков, поиском `find` и страницами
 * `offset`. Рефы — атрибут `data-nr-ref` на элементе: живут до перехода на
 * другую страницу.
 *
 * Стоп-краны: кнопка, похожая на оплату или окончательный заказ, без
 * `confirmed: true` не нажимается — агент сначала показывает сводку и ждёт «да»
 * человека; в поля паролей, BLIK и карт тул не пишет и их значения не
 * показывает — это делает человек в окне профиля.
 *
 * Тулы opt-in: в реестре есть, агенту видны, только если он их назвал
 * (`tools: "all, browser_*"`).
 */

import { AgentTab, browserPort, browserWindowHint, isChallenge, PAGE_TIMEOUT_MS, type TabSession } from './browser.js'
import { cardFromPage, formatCard, PRODUCT_SCRIPT, type PageProductRaw } from './product.js'
import { htmlToText, truncate } from './html.js'
import type { WebEnv } from './search/types.js'
import type { WebToolResult } from './tools.js'

export const LOOK_MAX_CHARS = 6000
export const AFTER_ACTION_CHARS = 2500

/** Надпись кнопки, после которой деньги уходят или заказ оформлен окончательно. */
export const PAY_RE =
  /kupuj[ęe] i płac|zamawiam i płac|zamów i zapłać|złóż zamówienie|zapłać|płacę|kup teraz|potwierdź (zakup|zamówienie|płatność)|place (your )?order|buy now|pay now|complete (purchase|order)|confirm (purchase|payment)|оплатить|оформить заказ|купить сейчас/i

/** Поле, куда пишет только человек: пароль, BLIK, карта, одноразовый код. */
export const SENSITIVE_FIELD = `(el) => el.type === 'password' || /one-time-code|cc-/.test(el.autocomplete || '') || /blik|cvv|cvc|card.?number|cardnumber|otp|password|hasło|haslo/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.placeholder || ''))`

/**
 * В странице: обойти видимое, раздать рефы элементам управления, вернуть строки.
 * Рефы стабильны между вызовами (атрибут остаётся на элементе).
 */
export const LOOK_SCRIPT = `(() => {
  const sensitive = ${SENSITIVE_FIELD};
  const W = window; W.__nrRef = W.__nrRef || 0;
  const cut = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],[contenteditable=true]';
  const ref = (el) => { if (!el.dataset.nrRef) el.dataset.nrRef = 'r' + (++W.__nrRef); return el.dataset.nrRef; };
  const label = (el) => {
    const byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return el.getAttribute('aria-label') || (byFor && byFor.textContent) || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.innerText || el.value || el.name || '';
  };
  const main = [], nav = [];
  const NAV = 'header,nav,footer,[role=banner],[role=navigation],[role=contentinfo],#nav-belt,#nav-main,#skiplink,#nav-skipLinks';
  let lines = main;
  const seenText = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let skipUntil = null;
  for (let n = walker.currentNode; n && main.length + nav.length < 5000; n = walker.nextNode()) {
    if (skipUntil && skipUntil.contains(n)) continue;
    skipUntil = null;
    const host = n.nodeType === 1 ? n : n.parentElement;
    lines = host && host.closest(NAV) ? nav : main;
    if (n.nodeType === 1) {
      const el = n;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'svg' || el.getAttribute('aria-hidden') === 'true' && !el.matches(INTERACTIVE)) { skipUntil = el; continue; }
      if (/^H[1-4]$/.test(tag) && visible(el)) { const s = cut(el.innerText, 160); if (s) lines.push('#'.repeat(+tag[1]) + ' ' + s); skipUntil = el; continue; }
      if (el.matches(INTERACTIVE)) {
        if (!visible(el)) { skipUntil = el; continue; }
        const r = ref(el);
        const role = el.getAttribute('role') || (tag === 'A' ? 'link' : tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textbox' : tag === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', image: 'button' }[el.type] || 'textbox') : tag === 'BUTTON' ? 'button' : tag.toLowerCase());
        const name = cut(label(el), 110);
        // Безымянные кнопки и радио (свотчи-картинки, иконки) — шум без смысла для модели.
        if (!name && role !== 'textbox' && role !== 'select' && role !== 'searchbox') { skipUntil = el; continue; }
        let s = '[' + r + '] ' + role + ' "' + name + '"';
        if (role === 'link') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript') && !h.startsWith('#')) { let u; try { u = new URL(h, location.href); } catch (e) {} if (u) { const path = u.pathname.replace(/\\/ref=.*$/, ''); s += ' ' + cut((u.origin === location.origin ? '' : u.origin) + path + (path.length <= 3 ? u.search : ''), 80); } } }
        if (role === 'textbox') s += sensitive(el) ? ' = «скрыто: вводит человек»' : el.value ? ' = "' + cut(el.value, 60) + '"' : '';
        if (role === 'select') s += ' = "' + cut((el.selectedOptions[0] || {}).text, 40) + '" (' + cut([...el.options].map((o) => o.text.trim()).join('|'), 80) + ')';
        if (role === 'checkbox' || role === 'radio') s += el.checked || el.getAttribute('aria-checked') === 'true' ? ' [x]' : ' [ ]';
        if (el.disabled) s += ' (disabled)';
        lines.push(s);
        skipUntil = el; continue;
      }
      continue;
    }
    const p = n.parentElement;
    const s = cut(n.textContent, 200);
    if (s.length < 2 || !p || !visible(p)) continue;
    const key = s + '|' + (p.dataset.nrRef || '');
    if (seenText.has(key) && s.length < 40) continue;
    seenText.add(key);
    const last = lines[lines.length - 1];
    if (last !== undefined && !last.startsWith('[') && !last.startsWith('#') && last.length + s.length < 200) lines[lines.length - 1] = last + ' ' + s;
    else lines.push(s);
  }
  // Содержимое вперёд, шапка, меню и подвал сайта — в конец.
  return { url: location.href, title: document.title, lines: nav.length ? main.concat(['--- навигация сайта ---'], nav) : main };
})()`

interface LookRaw {
  url: string
  title: string
  lines: string[]
}

export interface LookOptions {
  find?: string
  offset?: number
  maxChars?: number
}

/** Строки вида → текст модели: поиск по словам (с соседями), страница, потолок. */
export function renderLook(raw: LookRaw, o: LookOptions = {}): string {
  const head = `URL: ${raw.url}\nTitle: ${raw.title}`
  let lines = raw.lines
  if (o.find?.trim()) {
    const words = o.find
      .toLowerCase()
      .split('|')
      .map((w) => w.trim())
      .filter(Boolean)
    const keep = new Set<number>()
    lines.forEach((l, i) => {
      const low = l.toLowerCase()
      if (words.some((w) => low.includes(w))) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j)
    })
    const out: string[] = []
    let prev = -2
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i !== prev + 1 && out.length) out.push('…')
      out.push(lines[i]!)
      prev = i
    }
    if (!out.length) return `${head}\n\n(«${o.find}» на странице не найдено; ${raw.lines.length} строк всего)`
    lines = out
  }
  const max = o.maxChars ?? LOOK_MAX_CHARS
  const from = Math.max(0, o.offset ?? 0)
  const body: string[] = []
  let size = 0
  let i = from
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (size + l.length + 1 > max && body.length) break
    body.push(l)
    size += l.length + 1
  }
  const rest = lines.length - i
  const tail = rest > 0 ? `\n[ещё ${rest} строк: browser_look с offset=${i} или find="слово|другое"]` : ''
  return `${head}\n\n${body.join('\n')}${tail}`
}

interface ElementInfo {
  found: boolean
  label?: string
  tag?: string
  sensitive?: boolean
  fillable?: boolean
  x?: number
  y?: number
}

const elementInfo = (ref: string) => `(() => {
  const el = document.querySelector('[data-nr-ref="${ref.replace(/[^a-z0-9]/gi, '')}"]');
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const sensitive = ${SENSITIVE_FIELD};
  const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const fillable = el.matches('textarea,select,[contenteditable=true],input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=image])');
  return { found: true, label, tag: el.tagName, fillable, sensitive: el.matches('input,textarea') && sensitive(el), x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`

export interface BrowserToolDef {
  name: 'browser_open' | 'browser_look' | 'browser_click' | 'browser_fill' | 'browser_extract'
  description: string
  promptSnippet: string
  promptGuidelines: string[]
  parameters: Record<string, unknown>
  optIn: true
  execute(args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<WebToolResult>
}

const fail = (tool: string, code: string, message: string): WebToolResult => ({
  text: `${tool} failed [${code}]: ${message}`,
  details: { error: { code, message } },
  isError: true,
})

export interface BrowserToolsDeps {
  env: () => WebEnv
}

/** Тулы браузера. Порт читается на вызов: без `NR_WEB_BROWSER_CDP` вызов — ошибка `config`. */
export function createBrowserTools(deps: BrowserToolsDeps): BrowserToolDef[] {
  const tabs = new Map<number, AgentTab>()
  const hint = () => browserWindowHint(deps.env())

  async function look(s: TabSession, o: LookOptions): Promise<WebToolResult> {
    const raw = await s.eval<LookRaw>(LOOK_SCRIPT)
    const page = await s.page()
    const challenge = isChallenge(page.title, page.html)
    const text = renderLook(raw, o)
    return {
      text: challenge ? `${text}\n\n[анти-бот или капча: страницу должен пройти человек в окне профиля${hint()}; потом повтори browser_look]` : text,
      details: { url: raw.url, title: raw.title, lines: raw.lines.length, challenge },
    }
  }

  const guard = async <T>(name: string, fn: (s: TabSession) => Promise<T>): Promise<T | WebToolResult> => {
    const port = browserPort(deps.env())
    if (!port) return fail(name, 'config', 'браузер не настроен: $browser_cdp в блоке ## $web ~/.runz/config.md (порт CDP профиля nr-browser)')
    let tab = tabs.get(port)
    if (!tab) tabs.set(port, (tab = new AgentTab(port)))
    try {
      return await fn(await tab.get())
    } catch (e) {
      return fail(name, 'browser', `${(e as Error).message}${hint()}`)
    }
  }

  return [
    {
      name: 'browser_open',
      description:
        'Open a url in the real browser (shop profile with the human\'s logins and cookies) and return a compact view of the page: headings, text and controls with refs like [r12]. ' +
        'Use for shops and sites that block web_fetch, and for anything that needs clicking (cart, delivery, checkout). Pass find="word|other" to get only matching lines.',
      promptSnippet: 'Open a url in the real browser',
      promptGuidelines: ['Use browser_open / browser_look / browser_click / browser_fill to act on shop pages; refs [rN] come from the last view.'],
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) url' },
          find: { type: 'string', description: 'Only lines containing any of these words, separated by |' },
        },
        required: ['url'],
      },
      optIn: true,
      async execute(args, opts = {}) {
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!/^https?:\/\//i.test(url)) return fail('browser_open', 'bad_request', 'нужен абсолютный http(s) url')
        const r = await guard('browser_open', async (s) => {
          await s.navigate(url)
          await s.settle(PAGE_TIMEOUT_MS, opts.signal)
          await s.waitChallenge(opts.signal)
          return look(s, { ...(typeof args.find === 'string' ? { find: args.find } : {}) })
        })
        return r
      },
    },
    {
      name: 'browser_look',
      description:
        'Compact view of the current browser page: headings, text, controls with refs [rN], form values (passwords and payment codes hidden). ' +
        'Long pages are paged: use offset from the hint, or find="word|other" to see only matching lines with neighbours.',
      promptSnippet: 'View the current browser page',
      promptGuidelines: [],
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Only lines containing any of these words, separated by |' },
          offset: { type: 'integer', description: 'Start line, from the hint of a previous view' },
          maxChars: { type: 'integer', description: `Max characters, default ${LOOK_MAX_CHARS}` },
        },
      },
      optIn: true,
      async execute(args) {
        return guard('browser_look', (s) =>
          look(s, {
            ...(typeof args.find === 'string' ? { find: args.find } : {}),
            ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
            ...(typeof args.maxChars === 'number' ? { maxChars: Math.min(30_000, Math.max(500, args.maxChars)) } : {}),
          }),
        )
      },
    },
    {
      name: 'browser_click',
      description:
        'Click an element by ref [rN] from the last view (real mouse click), wait for the page and return a short view. ' +
        'Buttons that pay or finally place an order are refused unless confirmed=true; set it only after the human explicitly said "yes" to the order summary in chat.',
      promptSnippet: 'Click an element by ref',
      promptGuidelines: ['Never pass confirmed=true to browser_click without an explicit "yes" from the human to the order summary.'],
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the view, e.g. r12' },
          find: { type: 'string', description: 'Lines of the resulting page to show, words separated by |' },
          confirmed: { type: 'boolean', description: 'Human explicitly approved paying / placing the order' },
        },
        required: ['ref'],
      },
      optIn: true,
      async execute(args, opts = {}) {
        const ref = typeof args.ref === 'string' ? args.ref.replace(/^\[|\]$/g, '').trim() : ''
        if (!ref) return fail('browser_click', 'bad_request', 'нужен ref из browser_look')
        return guard('browser_click', async (s) => {
          const el = await s.eval<ElementInfo>(elementInfo(ref))
          if (!el.found) return fail('browser_click', 'not_found', `нет элемента ${ref} — страница сменилась, сначала browser_look`)
          if (PAY_RE.test(el.label ?? '') && args.confirmed !== true) {
            return fail(
              'browser_click',
              'needs_confirmation',
              `«${el.label}» — оплата или окончательный заказ. Покажи человеку сводку (товар, продавец, количество, полная цена с доставкой, адрес) и жди явного «да»; потом повтори с confirmed=true. BLIK и пароли человек вводит сам в окне профиля${hint()}.`,
            )
          }
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
            await s.client.send('Input.dispatchMouseEvent', { type, x: el.x, y: el.y, button: 'left', clickCount: 1 })
          }
          await s.settle(10_000, opts.signal)
          const r = await look(s, { maxChars: AFTER_ACTION_CHARS, ...(typeof args.find === 'string' ? { find: args.find } : {}) })
          return { ...r, text: `clicked ${ref} «${el.label}»\n${r.text}` }
        })
      },
    },
    {
      name: 'browser_fill',
      description:
        'Type a value into a text field or choose an option of a select by ref [rN] (clears the field first). submit=true presses Enter after typing. ' +
        'Refuses password, BLIK, card and one-time-code fields: the human types those in the browser window.',
      promptSnippet: 'Fill a field by ref',
      promptGuidelines: [],
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Field ref from the view, e.g. r14' },
          value: { type: 'string', description: 'Text to type, or option text for a select' },
          submit: { type: 'boolean', description: 'Press Enter after typing' },
        },
        required: ['ref', 'value'],
      },
      optIn: true,
      async execute(args, opts = {}) {
        const ref = typeof args.ref === 'string' ? args.ref.replace(/^\[|\]$/g, '').trim() : ''
        const value = typeof args.value === 'string' ? args.value : String(args.value ?? '')
        if (!ref) return fail('browser_fill', 'bad_request', 'нужен ref из browser_look')
        return guard('browser_fill', async (s) => {
          const el = await s.eval<ElementInfo>(elementInfo(ref))
          if (!el.found) return fail('browser_fill', 'not_found', `нет элемента ${ref} — сначала browser_look`)
          if (!el.fillable) return fail('browser_fill', 'not_a_field', `${ref} «${el.label}» — не поле ввода и не список (рефы — с текущей страницы, сначала browser_look)`)
          if (el.sensitive) return fail('browser_fill', 'human_only', `поле «${el.label}» — пароль, BLIK или карта: вводит человек в окне профиля${hint()}`)
          const id = JSON.stringify(ref)
          if (el.tag === 'SELECT') {
            const picked = await s.eval<string | null>(`(() => {
              const el = document.querySelector('[data-nr-ref=' + ${JSON.stringify(id)} + ']');
              const v = ${JSON.stringify(value.trim().toLowerCase())};
              const o = [...el.options].find((o) => o.text.trim().toLowerCase() === v || o.value.toLowerCase() === v) || [...el.options].find((o) => o.text.toLowerCase().includes(v));
              if (!o) return null;
              el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
              return o.text.trim();
            })()`)
            if (picked === null) return fail('browser_fill', 'not_found', `в списке ${ref} нет варианта «${value}»`)
          } else {
            await s.eval(`(() => {
              const el = document.querySelector('[data-nr-ref=' + ${JSON.stringify(id)} + ']');
              el.focus();
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const set = Object.getOwnPropertyDescriptor(proto, 'value');
              if (set && set.set && 'value' in el) { set.set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
            })()`)
            await s.client.send('Input.insertText', { text: value })
            if (args.submit === true) {
              for (const type of ['keyDown', 'keyUp'] as const) {
                await s.client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
              }
              await s.settle(10_000, opts.signal)
            }
          }
          const r = await look(s, { maxChars: AFTER_ACTION_CHARS })
          return { ...r, text: `filled ${ref} «${el.label}»\n${r.text}` }
        })
      },
    },
    {
      name: 'browser_extract',
      description:
        'Extract from the current browser page: what="product" — product card as structure (name, brand, model, EAN/ASIN/SKU, price, currency, delivery, seller, availability, url, checkedAt); ' +
        'what="text" — readable text of the page. Use the product card to compare offers and to check that spare heads match the exact model.',
      promptSnippet: 'Extract product card or page text from the browser',
      promptGuidelines: [],
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['product', 'text'], description: 'product (default) or text' },
          maxChars: { type: 'integer', description: 'For text: max characters, default 10000' },
        },
      },
      optIn: true,
      async execute(args) {
        return guard('browser_extract', async (s) => {
          if (args.what === 'text') {
            const p = await s.page()
            const page = htmlToText(p.html)
            const cut = truncate(page.text, typeof args.maxChars === 'number' ? Math.min(50_000, Math.max(500, args.maxChars)) : 10_000)
            return { text: `URL: ${p.url}\nTitle: ${p.title}\n\n${cut.text}${cut.truncated ? '\n\n[truncated]' : ''}`, details: { url: p.url, title: p.title, truncated: cut.truncated } }
          }
          const raw = await s.eval<PageProductRaw>(PRODUCT_SCRIPT)
          const card = cardFromPage(raw)
          if (!card) return fail('browser_extract', 'not_found', `на ${raw.url} нет карточки товара (ни JSON-LD Product, ни страницы Amazon) — browser_look с find="cena|zł|EAN"`)
          return { text: formatCard(card), details: { product: card } }
        })
      },
    },
  ]
}
