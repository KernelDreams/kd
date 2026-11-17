/**
 * HTML → текст для модели (спека §1). Не readability и не DOM — регулярки по
 * разметке, этого хватает, чтобы модель прочла страницу, а не её обвязку.
 *
 * Порядок: комментарии и не-контент (`script/style/nav/footer/aside` и
 * родня) вырезаются целиком → если есть `<article>`/`<main>`, берётся он →
 * `<pre>` откладывается нетронутым → блочные теги становятся переносами,
 * строчные исчезают, прочие — пробелом → сущности декодируются → пробелы
 * схлопываются построчно, пустые строки — до одной.
 *
 * `<noscript>` не вырезается: у SPA-заглушки это единственный текст, и модели
 * полезнее увидеть «включите JavaScript», чем пустоту.
 */

/** Не-контент, вырезаемый вместе с содержимым. */
const DROP_TAGS = ['script', 'style', 'nav', 'footer', 'aside', 'template', 'svg', 'iframe', 'object', 'canvas', 'form']

/** Абзацные теги: граница → пустая строка. Заголовки (`h1`–`h6`) — отдельно, с `#`. */
const PARA_TAGS = new Set([
  'address', 'article', 'blockquote', 'details', 'dl', 'fieldset', 'figure', 'header', 'hr', 'main',
  'ol', 'p', 'section', 'table', 'ul',
])

/** Строчно-блочные теги: граница → перенос строки без пустой. `li` — отдельно, с `- `. */
const LINE_TAGS = new Set([
  'body', 'br', 'caption', 'dd', 'div', 'dt', 'figcaption', 'html', 'summary', 'tbody', 'tfoot', 'thead', 'tr',
])

/**
 * Метка границы абзаца. Исходные переносы HTML — просто пробелы, поэтому
 * разметка несёт два вида разрывов: перенос (`\n`) и абзац (эта метка). Серия
 * разрывов подряд схлопывается в один — в абзац, если в ней была хоть одна
 * метка абзаца; иначе `</div><div>` давал бы пустые строки на ровном месте.
 */
const PARA = '\u0002'

/** Строчные теги: исчезают без пробела, иначе `<b>Type</b>Script` рвётся надвое. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins',
])

/**
 * Метка отложенного `<pre>`: символы private-use области — в тексте страниц их
 * не бывает, а схлопывание пробелов и trim их не трогают.
 */
const PRE_OPEN = '\uE000'
const PRE_CLOSE = '\uE001'
const PRE_MARK = /\uE000(\d+)\uE001/g

const NBSP = '\u00a0'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: NBSP, mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', rarr: '→',
  larr: '←', shy: '',
}

/** `&amp;`, `&#39;`, `&#x27;` → символы. Незнакомая именованная сущность остаётся как есть. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Фрагмент разметки → одна строка текста (сниппеты поисковиков, заголовки). */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

/** Вырезать `<tag …>…</tag>` целиком (вложенности одноимённых у DROP_TAGS не бывает). */
function dropElements(html: string, tags: readonly string[]): string {
  let out = html
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ')
    // Незакрытый хвост (`<script>` без `</script>` до конца документа).
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ')
  }
  return out
}

/** Внутренность `<tag>…</tag>` от первого открытия до последнего закрытия. */
function innerOf(html: string, tag: string): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}\\s*>`, 'i').exec(html)?.[1]
}

export interface HtmlText {
  title?: string
  text: string
}

export function htmlToText(html: string): HtmlText {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  const title = titleMatch ? inlineText(titleMatch[1]!) : ''

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(/<![^>]*>/g, ' ') // <!doctype>, CDATA-обрывки
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, ' ')
  // <title> бывает и вне <head> (фрагменты, кривые страницы) — он уже в title.
  body = body.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ')
  body = dropElements(body, DROP_TAGS)

  // Основной контент, если страница его размечает. `article` точнее `main`:
  // в `main` у доков часто живёт ещё и оглавление.
  body = innerOf(body, 'article') ?? innerOf(body, 'main') ?? body

  // <pre> — код и таблицы пробелами: его пробелы и переносы — смысл.
  const preserved: string[] = []
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    preserved.push(decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/^\n+|\s+$/g, ''))
    return `${PARA}${PRE_OPEN}${preserved.length - 1}${PRE_CLOSE}${PARA}`
  })

  // Вне <pre> пробелы HTML схлопываемы: перенос в исходнике — не перенос в тексте.
  body = body.replace(/\s+/g, ' ')

  body = body.replace(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi, (_whole, closing: string, rawTag: string) => {
    const tag = rawTag.toLowerCase()
    if (/^h[1-6]$/.test(tag)) return closing ? PARA : `${PARA}${'#'.repeat(Number(tag[1]))} `
    if (tag === 'li') return closing ? '\n' : '\n- '
    if (PARA_TAGS.has(tag)) return PARA
    if (LINE_TAGS.has(tag)) return '\n'
    if (INLINE_TAGS.has(tag)) return ''
    return ' '
  })
  // Обрывок тега в самом конце (битый документ) — не текст.
  body = body.replace(/<[a-z/!][^>]*$/i, '')
  body = decodeEntities(body)
  body = body.replace(/[ \t\u00a0]*[\n\u0002][\s\u0002]*/g, (run) => (run.includes(PARA) ? '\n\n' : '\n'))

  const lines = body
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim())
    // Заголовок/пункт без текста (`#` от пустого h2) — мусор.
    .filter((line) => !/^(#{1,6}|-)$/.test(line))
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(PRE_MARK, (_whole, i: string) => preserved[Number(i)] ?? '')

  return title ? { title, text } : { text }
}

/**
 * Обрезка по `maxChars` (спека §1). Суррогатная пара не рвётся: иначе на конце
 * текста оказался бы битый символ.
 */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  let cut = maxChars
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return { text: text.slice(0, cut), truncated: true }
}
