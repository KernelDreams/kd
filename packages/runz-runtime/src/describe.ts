/**
 * Одна строка «что это» о скрипте runz — для `runz --runz-list --runz-describe`,
 * тула `runz_list` и скилла `runz-tools`. Источник — то, что уже
 * пишется: README appz (первый абзац, при пустом — хвост заголовка `# имя — …`),
 * `$description:` документа, док-комментарий `.ts`. Ничего отдельно не ведётся.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const MAX = 160

function clean(s: string): string {
  return s
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Первый абзац текста: пропуская заголовки, цитаты, mdz-атрибуты, код, таблицы. */
export function firstParagraph(md: string): string {
  const out: string[] = []
  let fence = false
  for (const line of md.replace(/^---[\s\S]*?\n---\n/, '').split('\n')) {
    const t = line.trim()
    if (!out.length && t.startsWith('```')) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (!out.length) {
      if (!t || /^(#|>|\$|%|<!--|!\[|```|\||-{3,}$)/.test(t)) continue
    } else if (!t || t.startsWith('#') || t.startsWith('```')) break
    out.push(t)
  }
  return clean(out.join(' '))
}

/** Первое предложение, не длиннее {@link MAX}. */
export function sentence(s: string): string {
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/)
  let r = m ? m[1] : s
  if (r.length > MAX) r = r.slice(0, MAX - 1).replace(/\s\S*$/, '') + '…'
  return r
}

function heading(md: string): string {
  const m = md.match(/^#\s+\S+\s+[—–-]\s+(.+)$/m)
  return m ? clean(m[1]) : ''
}

/** Абзац-ссылка («, спека…», «`runz x` (DEV-…»), а не описание. */
function isReference(p: string): boolean {
  return p.length < 50 || /^(DEV|NOT|LIFE)-\d+/.test(p) || /^runz [\w-]+ \(/.test(p)
}

function fromMarkdown(md: string): string {
  const p = firstParagraph(md)
  const h = heading(md)
  return sentence(h && (!p || isReference(p)) ? h : p)
}

function fromTs(file: string): string {
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (!m) return ''
  const body = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .filter((l) => !/^Built-in script:/.test(l.trim()))
    .join('\n')
  return sentence(firstParagraph(body))
}

/** Описание найденного скрипта (`file` из `findScript`); нечего сказать — `''`. */
export function describeScript(file: string): string {
  try {
    const dir = path.dirname(file)
    if (path.basename(file) === 'index.ts') {
      for (const f of ['README.md', 'readme.md']) {
        const p = path.join(dir, f)
        if (fs.existsSync(p)) {
          const d = fromMarkdown(fs.readFileSync(p, 'utf8'))
          if (d) return d
        }
      }
      return fromTs(file)
    }
    if (file.endsWith('.ts')) return fromTs(file)
    const text = fs.readFileSync(file, 'utf8')
    const own = text.match(/^\$description:\s*(.+)$/m)
    return own ? sentence(clean(own[1])) : fromMarkdown(text)
  } catch {
    return ''
  }
}
