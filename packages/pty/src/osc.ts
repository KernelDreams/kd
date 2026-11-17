/**
 * Разбор потока `pipe-pane` (спека nr-pty §3): метки OSC 133 (`A` начало промпта, `B` конец промпта,
 * `C` команда пошла, `D;<код>` конец) и текст между ними; «сварка» текста — без escape-последовательностей,
 * с `\r`, `\b` и `CSI K` так, как их видел бы человек на экране (построчно, без курсора по экрану).
 */

export type MarkKind = 'A' | 'B' | 'C' | 'D'

export type StreamEvent = { type: 'text'; data: string } | { type: 'mark'; kind: MarkKind; code?: number }

const ESC = '\x1b'
const BEL = '\x07'
/** Незакрытый OSC длиннее — мусор, а не метка: сбрасываем как текст. */
const MAX_OSC = 4096

/**
 * Потоковый разборщик: метка может разрезаться между кусками — хвост держим до следующего `feed`.
 * Чужие OSC (заголовок окна, OSC 7) уходят в текст как есть — их срежет `cook`.
 */
export class Osc133Parser {
  private pending = ''

  feed(chunk: string): StreamEvent[] {
    const s = this.pending + chunk
    this.pending = ''
    const out: StreamEvent[] = []
    let textFrom = 0
    let i = 0
    while (i < s.length) {
      const at = s.indexOf(`${ESC}]133;`, i)
      if (at < 0) {
        // Хвост может быть началом метки: ESC, `ESC]`, `ESC]13`…
        const tail = partialPrefix(s, `${ESC}]133;`)
        if (tail > 0) {
          this.pending = s.slice(s.length - tail)
          pushText(out, s.slice(textFrom, s.length - tail))
        } else pushText(out, s.slice(textFrom))
        return out
      }
      const body = at + 6
      let end = -1
      let termLen = 0
      for (let j = body; j < s.length; j++) {
        if (s[j] === BEL) {
          end = j
          termLen = 1
          break
        }
        if (s[j] === ESC) {
          if (j + 1 >= s.length) break
          if (s[j + 1] === '\\') {
            end = j
            termLen = 2
          }
          break
        }
      }
      if (end < 0) {
        if (s.length - at > MAX_OSC) {
          i = at + 1
          continue
        }
        pushText(out, s.slice(textFrom, at))
        this.pending = s.slice(at)
        return out
      }
      pushText(out, s.slice(textFrom, at))
      const mark = parseMark(s.slice(body, end))
      if (mark) out.push(mark)
      i = textFrom = end + termLen
    }
    pushText(out, s.slice(textFrom))
    return out
  }
}

function pushText(out: StreamEvent[], data: string): void {
  if (!data) return
  const last = out[out.length - 1]
  if (last?.type === 'text') last.data += data
  else out.push({ type: 'text', data })
}

function parseMark(body: string): StreamEvent | null {
  const [kind, ...rest] = body.split(';')
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null
  if (kind !== 'D') return { type: 'mark', kind }
  const n = Number.parseInt(rest[0] ?? '', 10)
  return Number.isFinite(n) ? { type: 'mark', kind, code: n } : { type: 'mark', kind }
}

/** Сколько символов в конце `s` — начало `prefix` (но не весь он). */
function partialPrefix(s: string, prefix: string): number {
  for (let n = Math.min(prefix.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(prefix.slice(0, n))) return n
  }
  return 0
}

/**
 * Текст терминала → строки, как на экране: escape-последовательности срезаны, `\r` возвращает
 * в начало строки (следующие символы её перезаписывают), `\b` — шаг назад, `CSI K` стирает хвост.
 * Хвостовые пробелы строк и пустые строки в конце убраны.
 */
export function cook(text: string): string {
  const lines: string[] = []
  let line: string[] = []
  let col = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch === ESC) {
      const next = text[i + 1]
      if (next === '[') {
        // CSI: параметры 0x30–0x3F, промежуточные 0x20–0x2F, финальный 0x40–0x7E.
        let j = i + 2
        while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++
        const final = text[j]
        if (final === 'K') {
          const mode = text.slice(i + 2, j)
          if (mode === '' || mode === '0') line.length = Math.min(line.length, col)
          else if (mode === '2') line = []
        } else if (final === 'C') {
          col += Number.parseInt(text.slice(i + 2, j), 10) || 1
        } else if (final === 'D') {
          col = Math.max(0, col - (Number.parseInt(text.slice(i + 2, j), 10) || 1))
        } else if (final === 'G') {
          col = Math.max(0, (Number.parseInt(text.slice(i + 2, j), 10) || 1) - 1)
        }
        i = j + 1
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC / DCS / APC / PM / SOS — до BEL или ST.
        let j = i + 2
        while (j < n && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === '\\')) j++
        i = j < n && text[j] === BEL ? j + 1 : j + 2
        continue
      }
      // Двухсимвольные (ESC =, ESC >, ESC ( B — с аргументом).
      i += next === '(' || next === ')' || next === '#' ? 3 : 2
      continue
    }
    if (ch === '\n') {
      lines.push(line.join('').trimEnd())
      line = []
      col = 0
    } else if (ch === '\r') {
      col = 0
    } else if (ch === '\b') {
      col = Math.max(0, col - 1)
    } else if (ch === '\t') {
      const to = (Math.floor(col / 8) + 1) * 8
      while (col < to) {
        if (line[col] === undefined) line[col] = ' '
        col++
      }
    } else if (ch.charCodeAt(0) >= 0x20 && ch !== '\x7f') {
      while (line.length < col) line.push(' ')
      line[col++] = ch
    }
    i++
  }
  lines.push(line.join('').trimEnd())
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** Последние `maxLines` строк и не больше `maxChars` символов с конца; `cut` — сколько срезано. */
export function tail(text: string, maxLines: number, maxChars: number): { text: string; cut: boolean } {
  let out = text
  let cut = false
  const lines = out.split('\n')
  if (lines.length > maxLines) {
    out = lines.slice(-maxLines).join('\n')
    cut = true
  }
  if (out.length > maxChars) {
    out = out.slice(-maxChars)
    cut = true
  }
  return { text: out, cut }
}
