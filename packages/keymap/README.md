# @kerneldreams/keymap

Hot keys as data. A table of bindings `{action, keys, when?}` built from layers (scheme defaults → plugin bindings → user
overrides), chords by physical key (a Russian keyboard layout yields the same shortcuts), a `when` context, collisions,
and tooltip hints ("⌘⇧J" / "Ctrl+Shift+J"). No dependencies and no DOM: it only reads an object that looks like a
`KeyboardEvent`. Grew out of the Trempel editor's keymap (MIT).

```
npm i @kerneldreams/keymap
```

## Quick start

```ts
import { actionOf, collisions, isMac, keyHint, localOverrides, resolve, type Layer } from '@kerneldreams/keymap'

type Action = 'palette' | 'panel.bottom' | 'help' | 'cancel'
const core: Layer<Action> = {
  source: 'core',
  bindings: [
    { action: 'palette', keys: ['mod+k'] },
    { action: 'panel.bottom', keys: ['mod+j'] },
    { action: 'help', keys: ['?', 'mod+/'] },          // "?" is not intercepted inside an input field
    { action: 'cancel', keys: ['escape'], when: 'running' },
  ],
}
const store = localOverrides<Action>('my-app.keys')      // storage seam: load/save
const table = resolve([core /*, plugin layers */], store.load())
const mac = isMac()

addEventListener('keydown', (e) => {
  const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
  const action = actionOf(e, table, { mac, context: { editable, running: isRunning() } })
  if (action) { e.preventDefault(); run(action) }
})

button.title = `Bottom panel (${keyHint('panel.bottom', table, mac)})`   // "⌘J"
console.warn(collisions(table, mac))                                       // [['mod+k', ['palette', 'x']]]
```

## Chord

`mod+ctrl+shift+alt+<key>`, case-insensitive, modifiers in any order (`normalizeChord` converts to the canonical form).

- `mod` — ⌘ on Mac, Ctrl elsewhere; `ctrl` — the Control key itself (on non-Mac, `ctrl` and `mod` are the same).
- Letters match by physical key (`event.code`); digits and punctuation with ⌘/Ctrl do too (on a non-Latin
  layout they match by `event.key`); everything else matches by `event.key` (`?`, `+`, `f3`, `escape`, `arrowdown`).
- Shift is part of the character for `+`, `_`, `?` and the like: `shift+=` is written as `+`.
- Synonyms: `cmd` / `meta` → `mod`, `opt` / `option` → `alt`, `esc`, `del`, `up` / `down` / `left` / `right`.

## API

| | |
|---|---|
| `resolve(layers, overrides?)` | the live table: a layer that names an action replaces everything the lower layers said about it; an override replaces the keys (`[]` removes them), `when` and `title` are kept; a row's source is the layer's `source` or `'user'` |
| `actionOf(e, table, {mac, context})` | the event's action or `null`. In an input field (`context.editable`) a chord without ⌘/Ctrl/⌥ (a letter, `?`, Enter, arrows) is not intercepted unless the binding's `when` mentions `editable`; Esc and F-keys are intercepted |
| `chordOf(e, mac)`, `recordChord(e, mac)` | the event's chord; recording returns `null` while only modifiers are held |
| `evalWhen(expr, ctx)` | `name`, `!name`, `&&`, `\|\|`; an unknown name is false |
| `collisions(table, mac)` | `[chord, actions][]`: one chord, several actions, the same `when` |
| `bindingsOf(chord, table, mac)` | who holds a chord (a warning when recording) |
| `keyHint(action, table, mac)`, `formatChord(chord, mac)` | "⌘⇧J" on Mac, "Ctrl+Shift+J" elsewhere; `''` — not assigned |
| `keysOf(action, table)`, `isTextChord`, `normalizeChord`, `parseChord`, `isMac()` | |
| `localOverrides(key, storage?)` | overrides in localStorage (or any Storage): `{load, save}`; in a private window it starts empty and lives until reload |

## License

MIT
