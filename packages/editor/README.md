# @kerneldreams/editor

A text-file editor built on CodeMirror 6. Specification: [`docs/SPEC.md`](docs/SPEC.md).

```sh
npm i @kerneldreams/editor
```

```ts
import { createEditor } from '@kerneldreams/editor'

const editor = createEditor({
  parent: document.getElementById('editor')!,
  filename: 'recipe.mdz',
  text,
  theme: 'auto',
  onChange: (text) => {},
  onSave: (text) => {},          // Mod-s
  onLinkClick: (target) => {},   // [[x]] and $[[x]]
})
editor.getText() === text        // byte for byte: BOM, \r\n, trailing spaces
```

- React: `import { NrEditor } from '@kerneldreams/editor/react'`.
- Styles inject themselves (`<style id="nre-styles">`); theming is done with `--nre-*` CSS variables on `.nre-root`.
- TypeScript service: `typescript: true` starts the built-in worker (`dist/worker.js`, self-contained, no CDN), or
  bring your own: `import TsWorker from '@kerneldreams/editor/worker?worker'` →
  `typescript: { worker: new TsWorker() }`.
- Also exported: `createDiff` (diff view), `modeFromFilename`, and the `.mdz` tokenizer (`tokenizeMdz`).

```bash
npm i
npm run demo      # demo: http://localhost:5173
npm test          # vitest
npm run build     # dist/ + a check that the base bundle has no typescript
npm run screens   # docs/screens/*.png (playwright-core + Chromium)
```
