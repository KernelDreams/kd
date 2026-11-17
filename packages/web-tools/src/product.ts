/**
 * Карточка товара структурой: модель, EAN/SKU/ASIN, цена, доставка,
 * продавец, наличие, время проверки — чтобы агент сравнивал предложения полями,
 * а не пересказом, и не путал совместимые насадки.
 *
 * Источники по убыванию надёжности: JSON-LD `Product` (schema.org — Allegro,
 * большинство магазинов), DOM Amazon (JSON-LD у него нет), `og:`-мета. В html
 * со стороны сервера — `productFromHtml`; в живой странице браузера —
 * `PRODUCT_SCRIPT` (тот же разбор плюс то, что дорисовал JS).
 */

export interface ProductCard {
  name?: string
  brand?: string
  model?: string
  ean?: string
  sku?: string
  asin?: string
  mpn?: string
  price?: number
  currency?: string
  availability?: string
  seller?: string
  delivery?: string
  url: string
  /** ISO-время проверки: цена и наличие верны на этот момент. */
  checkedAt: string
  source: 'json-ld' | 'amazon' | 'meta'
}

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && 'name' in v) return str((v as Json).name)
  return undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s| /g, '').replace(/[^\d.,-]/g, '')
  if (!s) return undefined
  // «1.299,99» и «1,299.99» — десятичный разделитель последний.
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  const norm = last >= 0 && s.length - last - 1 <= 2 ? s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1) : s.replace(/[.,]/g, '')
  const n = Number(norm)
  return Number.isFinite(n) ? n : undefined
}

function isProduct(node: Json): boolean {
  const t = node['@type']
  return t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'ProductGroup'
}

function walk(v: unknown, out: Json[]): void {
  if (Array.isArray(v)) for (const x of v) walk(x, out)
  else if (v && typeof v === 'object') {
    const o = v as Json
    if (isProduct(o)) out.push(o)
    if (o['@graph']) walk(o['@graph'], out)
  }
}

/** JSON-LD блоки страницы → узлы Product. */
export function jsonLdProducts(html: string): Json[] {
  const out: Json[] = []
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]!.trim()), out)
    } catch {
      /* битый блок — пропускаем */
    }
  }
  return out
}

/** Узел schema.org Product → карточка. Предложение — первое (или самое дешёвое из AggregateOffer). */
export function cardFromJsonLd(p: Json, url: string, now: Date): ProductCard {
  const offersRaw = p.offers ?? (p.hasVariant as Json[] | undefined)?.[0]?.offers
  const offers = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) as Json | undefined
  const card: ProductCard = { url, checkedAt: now.toISOString(), source: 'json-ld' }
  const set = <K extends keyof ProductCard>(k: K, v: ProductCard[K] | undefined) => {
    if (v !== undefined && v !== '') card[k] = v
  }
  set('name', str(p.name))
  set('brand', str(p.brand))
  set('model', str(p.model))
  set('ean', str(p.gtin13) ?? str(p.gtin) ?? str(p.gtin14) ?? str(p.gtin12) ?? str(p.gtin8))
  set('sku', str(p.sku))
  set('mpn', str(p.mpn))
  if (offers) {
    set('price', num(offers.price) ?? num(offers.lowPrice))
    set('currency', str(offers.priceCurrency))
    set('availability', str(offers.availability)?.replace(/^https?:\/\/schema\.org\//, ''))
    set('seller', str(offers.seller))
    const ship = offers.shippingDetails as Json | Json[] | undefined
    const rate = (Array.isArray(ship) ? ship[0] : ship)?.shippingRate as Json | undefined
    if (rate) set('delivery', `${str(rate.value) ?? '?'} ${str(rate.currency) ?? ''}`.trim())
    set('url', str(offers.url) ?? url)
  }
  return card
}

function meta(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')
  return re.exec(html)?.[1]?.trim() || undefined
}

/** Карточка из html (без JS): JSON-LD, иначе og/product-мета; ничего нет — `undefined`. */
export function productFromHtml(html: string, url: string, now = new Date()): ProductCard | undefined {
  const p = jsonLdProducts(html)[0]
  if (p) return cardFromJsonLd(p, url, now)
  const price = num(meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount'))
  if (price === undefined) return undefined
  const card: ProductCard = { url, price, checkedAt: now.toISOString(), source: 'meta' }
  const name = meta(html, 'og:title')
  if (name) card.name = name
  const cur = meta(html, 'product:price:currency') ?? meta(html, 'og:price:currency')
  if (cur) card.currency = cur
  return card
}

/** Карточка одной строкой для модели: поля, которых нет, не печатаются. */
export function formatCard(c: ProductCard): string {
  const ids = [c.ean && `EAN ${c.ean}`, c.asin && `ASIN ${c.asin}`, c.sku && `SKU ${c.sku}`, c.model && `модель ${c.model}`, c.mpn && `MPN ${c.mpn}`].filter(Boolean)
  return [
    `Product: ${c.name ?? '?'}${c.brand ? ` (${c.brand})` : ''}`,
    ids.length ? `  ${ids.join(' · ')}` : '',
    `  цена: ${c.price !== undefined ? `${c.price} ${c.currency ?? ''}`.trim() : '?'} · доставка: ${c.delivery ?? '?'} · продавец: ${c.seller ?? '?'} · наличие: ${c.availability ?? '?'}`,
    `  ${c.url} · проверено ${c.checkedAt}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Разбор в живой странице: JSON-LD, затем DOM Amazon (ASIN, цена, продавец,
 * доставка, EAN и модель из таблицы деталей). Возвращает сырой объект —
 * `cardFromPage` дочищает его на стороне Node.
 */
export const PRODUCT_SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  const t = (s) => { const e = q(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : undefined; };
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
  const amazon = /(^|\\.)amazon\\./.test(location.hostname) ? (() => {
    const details = {};
    for (const row of document.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, .prodDetTable tr')) {
      const k = (row.querySelector('th, .a-text-bold') || {}).textContent;
      const v = (row.querySelector('td, span:not(.a-text-bold)') || {}).textContent;
      if (k && v) details[k.replace(/[\\s\\u200e\\u200f:]+/g, ' ').trim().toLowerCase()] = v.replace(/[\\s\\u200e\\u200f]+/g, ' ').trim();
    }
    const pick = (...keys) => { for (const k of Object.keys(details)) if (keys.some((x) => k.includes(x))) return details[k]; };
    return {
      name: t('#productTitle'),
      brand: t('#bylineInfo'),
      asin: (q('input[name="ASIN"]') || {}).value || (location.pathname.match(/\\/dp\\/([A-Z0-9]{10})/) || [])[1],
      price: t('#corePrice_feature_div .a-offscreen') || t('#corePriceDisplay_desktop_feature_div .a-offscreen') || t('.a-price .a-offscreen'),
      currency: (q('#corePrice_feature_div .a-price-symbol') || {}).textContent,
      availability: t('#availability'),
      seller: t('#merchantInfoFeature_feature_div .offer-display-feature-text') || t('#sellerProfileTriggerId') || t('#merchant-info'),
      delivery: t('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE') || t('#deliveryBlockMessage'),
      ean: pick('ean', 'gtin'),
      model: pick('numer modelu', 'model number', 'numer części', 'model'),
    };
  })() : undefined;
  return { url: location.href, ld, amazon };
})()`

export interface PageProductRaw {
  url: string
  ld: string[]
  amazon?: Record<string, string | undefined>
}

/** Сырой разбор страницы → карточка: JSON-LD, поверх — поля Amazon. */
export function cardFromPage(raw: PageProductRaw, now = new Date()): ProductCard | undefined {
  const nodes: Json[] = []
  for (const s of raw.ld) {
    try {
      walk(JSON.parse(s), nodes)
    } catch {
      /* битый блок */
    }
  }
  let card: ProductCard | undefined = nodes[0] ? cardFromJsonLd(nodes[0], raw.url, now) : undefined
  const a = raw.amazon
  if (a && (a.name || a.asin)) {
    const base: ProductCard = card ?? { url: raw.url, checkedAt: now.toISOString(), source: 'amazon' }
    const price = num(a.price)
    const cur = a.price?.includes('zł') ? 'PLN' : a.currency?.trim() || undefined
    card = {
      ...base,
      source: card ? card.source : 'amazon',
      ...(a.name ? { name: a.name } : {}),
      ...(a.brand ? { brand: a.brand.replace(/^(Marka:|Odwiedź sklep|Visit the)\s*/i, '').replace(/\s*(Store|sklep)$/i, '') } : {}),
      ...(a.asin ? { asin: a.asin } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(cur ? { currency: cur } : {}),
      ...(a.availability ? { availability: a.availability } : {}),
      ...(a.seller ? { seller: sellerName(a.seller) } : {}),
      ...(a.delivery ? { delivery: a.delivery } : {}),
      ...(a.ean ? { ean: a.ean } : {}),
      ...(a.model ? { model: a.model } : {}),
    }
  }
  return card
}

/** «X X Sprzedawane przez X» → «X»; иначе — без повтора половин. */
export function sellerName(raw: string): string {
  const by = /(?:Sprzedawane przez|Sold by|Sprzedawca:?)\s+(.+)$/i.exec(raw)
  let s = (by ? by[1]! : raw).trim()
  {
    const words = s.split(' ')
    if (words.length % 2 === 0) {
      const a = words.slice(0, words.length / 2).join(' ')
      if (a === words.slice(words.length / 2).join(' ')) s = a
    }
  }
  return s
}
