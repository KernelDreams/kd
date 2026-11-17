# @kerneldreams/skins

Chat UI skins as data: a `<name>.skin.css` file with an `/* @skin … */` header and CSS that follows a token and selector contract. Includes a validator, `base` inheritance, a file-system source and converters for Obsidian, SillyTavern and VS Code themes.

```
npm i @kerneldreams/skins
```

## Minimal example

```ts
import { validateSkin, compileSkin } from '@kerneldreams/skins'

const files: Record<string, string> = {
  paper: `/* @skin
 * name: paper
 * mode: light
 */
[data-skin="paper"] { --nr-bg: #fbf7ee; --nr-fg: #222; }`,
}

const check = validateSkin(files.paper!, { name: 'paper' })   // { ok, header, errors, warnings, vars }
const skin = compileSkin('paper', (n) => files[n])            // { css, vars, chain, errors, warnings, … }
console.log(check.ok, skin.chain)
```

For skins on disk use `createFsSkins` from `@kerneldreams/skins/node`.

## Entry points

- `.` — no IO: the contract (`TOKENS`, `ELEMENT_SELECTORS`, `ELEMENT_PROPERTIES`, `FONT_HOSTS` — preferred font hosts),
  `parseHeader` (keys `name/description/mode/base/source/license/author`), `validateSkin(text, {name, known})`,
  `compileSkin(name, lookup, known?, {fallback})` (`base` inheritance).
- `./node` — disk: `createFsSkins({root, cwdOf, usersDir?, defaultUser?})` — `list/css/get/check/save/select`
  (shared `<root>/skins`, workspace `<cwd>/.nr/skins`); a user's `user.css` via `userCss/saveUserCss({userId})`
  (`<usersDir>/<id>/user.css`, no skin validator); `skinContext(root, cwd)` — the "current skin" system block for an
  agent.
- `themes/eh/` — bundled example themes (`eh-light`, `eh-dark`) with `/* @settings */` knobs.

### Linter

An error is only unreadable CSS or a bad header (name, `mode`, `base`, a cycle). Everything outside the contract (a
selector outside the hooks, a property outside the list, `@media`, `!important`, internal `--nr-z-*`, a small font
size, contrast) is a "not guaranteed" warning: the skin is still written, built and applied. Handle classes on the
root (`[data-skin="x"].glow`) are part of the contract. For an incomplete palette `compileSkin` fills the gaps from the
set's default skin (`parchment`) or `DEFAULT_PALETTE`.

### Theme converters

`convertTheme(text, {from?, target?, name?, source?, license?, author?, manifest?})` — the source is detected
(`detectSource`); `convertObsidian(theme.css, {manifest})`, `convertSillyTavern(json)`, `convertVsCode(json)`
(`include` — `mergeVsCodeThemes`, JSONC — `parseJsonc`).

- Converters live in a registry: `registerThemeConverter({id, detect?(text, file), convert(text, opts)})` returns an
  unregister function; `themeConverters()` lists them. Themes for other platforms can be added from outside by plugin
  packages (`detect` returns a confidence, the highest wins).
- One result shape: `{css, tokens, palettes, sources, mode, fonts, imports, report: {mapped, approximated, dropped,
  outside, droppedProps, coverage, foreign, todo}, lint}`; `formatReport(r)` renders markdown.
- Target `skin` (header, `[data-skin="<name>"]`) or `bot` (`[data-skin][data-mode]`).
- Shared core in `convert/core.ts` (level-A palette derivation, 4.5:1 contrast, property classes, coverage against the
  contract, `emitCss`); CSS color evaluation via `evalColor` (oklch/lch/lab, `from`, `color-mix`, `calc`).
- Tables: `OBSIDIAN_TOKEN_MAP` / `OBSIDIAN_SELECTOR_MAP`, `ST_TOKEN_MAP` / `ST_SELECTOR_MAP`,
  `VSCODE_TOKEN_MAP` / `VSCODE_SCOPE_MAP`. Coverage is computed without rules aimed at a foreign UI (`foreign`).
  Probes and thresholds are in `test/convert.test.ts`.

### Readability

`checkTextSize` (font size of `--nr-text-*` at 100%: `sm` / `body` >= 15px, the rest >= 13px — a validator error),
`checkContrast(vars, mode)` (`--nr-fg/muted/accent/ok/error` against `--nr-bg` and `--nr-surface` >= 4.5:1 — a
`compileSkin` warning), `parseColor`, `contrastRatio`, `READABILITY_RULES` — the rules in words, for an agent and a
theme editor (monospace only for code, paths, ids and time).

### Bot theme layer

`validateBotCss(css)` validates the CSS of the "bot" layer (`theme.botCss`) under the root `[data-skin][data-mode]`
(`BOT_ROOT`). The bot layer is open: `validateBotCss` lets https stylesheets from any host through.

## Consumers

The host backend (`serveBackend({skins})`) and the artifact host (`__host.skins`, finalize, the `skin_check` tool).

## License

MIT
