import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@kerneldreams/editor': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: {
    outDir: fileURLToPath(new URL('../demo-dist', import.meta.url)),
    emptyOutDir: true,
  },
  worker: { format: 'es' },
})
