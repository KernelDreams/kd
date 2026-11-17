# @kerneldreams/forms

Forms driven by JSON Schema + `x-ui`, plus a universal object editor: a `## $form` field parser, a DOM-free editor core
(parse, check, widget catalog, agent prompt, documents with patch history), a React `<FormView>` and `<ObjectEditor>`.

```
npm i @kerneldreams/forms
# peers: @kerneldreams/nrd, nunjucks, react, lucide-react (react and lucide-react only for `./react`)
```

The editor core lives in `.` (`./editor` stays as an alias).

| entry | what | depends on |
|---|---|---|
| `.` | `## $form` field parser (`parseField`, `buildSchema`), value helpers (`defaultValues`, `coerceValues`, `missingRequired`, origins, section summaries); editor core — everything listed for `./editor` | `@kerneldreams/nrd/md`, `@kerneldreams/nrd/template`, `nunjucks` (peers) |
| `./editor` | alias of the editor core in `.`: editor description: `parseEditor` (mdz / JSON → `EditorDef`), `deriveSchema`, `check` (paths, types, widgets, props, show-if, expressions, cycles, editor vs the type's schema), `createCatalog` + `prompt()`, ntpl expressions (`createExpressions`: dependency graph, `affected`, `evaluate`), `ensureIds`, `formToEditor` | `@kerneldreams/nrd/md`, `@kerneldreams/nrd/template`, `nunjucks` (peers) |
| `./react` | `<FormView>`: sections, origins (recipe / variant / run) with revert, variant picker, "only changed", image / textarea / select / radio / checkbox / number / input / model / file widgets, chip lists; `textInput`, `transferInput(s)`, `filterOptions` | `react`, `lucide-react` (peers) |

```tsx
import { buildSchema, defaultValues } from '@kerneldreams/forms'
import { FormView } from '@kerneldreams/forms/react'

const schema = buildSchema([{ name: 'prompt', spec: 'text // Prompt' }], { prompt: 'cat' })
<FormView template={{ id: 'x', file: 'x.mdz', schema }} values={defaultValues(schema)} … />   // plus the handlers (onChange, onSubmit, …)
```

### Editor core (`./editor`)

```ts
import { parseEditor, check, createCatalog, baseWidgets, fateWidgets, createExpressions, formatIssue } from '@kerneldreams/forms'

const { def, issues } = parseEditor(text)            // *.editor.mdz or JSON; a broken line is skipped, not fatal
const catalog = createCatalog([...baseWidgets, ...fateWidgets])
const r = check(def, catalog, { schema: typeSchema })  // typeSchema: the type's $schema or deriveSchema(default editor)
r.errors.map(formatIssue)  // one readable string per error: where, what, hint
catalog.prompt()           // text for an agent: format, nodes, types, filters, widgets with props and examples
createExpressions(def).evaluate(object).values         // { physicalBoxes: 4, 'sessions[a1].found': 2 }
```

- **Format** — `$row: <name>` on neighbouring fields, `$tab: <id>` on sections (no row/tabs blocks); paths from the
  root, inside `repeat` from the item; `group` prefixes its children. JSON: `{editor, id, title, schema?, nodes}`,
  node key `kind` (or `node`), paths written in full.
- **Expressions** — ntpl (`<< … >>`, `<{ … }>`), rendered by walking the AST (`nrd/template` `noEvalTemplate`): no
  `new Function`, works under CSP without `unsafe-eval`. Variables: root fields, `item`, `calc.<id>`; filters —
  nunjucks + nrd (`pluck`, `flatten`, `unique`, `groupBy`, `sortBy`).
- **Issues** — `{code, where, message, hint?, line?}`; `E_*` errors, `W_*` warnings.

### Document (`./editor`) and `<ObjectEditor>` (`./react`)

```ts
import { createDocument, toRfc6902 } from '@kerneldreams/forms'
import { ObjectEditor, EDITOR_LABELS_RU, frameWidget } from '@kerneldreams/forms/react'

const doc = createDocument(object, def, { catalog })        // rows of object arrays get `_id`
doc.exec('object.set', { path: 'skills.physique', value: 3 }) // → { ok, changed, patches }
doc.exec('object.insert', { path: 'aspects', item: { text: 'New' }, before: 'a7f3' })
doc.exec('object.move', { path: 'aspects', id: 'a7f3' })     // to the end
doc.batch('Agent: wealth track', [{ name: 'object.set', args: { … } }, …])  // one undo entry; a failing step rolls all back
doc.undo(); doc.redo(); doc.history   // [{ label, at, patches, inverse }] — JSON, safe to send
doc.errors                            // data issues after each command (required, type, enum, range, expressions)
doc.calc('physicalBoxes')             // computed values; only dependents are recomputed
doc.commands                          // { 'object.set': { schema, describe }, … } — tools for UI and agents
toRfc6902(patches, original)          // `@<_id>` → indices (and fromRfc6902 back)

<ObjectEditor doc={doc} view="sheet" labels={EDITOR_LABELS_RU} issues={check(def, catalog).errors} />
```

- **Patches** — JSON Patch ops `add/remove/replace/move`, but a `@<_id>` segment addresses a row by its `_id`
  (`/aspects/@a7f3/text`): history survives row reordering. Scalar arrays keep indices (`/stress/physical/2`).
- **Views** — `inspector` (one column, sections collapsed with a summary, field search from 15 fields) and `sheet`
  (full width, `$row` rows, `$tab` tabs, `--nr-sheet-*` tokens: `bg`, `line`, `accent`, `font`). `root="aspects[a7f3]"` —
  just one row (node inspector). `origins` — origin tag and “revert”; `variants` — a picker on top.
  `fieldMenu(field, {x, y})` — the host’s field menu (read aloud / copy / dictate): right click on a field
  or its “⋯” button; `field` is `{path, label, type, value, readOnly, set?}`. Without it — no button, native menu.
- **Widgets** — base, `fate.*`, `ccv3.*` built in; `widgets={{ id: Component }}` overrides; a catalog entry with
  `frame: { srcdoc | src }` renders an iframe speaking the artifact bridge v2 (`__host.widget.onInit/change/size`,
  `WIDGET_PRELUDE` is injected into `srcdoc`).
- `./react` does not import the expression core (no nunjucks): the document is created by the host from `.`.

- **Strings** — `labels` (partial; English defaults in `LABELS`, `{name}` is substituted).
- **Model picker** — `modelWidget` (your component with `ModelWidgetProps`); default is an input with a datalist.
- **Styles** — Tailwind utilities on `--nr-*` tokens (`text-nr-sm`, `gap-nr-4`…). The host scans the package with its
  own Tailwind and token bridge: `@source '../node_modules/@kerneldreams/forms/dist';`. The demo carries a sample set
  of tokens, a skin and the bridge (`demo/theme`).

```
npm run build      # tsc → dist
npm test           # vitest (schema, FormView, editor core, document, ObjectEditor)
npm run demo       # vite demo (?theme=dark, ?lang=ru)
npm run screens    # docs/screens/*.png (CHROMIUM_PATH to override the browser)
npm run e2e        # <ObjectEditor> on demo/editor.html, steps 1–6 (E2E_PORT_BASE, default 24900)
```

## License

MIT
