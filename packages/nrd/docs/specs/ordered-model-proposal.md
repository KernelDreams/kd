# Ordered Model Proposal (draft)

> Status: draft. Not blocking any current work.
> Addresses: attr/block name collision (comfy $prompt bug), serialize round-trip, body fragment interleaving.

## Problem

Current `Block` model stores three separate containers:

```typescript
interface Block {
  name: string
  level: number
  attrs: Attribute[]
  body?: BodyValue
  children: Block[]
}
```

Document order between attrs, body fragments, and children is lost after parsing.
Consequences:

1. **Name collision:** `$prompt: value` + `## $prompt` with same name — block wins because
   `resolveName` checks children before attrs. True last-wins by document order is impossible.
2. **Serialize round-trip:** serializer emits attrs → body → children, original interleaving
   not reconstructible.
3. **Body fragments:** flushBody now appends (fixed), but position of a nested block
   relative to body fragments is not recorded.

## Proposed model

```typescript
type BlockItem =
  | { kind: 'attr'; attr: Attribute }
  | { kind: 'body'; value: BodyValue }
  | { kind: 'block'; block: Block }

interface Block {
  name: string
  level: number
  id?: string
  items: BlockItem[]      // document order, source of truth

  // Derived views (computed lazily, cached):
  // attrs: Attribute[]    → items.filter(kind=attr).map(i => i.attr)
  // body?: BodyValue      → concatenated body fragments
  // children: Block[]     → items.filter(kind=block).map(i => i.block)
}
```

`items[]` preserves document order. `attrs`, `body`, `children` become derived getters
for backward compatibility — existing code that reads them works unchanged.

## Impact

### Parser
- `flushBody` pushes `{kind: 'body'}` to `top().items` instead of assigning `target.body`.
- Attribute parsing pushes `{kind: 'attr'}` to `top().items`.
- Block opening pushes `{kind: 'block'}` to `top().items` (currently `top().children.push`).

### Document (IContext)
- `resolveBlockName` scans `items` in reverse for true last-wins.
- `blockCast('text')` concatenates body fragments.
- `blockCast('records')` filters block items.

### Serialize
- Iterates `items[]` in order — round-trip is exact.

### Tests
- Existing tests should pass (derived views identical to current behavior for non-colliding docs).
- New tests: collision cases, interleaved serialize round-trip.

## Migration

Non-breaking if derived views are exposed. Code using `block.attrs`, `block.body`,
`block.children` directly needs migration to getters or helper functions.

Estimated effort: 1 day (parser + document + serialize + tests).

## Decision

Deferred. Current compromise documented in format-spec:
"Name collision between attr and block: block takes priority. True last-wins via ordered model is a known limitation."
