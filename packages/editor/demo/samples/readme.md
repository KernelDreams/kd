@title: nr-editor readme
@status: draft
@tags: @[editor, markdown, demo]
@version: 3

# nr-editor

A **text editor** for KernelDreams files. The raw text is the *source of truth* —
live preview only ~~changes~~ decorates how it looks. Some ==highlighted== words and `inline code`.

## Links

- External: [CodeMirror](https://codemirror.net/)
- Wiki links: [[getting-started]], [[docs/spec|the spec]] and [[mdz-syntax]]
- Autolink: <https://github.com/Not-Real-Studio/kd/packages/editor>

## Lists

1. Ordered item
2. Another one
   - nested bullet
   - with **bold** inside

- [x] Live preview
- [x] Wiki links
- [ ] Collaboration (out of scope)

> Fantasy is the vaccine, not the disease.
> — a quote block

## Table

| Mode | Sigil | Live preview |
|------|:-----:|-------------:|
| md   | `@`   | yes          |
| mdz  | `$`   | yes          |
| ts   | —     | no           |

## Code

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`
}
```

```json
{ "mode": "md", "wrap": true }
```

## Data layer

The `.md` file can carry mdd data — attribute lines with the `@` sigil:

## @note intro
@author: owner
@priority: 1
@public: true
@meta: {lang: 'en', words: 120}
@see: @[[docs/spec.md#Modes]]

Body of the note with a placeholder @{author.name} and an escaped \@{literal}.

## @

![Logo](https://placehold.co/240x80/png?text=nr-editor)

---

Plain `$key: value` lines are just text here: $foreign: sigil.
