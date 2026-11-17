# @kerneldreams/nrd

NRD is a plain-text document format for working with language models, plus the interpreter for it: parser and serializer, a `${}` placeholder resolver, context assembly from a config document, block execution and templates. Documents are readable by humans and by models, and the same file can be configuration, a recipe, a prompt or a chat session.

Three flavours of the format share one grammar:

| extension | what it is |
|---|---|
| `.mdd` | data document: attributes, typed blocks, tables |
| `.mdz` | the same grammar with `$`-sigil attributes and blocks (`$title: Hello`, `## $char alice`); config, recipes, programs |
| `.mds` | chat session: a feed of `%role` messages (see `@kerneldreams/nrd/chat`) |

```
npm i @kerneldreams/nrd
```

Node >= 24, ESM only, no runtime dependencies in the root entry. Template engines (`nunjucks`, `handlebars`) and `ajv` are optional peers, loaded lazily.

## Quick start

```ts
import { parseDocument, resolve, objectContext, chainContext } from '@kerneldreams/nrd'

const doc = parseDocument([
  '$title: Hello',
  '$who: world',
  '$greeting: ${title}, ${who}!',
  '',
  '## $char alice',
  '$name: Alice',
].join('\n'))

resolve('${greeting}', doc)          // 'Hello, world!'
resolve('${char.alice.name}', doc)   // 'Alice'

// layer contexts: the first one wins
const ctx = chainContext(objectContext({ who: 'there' }), doc)
resolve('${greeting}', ctx)          // 'Hello, there!'
```

`parse(text)` returns the raw syntax tree (`Document`) without resolving anything; `serialize(doc)` writes it back in canonical form. `parseDocument(text)` wraps the tree as an `NRDocument` that implements `IContext`: `get(path)`, `func(name, args)`, `cast(...)`. Everything that reads values (the resolver, templates, the context chain) works against `IContext`, so a document, a plain object and a function table are interchangeable.

## Entry points

The package is cut by what a module needs from the platform, not by feature. Each subpath works wherever its requirements are met.

| import | needs | contents |
|---|---|---|
| `@kerneldreams/nrd` | nothing (no `node:`, no `fetch`) | parser and serializer, `IContext` / `IArray`, `resolve`, `walk`, `NRDocument`, `buildContext`, `execBlock` and the `Executor` contract, `Result` helpers, document-as-program registry |
| `@kerneldreams/nrd/web` | WinterCG (fetch, streams, crypto): browser, Workers, Node | HTTP client, LLM providers behind one interface (OpenAI and Anthropic adapters, `LLMProvider`), in-memory storage, embedding helpers |
| `@kerneldreams/nrd/node` | Node (fs, spawn, process) | file storage, `spawnExecutor`, `nodeCapabilities`, `buildRuntimeContext`, `loadProgram` / `detectKind`, file includes, presets, SQLite embedding store, runtime helpers |
| `@kerneldreams/nrd/template` | like the root + a template engine | `createEnv`, `render`, `nunjucksEngine`, `handlebarsEngine`, `extractNrd`, helpers, URL routing for site plugins |
| `@kerneldreams/nrd/format` | nothing | facade over the codec: `parse`, `serialize`, tables (`serializeTable`, `parseTable`, typed headers), schema-driven `serializeWithSchema` / `parseWithSchema`, `toJson` / `fromJson` |
| `@kerneldreams/nrd/batch` | nothing | combinatorics of a document: axes (lists, ranges, tables), `## $batch` groups, `planBatches` |
| `@kerneldreams/nrd/md` | nothing | the mdd/mdz codec itself (`@kerneldreams/nrd/md/schema` adds the JSON-Schema layer) |
| `@kerneldreams/nrd/json5` | nothing | zero-dependency JSON5 micro-codec |
| `@kerneldreams/nrd/contracts` | nothing | shared interfaces: `IContext`, `IStorage`, `Executor`, `HttpClient`, `Result`, LLM and embedding contracts (`./contracts/eval` — expression evaluation) |
| `@kerneldreams/nrd/chat` | nothing | `.mds` chat format: `parse`, `stringify`, `replaceSpan`, `escapeBody`, `fenceFor` |

## Placeholders and resolution

`${path}` pulls a value from the current context: `${title}`, `${char.alice.name}`, `${list.0}`, nested forms such as `${a.${b}}`, and function calls `${up(title)}`. A fully quoted value (`"${x}"`) is a literal; `\${` escapes a placeholder. The scanner is brace-balanced, not regex-based (`scanPlaceholders`, `parseExpr`). Unresolved names fall back to the environment and warn.

Functions come from the context chain: `funcContext({ up: (a) => String(a[0]).toUpperCase() })` chained with a document makes `${up(title)}` work. `coreFunctions` is the built-in pure standard library.

## Context assembly

```ts
import { buildContext } from '@kerneldreams/nrd'

const ctx = await buildContext(configText, { params: { env: 'prod' }, baseDir: '/path/to/config' })
ctx.get(['some', 'value'])
```

`buildContext` parses an mdz config, merges parameters (explicit params > root attributes > environment), checks `$required`, resolves `## $source` blocks through source plugins and `## $transform` blocks through transform plugins, and returns a chained `IContext`. Storage, HTTP and process execution are injected, so the same code runs in any host; `@kerneldreams/nrd/node` supplies the Node set.

## Chat sessions (.mds)

```ts
import { parse, stringify } from '@kerneldreams/nrd/chat'

const messages = parse('%user\nhi\n%assistant\nhello\n')
// [{ role: 'user', body: 'hi' }, { role: 'assistant', body: 'hello' }]
stringify(messages)
```

A `%role` line at the start of a line opens a message. A fenced block (four or more backticks) hides markers inside it, so quoted chats do not split their host message.

## Templates

```ts
import { nunjucksEngine } from '@kerneldreams/nrd/template'
import { objectContext } from '@kerneldreams/nrd'

const engine = await nunjucksEngine()          // needs the optional peer `nunjucks`
engine.render('Hi << name >>', objectContext({ name: 'Sophie' }))   // 'Hi Sophie'
```

Template syntax uses `<< >>` for values and `<{ }>` for tags so it does not collide with `${}` placeholders in documents. `handlebarsEngine()` is the second engine behind the same `TemplateEngine` interface.

## Format reference

Full grammar, escaping and coercion rules, serialization and the JSON form are in `docs/specs/format-spec.md` and `docs/API.md` in this package; the LLM provider interface is in `docs/specs/llm.md`.

## License

MIT. See `LICENSE` and `NOTICE`.
