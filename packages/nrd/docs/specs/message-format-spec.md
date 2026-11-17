# Message Format Spec

> **NOT PART OF `@kerneldreams/nrd` SINCE 4.0.0.** Ядро больше не
> реализует ни этот формат, ни модель `Message`/`ContentBlock`: `%role`-лента
> принадлежит `@kerneldreams/nrd/chat` (engine-spec §9), а модель §3 переехала
> в контекст-слой `@kerneldreams/engine` как его внутренний тип. Документ остаётся
> здесь как описание модели для тех, кто её ещё держит.
> Describes the internal structure of chat messages within `%role` streams.

## 1. Overview

> **СТАТУС: ЛЕГАСИ (18.07.2026, решение owner).** Кодирование типизированных блоков `` ````%type `` вытеснено `%%`-суб-нодами формата nr-chat (канон: `S:\skills\nr-system.dev\specs\nr-session-spec.md` §4 + nr-chat-spec). Причины: суб-ноды не требуют закрывающих фенсов (append-only стрим чистый), не требуют отдельного парсера (nr-chat как есть), мета — {json5} в маркере вместо инлайн-`$key:` с известным ограничением на `
. Новый код на этот формат не пишется; живой потребитель (FileSession nr-engine) мигрирует на nr-chat+nr-session (референсный бэкенд nr-ui-protocol). Конверсия `` ````%type `` → `%%` механическая. Модель данных §3 (Message/ContentBlock) и маппинг в API §3.1 остаются концептуально верными — они изоморфны Part-модели протокола; легаси здесь — синтаксис хранения.

A chat session body is a stream of **messages** separated by `%role` markers.
Each message contains an ordered array of **typed content blocks**.

Two layers exist and do not intersect:

| Layer | Syntax | Responsibility |
|-------|--------|---------------|
| **Session** | `## $name`, mdz blocks | Swipes, collapsed ranges, checkpoints, index |
| **Message** | `%role`, `` ````%type `` | Message envelope, content blocks inside |

The mdz parser and the message parser operate on different inputs.
The message parser never interprets mdz syntax; mdz never interprets `%role` or `` ````%type ``.

## 2. Grammar

### 2.1 Message envelope: `%role`

```
%role [$key: value]* [$flag]*
```

- `%` followed by role name: `user`, `assistant`, `system`, `tool_result`, or any string.
- Optional inline attributes after the role name (§2.3).
- A `%role` line closes the previous message and opens a new one.
- Lines before the first `%role` in a stream are ignored.

### 2.2 Content block: `` ````%type ``

````
````%type [$key: value]* [$flag]*
body content (opaque)
````
````

- **Four** backticks followed by `%` and a type name.
- Closed by a line of exactly four backticks (`` ```` ``).
- Body is opaque — the parser stores it as-is, no interpretation.
- Attributes parsed identically to `%role` inline attributes (§2.3).
- A content block can only appear inside a message (after a `%role` marker).

**Nesting safety:** Per CommonMark, a fence of N backticks is closed only by N+ backticks.
Three-backtick code fences inside a four-backtick block are body content, not structure.

**Edge case:** If body content contains a line starting with exactly four backticks,
the writer MUST escape it by prepending a zero-width space or adding a fifth backtick
to the opening/closing fence. In practice this is near-zero frequency.

### 2.3 Inline attributes

Shared by `%role` and `` ````%type `` lines:

```
$key: value     — key-value pair, value extends to next $key or EOL
$flag           — bare flag, equivalent to $flag: true
```

Value boundary: the next `$` not preceded by whitespace-only opens a new attribute.
Values cannot contain `$` in non-final position on the line (known limitation; use
separate attribute lines for complex values — see §2.4).

### 2.4 Body-level attributes

Lines starting with `$key:` between a `%role` marker (or `` ````%type `` marker)
and the first body-content line are parsed as attributes of the message (or block):

```
%assistant $id: m2
$model: sonnet-4-6
$cache: true
The actual response starts here.
```

Once a non-attribute, non-empty line is encountered, attribute parsing stops.
All subsequent lines are body content, even if they start with `$`.

### 2.5 Default text block

Everything between `%role` and the first `` ````%type `` (or the next `%role`, or EOF)
that is not an attribute line is an **implicit text block**. If `` ````%type `` blocks
exist, text fragments between them are each a separate implicit text block.

```
%assistant
This is text block 0.
````%thinking
reasoning
````
This is text block 1.
````%tool_use $name: search
{"query": "..."}
````
This is text block 2.
```

Result: `[text:0, thinking, text:1, tool_use, text:2]` — order preserved.

If a message has no `` ````%type `` blocks, the entire body is a single text block.
This ensures full backward compatibility with existing `%role`-only files.

## 3. Data model

```typescript
interface Message {
  role: string
  attrs: Record<string, Value>
  blocks: ContentBlock[]
}

interface ContentBlock {
  type: string          // "text", "thinking", "tool_use", etc.
  attrs: Record<string, Value>
  body: string          // opaque, as-is
}
```

### 3.1 Mapping to LLM API

The assembler (not the parser) maps blocks to API content blocks:

| Block type | API mapping |
|-----------|-------------|
| `text` | `{type: "text", text: body}` |
| `thinking` | `{type: "thinking", thinking: body}` — or omitted by policy |
| `tool_use` | `{type: "tool_use", id: attrs.call_id, name: attrs.name, input: JSON.parse(body)}` |
| `tool_result` | `{type: "tool_result", tool_use_id: attrs.call_id, content: body}` |
| `image` | `{type: "image", source: ...}` — encoding TBD |
| `summary` | Not sent to API — consumed by Context Engine |
| `usage` | Not sent to API — analytics |
| `json` | Opaque data block — consumer-defined |
| `code` | Opaque code block — consumer-defined |

Unknown types are preserved in the data model but not sent to API by default.

### 3.2 Content block classification

Blocks are classified by the consumer, not the parser.
The parser treats all types identically.

Suggested classification for the assembler:

- **Content blocks** (sent to API): `text`, `thinking`, `tool_use`, `tool_result`, `image`
- **Meta blocks** (consumed by engine): `summary`, `usage`, `embedding`
- **Data blocks** (opaque, consumer-defined): `json`, `code`, `annotation`

## 4. Parser algorithm

```
Input: string (raw body text of a session document or standalone chat)
Output: Message[]

state:
  messages: Message[] = []
  current: Message | null = null
  currentBlock: ContentBlock | null = null  // inside a ````%type fence
  textLines: string[] = []                  // accumulator for implicit text
  parsingAttrs: boolean = true

for each line:
  if line matches /^%(?!>)(\w+)(.*)/:        // %role marker
    flushBlock()
    flushMessage()
    current = new Message(role, parseInlineAttrs(rest))
    parsingAttrs = true
    continue

  if current is null:
    continue                                  // lines before first %role

  if line matches /^````%(\w+)(.*)/:          // ````%type opener
    flushTextBlock()
    currentBlock = new ContentBlock(type, parseInlineAttrs(rest))
    parsingAttrs = false                      // no body-level attrs in typed blocks
    continue

  if currentBlock and line matches /^````\s*$/:  // ```` closer
    flushBlock()
    continue

  if currentBlock:
    currentBlock.body += line
    continue

  // Outside any ````%type block — text or attributes
  if parsingAttrs:
    if line is empty:
      continue
    attr = parseAttrLine(line)
    if attr:
      current.attrs[attr.key] = attr.value
      continue
    parsingAttrs = false

  textLines.push(line)

flushBlock()
flushMessage()
return messages
```

`flushTextBlock()`: if textLines is non-empty, push `ContentBlock{type:"text", body: trim(textLines.join('\n'))}`, clear textLines.

`flushBlock()`: flushTextBlock(), then if currentBlock exists push it to current.blocks, clear currentBlock.

`flushMessage()`: flushBlock(), if current exists push to messages, clear current.

### 4.1 Attribute parsing

Reuses the existing inline attribute parser from `splitter.ts` (§2.3).
Value coercion: `true`/`false` → boolean, numeric strings → number, else string.

## 5. Serialization

```
for each message:
  emit "%{role} {serializeAttrs(attrs)}"
  for each block in blocks:
    if block.type === "text":
      emit block.body
    else:
      emit "````%{type} {serializeAttrs(attrs)}"
      emit block.body
      emit "````"
  emit ""  // blank line separator
```

Round-trip: `serialize(parse(text))` reproduces the message stream.
Body content is never modified. Attribute order may differ (record, not ordered).

## 6. Backward compatibility

- Files without `` ````%type `` blocks parse identically to current splitter output.
- `Message.blocks` will contain a single `ContentBlock{type:"text"}`.
- Consumers that only read `text` blocks work unchanged.

## 7. Scope boundaries

This spec covers:
- Grammar of `%role` markers and `` ````%type `` content blocks
- Parser input/output contract
- Data model (Message, ContentBlock)

This spec does NOT cover:
- Session infrastructure (swipes, collapsed, checkpoints) — see session-format-spec
- Context Engine filtering policies — see context-engine-spec
- API mapping details — see prompt-assembly-spec
- Template rendering — see ntpl spec
