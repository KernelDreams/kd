import { describe, expect, it } from 'vitest'
import { type MdzLine, type MdzToken, scanInline, tokenizeMdz } from '../src/mdz/tokenizer'

/** Tokens of a single-line document as [type, text] pairs. */
function tok(line: string, sigil: '$' | '@' = '$'): Array<[string, string]> {
  const result = tokenizeMdz(line, sigil)
  return result.lines[0]!.tokens.map((t: MdzToken) => [t.type, line.slice(t.from, t.to)])
}

function kinds(text: string, sigil: '$' | '@' = '$'): string[] {
  return tokenizeMdz(text, sigil).lines.map((l: MdzLine) => l.kind)
}

describe('block headings', () => {
  it('name, id and level', () => {
    expect(tok('## $step load')).toEqual([
      ['heading-mark', '##'],
      ['block-sigil', '$'],
      ['block-name', 'step'],
      ['block-id', 'load'],
    ])
    const r = tokenizeMdz('### $child', '$')
    expect(r.lines[0]).toMatchObject({ kind: 'block-heading', level: 3 })
    expect(tokenizeMdz('###### $deep x', '$').lines[0]!.level).toBe(6)
  })

  it('dot in name is literal', () => {
    expect(tok('## $site.ru')).toEqual([
      ['heading-mark', '##'],
      ['block-sigil', '$'],
      ['block-name', 'site.ru'],
    ])
  })

  it('closing lines', () => {
    expect(tok('## $@')).toEqual([
      ['heading-mark', '##'],
      ['block-close', '$@'],
    ])
    expect(tok('## $')).toEqual([
      ['heading-mark', '##'],
      ['block-close', '$'],
    ])
    expect(tokenizeMdz('### $@', '$').lines[0]).toMatchObject({ kind: 'block-close', level: 3 })
  })

  it('invalid and plain headings are not blocks', () => {
    expect(kinds('## $$')).toEqual(['text'])
    expect(kinds('## $1abc')).toEqual(['text'])
    expect(kinds('## Plain heading')).toEqual(['text'])
    expect(kinds('####### $seven')).toEqual(['text'])
    expect(kinds('##$nospace')).toEqual(['text'])
  })

  it('mdd sigil', () => {
    expect(tok('## @patron mira', '@')).toEqual([
      ['heading-mark', '##'],
      ['block-sigil', '@'],
      ['block-name', 'patron'],
      ['block-id', 'mira'],
    ])
    expect(tok('## @@', '@')).toEqual([
      ['heading-mark', '##'],
      ['block-close', '@@'],
    ])
  })
})

describe('attributes', () => {
  it('key, colon, value', () => {
    expect(tok('$title: Bot Fix')).toEqual([
      ['attr-sigil', '$'],
      ['attr-key', 'title'],
      ['attr-colon', ':'],
      ['value', 'Bot Fix'],
    ])
  })

  it('dotted key is one key', () => {
    expect(tok('$a.b: 1').slice(0, 2)).toEqual([
      ['attr-sigil', '$'],
      ['attr-key', 'a.b'],
    ])
  })

  it('nr-* keys are directives', () => {
    expect(tok('$nr-type: file')[1]).toEqual(['directive-key', 'nr-type'])
    expect(tok('$nrtype: file')[1]).toEqual(['attr-key', 'nrtype'])
  })

  it('value subtypes', () => {
    const value = (line: string) => tok(line)[3]
    expect(value('$flag: true')).toEqual(['value-bool', 'true'])
    expect(value('$flag: false')).toEqual(['value-bool', 'false'])
    expect(value('$v: null')).toEqual(['value-null', 'null'])
    expect(value('$n: 42')).toEqual(['value-number', '42'])
    expect(value('$n: -7')).toEqual(['value-number', '-7'])
    expect(value('$n: 3.14')).toEqual(['value-number', '3.14'])
    expect(value('$n: 0')).toEqual(['value-number', '0'])
    expect(value('$n: +42')).toEqual(['value', '+42'])
    expect(value('$n: 007')).toEqual(['value', '007'])
    expect(value('$s: "quoted"')).toEqual(['value-quoted', '"quoted"'])
    expect(value("$s: 'single'")).toEqual(['value-quoted', "'single'"])
    expect(value('$list: $[a, b, c]')).toEqual(['value-list', '$[a, b, c]'])
    expect(value('$list: $[]')).toEqual(['value-list', '$[]'])
    expect(value("$cfg: {model: 'gpt', n: 2}")).toEqual(['value-object', "{model: 'gpt', n: 2}"])
    expect(value('$s: True')).toEqual(['value', 'True'])
  })

  it('escaped object is a string', () => {
    expect(tok('$lit: \\{not json}').slice(3)).toEqual([
      ['value', '\\{not json}'],
      ['escape', '\\{'],
    ])
  })

  it('include as value', () => {
    const t = tokenizeMdz('$src: $[[cards/base.mdz#Persona]]', '$').lines[0]!.tokens
    const include = t.find((x) => x.type === 'include')
    expect(include).toMatchObject({ target: 'cards/base.mdz#Persona' })
    expect(t.some((x) => x.type === 'value-list')).toBe(false)
  })

  it('placeholders inside values', () => {
    expect(tok('$dst: out/${self.name}.md').slice(3)).toEqual([
      ['value', 'out/${self.name}.md'],
      ['placeholder', '${self.name}'],
    ])
  })

  it('empty value, no space after colon, leading space rejects', () => {
    expect(tok('$k:')).toEqual([
      ['attr-sigil', '$'],
      ['attr-key', 'k'],
      ['attr-colon', ':'],
    ])
    expect(tok('$k:v')[3]).toEqual(['value', 'v'])
    expect(kinds(' $k: v')).toEqual(['text'])
    expect(kinds('$1k: v')).toEqual(['text'])
    expect(kinds('$k v')).toEqual(['text'])
  })
})

describe('includes', () => {
  it('path, section, section only', () => {
    const targets = (line: string) =>
      scanInline(line, '$')
        .filter((t) => t.type === 'include')
        .map((t) => t.target)
    expect(targets('see $[[path]] here')).toEqual(['path'])
    expect(targets('$[[path#Section]]')).toEqual(['path#Section'])
    expect(targets('$[[#Section]]')).toEqual(['#Section'])
    expect(targets('[[wiki]] is not an include')).toEqual([])
    expect(targets('\\$[[escaped]]')).toEqual([])
    expect(targets('$[[]]')).toEqual([])
  })
})

describe('placeholders', () => {
  const ph = (line: string, sigil: '$' | '@' = '$') =>
    scanInline(line, sigil)
      .filter((t) => t.type === 'placeholder')
      .map((t) => line.slice(t.from, t.to))

  it('anywhere in the line', () => {
    expect(ph('Hello ${user.name}, it is ${time}!')).toEqual(['${user.name}', '${time}'])
    expect(ph('${a.b.0}')).toEqual(['${a.b.0}'])
    expect(ph('${fn(a, b)}')).toEqual(['${fn(a, b)}'])
  })

  it('nesting', () => {
    expect(ph('x ${a.${b}} y')).toEqual(['${a.${b}}'])
    expect(ph('${a.${b.${c}}}')).toEqual(['${a.${b.${c}}}'])
  })

  it('escaped and unterminated', () => {
    expect(ph('\\${x}')).toEqual([])
    expect(ph('\\\\${x}')).toEqual(['${x}'])
    expect(ph('${unterminated')).toEqual([])
  })

  it('works in plain text lines and headings of markdown', () => {
    const r = tokenizeMdz('# Title ${x}\nbody ${y}', '$')
    expect(r.lines.map((l) => l.tokens.map((t) => t.type))).toEqual([['placeholder'], ['placeholder']])
  })

  it('macros are not placeholders', () => {
    const tokens = scanInline('Hi {{user}} and ${x}', '$')
    expect(tokens.map((t) => t.type)).toEqual(['macro', 'placeholder'])
  })

  it('mdd placeholders use @', () => {
    expect(ph('owes @{patrons.borin.name}', '@')).toEqual(['@{patrons.borin.name}'])
    expect(ph('${x}', '@')).toEqual([])
  })
})

describe('escapes', () => {
  it('do not trigger markup', () => {
    const types = (line: string) => tokenizeMdz(line, '$').lines[0]!.tokens.map((t) => t.type)
    expect(kinds('\\$key: v')).toEqual(['text'])
    expect(types('\\$key: v')).toEqual(['escape'])
    expect(types('\\@ \\[ \\{ \\, \\\\ \\.')).toEqual(['escape', 'escape', 'escape', 'escape', 'escape', 'escape'])
    expect(types('\\x is no escape')).toEqual([])
    expect(kinds('\\## $name')).toEqual(['text'])
  })
})

describe('roles', () => {
  it('%role at line start', () => {
    expect(tok('%user')).toEqual([['role', '%user']])
    expect(tok('%assistant')).toEqual([['role', '%assistant']])
    expect(tok('%system')).toEqual([['role', '%system']])
    expect(kinds('%user')).toEqual(['role'])
  })
  it('not a role', () => {
    expect(kinds(' %user')).toEqual(['text'])
    expect(kinds('50% off')).toEqual(['text'])
    expect(kinds('%1user')).toEqual(['text'])
  })
})

describe('typed fences', () => {
  const doc = ['````%thinking', '$not: attr', '## $not block', '${not.placeholder}', '````', 'after ${x}'].join('\n')

  it('four backticks + %type: opaque body', () => {
    const r = tokenizeMdz(doc, '$')
    expect(r.lines.map((l) => l.kind)).toEqual(['fence-open', 'fence-body', 'fence-body', 'fence-body', 'fence-close', 'text'])
    expect(r.lines.slice(1, 4).every((l) => l.tokens.length === 0)).toBe(true)
    expect(r.lines[5]!.tokens.map((t) => t.type)).toEqual(['placeholder'])
  })

  it('folds the fence', () => {
    expect(tokenizeMdz(doc, '$').folds).toEqual([{ startLine: 0, endLine: 4 }])
  })

  it('three backticks are a markdown fence: no mdz inside', () => {
    const r = tokenizeMdz(['```js', '$not: attr ${x}', '```', '$yes: 1'].join('\n'), '$')
    expect(r.lines.map((l) => l.kind)).toEqual(['code', 'code', 'code', 'attribute'])
    expect(r.lines[1]!.tokens).toEqual([])
  })

  it('four backticks without %type are a markdown fence', () => {
    expect(kinds(['````', '$a: 1', '````'].join('\n'))).toEqual(['code', 'code', 'code'])
  })
})

describe('comments', () => {
  it('$// at line start', () => {
    expect(tok('$// comment here')).toEqual([['comment', '$// comment here']])
    expect(kinds('$//')).toEqual(['comment'])
    expect(kinds('text $// not comment')).toEqual(['text'])
    expect(kinds('@// mdd comment', '@')).toEqual(['comment'])
  })
})

describe('foreign sigil', () => {
  it('is plain text', () => {
    expect(kinds('@key: v', '$')).toEqual(['text'])
    expect(kinds('$key: v', '@')).toEqual(['text'])
    expect(kinds('## @block', '$')).toEqual(['text'])
    expect(kinds('## $block', '@')).toEqual(['text'])
    expect(kinds('$// x', '@')).toEqual(['text'])
    expect(scanInline('@[[x]] @{y}', '$')).toEqual([])
  })
})

describe('folding', () => {
  it('blocks fold to the next heading of the same or higher level', () => {
    const text = [
      '## $step load', // 0
      '$a: 1', // 1
      '### $param depth', // 2
      '$value: 4', // 3
      '', // 4
      '## $step save', // 5
      'body', // 6
      '## $@', // 7
      '# Plain', // 8
    ].join('\n')
    expect(tokenizeMdz(text, '$').folds).toEqual([
      { startLine: 0, endLine: 3 },
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 6 },
    ])
  })

  it('runs to the end of the document', () => {
    expect(tokenizeMdz('## $a\nx\ny\n\n', '$').folds).toEqual([{ startLine: 0, endLine: 2 }])
  })
})

describe('line endings', () => {
  it('ignores a trailing \\r inside a line (mixed endings)', () => {
    const line = '$n: 42\r'
    const tokens = tokenizeMdz([line], '$').lines[0]!.tokens
    expect(tokens.map((t) => [t.type, line.slice(t.from, t.to)])[3]).toEqual(['value-number', '42'])
    expect(tokenizeMdz(['%user\r'], '$').lines[0]!.kind).toBe('role')
    expect(tokenizeMdz(['## $step load\r'], '$').lines[0]!.tokens.at(-1)).toMatchObject({ type: 'block-id', from: 9, to: 13 })
  })
  it('splits CRLF and CR', () => {
    expect(kinds('$a: 1\r\n$b: 2\r$c: 3')).toEqual(['attribute', 'attribute', 'attribute'])
  })
})
