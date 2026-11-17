# @kerneldreams/runz-runtime

The runz runtime: script and document lookup (registry), the context chain (`buildScopes`: CLI > document > configs > env), running a document as a program (a `$type` handler with host helpers, `## $handler`, notebook) and a resolve hook that opens the canonical `@kerneldreams/*` packages and `.runz/` environments to scripts. It is the same code the `runz` CLI runs on; hosts take ctx/meta from it instead of building the chain in parallel.

## Install

```
npm i @kerneldreams/runz-runtime
```

Requires Node >= 24 (native TypeScript for script loading).

## Usage

```ts
import type { ScriptMeta, ProgramHelpers } from '@kerneldreams/runz-runtime'

// A document handler: the host's helpers arrive as the third argument.
export default async function (ctx, meta: ScriptMeta, helpers?: ProgramHelpers) {
  const reply = await helpers!.llm([{ role: 'user', content: 'hello' }])
  return { output: reply }
}
```

Other entry points: `buildScopes`, `loadConfigFile`, `globalRunzDir`, `importScriptFn`, `findScript` / `listScripts` (registry), `parseDocFile`, `registerResolveHook`, `runDocument`,
`execute`, `runTests`. The `./llm` and `./web` subpaths export the LLM and web provider layers.

Capabilities that need an agent loop (the `agent` helper, an ACP agent) are provided by an extension: a file named
after the slot (`agent.mjs`, `acp.mjs`) in `~/.runz/extensions/` (or the folder from `$extensions_dir` /
`KD_EXTENSIONS`) that exports the implementation. Without it, the helper fails with a message naming the missing slot.

## Run trace: `run.trace.jsonl`

Every document run writes a trace on its own; recipes need no edits. A line is a JSON event:
`{t, ev, step?, part?, ms?, model?, tokens_in?, tokens_out?, cost?, out?, ok?, error?}`,
where `ev` is `run.start` (with `doc`, `run`) · `step.start` (with `icon`, `title`) · `step.end` · `llm` · `run.end`.

- **Where:** the run's `$out` (relative to the launch cwd, like recipes) — `<out>/run.trace.jsonl`; without `$out` —
  `<document folder>/.runz/runs/<time>/`. The previous trace in the same folder is renamed to
  `run.trace.<time>.jsonl`. The file is created on the first step or model call: `--run=help` leaves no trace.
- **Steps** are notebook steps (`## $step`, `$shell`) and `helpers.run(id)`; the top-level `fn` (`$run`,
  `## $handler`, a `$type` handler) is the run itself. A step's picture and caption come from the block's
  `$nr-icon` / `$nr-title`.
- **Model calls** — `helpers.llm` and the `run` / `swipe` calls of `helpers.agent` sessions write an `llm` event with
  the current step and part; `tokens_in/out` come from the provider's `done` frame (`usage`), when the gateway
  supplies it.
- **`helpers.step(id, {part?, out?, icon?, title?})` → `end({out?, error?})`** — a step inside a single body (for
  example one dossier per character, as a `part`; or generation / judge / embedding on a test bench). With a function
  as the third argument the step wraps it: `await helpers.step('judge', {part: seed}, () => ...)`. Parallel parts must
  use the function form (a manual `end()` attributes `llm` to the last open step).
- `RUNZ_TRACE=off` disables writing; `RUNZ_TRACE_POINTER=<file>` writes the trace path into that file (this is how
  job runners learn `JobInfo.trace`). A host UI can read it to show a run history.

## Two layouts

- **Monorepo workspace** — `exports` points at `src/*.ts`: runz runs itself from source (Node 24, native TS), no
  build needed.
- **Registry** — the published package ships `dist` (js + d.ts). The registry manifest is rewritten at publish time:
  `publishConfig.exports` becomes `exports`, and `file:` dependencies become `^version`; a bare `npm publish` is not
  enough.

Build: `npm run build` (`prebuild` removes `dist`).

## License

MIT
