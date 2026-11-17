/**
 * Markdown-минимум ленты: абзацы, переносы, блоки кода ```, `код`, списки
 * (`-`/`*`/`1.`), заголовки `#`, **жирный**, *курсив*, ссылки `[т](url)` и
 * голые URL. Без подсветки и HTML: текст экранируется до разметки, ссылки —
 * только http(s)/mailto, в новой вкладке.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function safeUrl(url: string): string | undefined {
  const u = url.trim()
  return /^(https?:|mailto:)/i.test(u) ? u : undefined
}

/** Строка (уже экранированная) → инлайн-разметка. */
function inline(text: string): string {
  const codes: string[] = []
  let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'))
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m
  })
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!)
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined
  const flushPara = (): void => {
    if (para.length) out.push(`<p>${para.map((l) => inline(esc(l))).join('<br>')}</p>`)
    para = []
  }
  const flushList = (): void => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(esc(i))}</li>`).join('')}</${list.tag}>`)
    list = undefined
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      flushList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      out.push(`<pre><code${fence[1] ? ` data-lang="${esc(fence[1])}"` : ''}>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(6, heading[1]!.length + 2)
      out.push(`<h${level}>${inline(esc(heading[2]!))}</h${level}>`)
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((ul ?? ol)![1]!)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return out.join('')
}
