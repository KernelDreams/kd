// Один бандл: dist/nr-chat.js (ESM, регистрирует <nr-chat>), клиент вшит.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/nr-chat.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
})
