import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const sibling = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // file: deps on the S:\ drive resolve through symlinks; forks pool is the
    // stable choice on Windows (see libs/CLAUDE.md).
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
  resolve: {
    preserveSymlinks: true,
    // @kerneldreams/* are runz file-links at runtime; for the test process we point
    // them at the built dist of the sibling packages.
    alias: {
      // Порядок значим: строковый alias у Vite — префиксный, поэтому более
      // длинные subpath обязаны стоять ВЫШЕ голого имени пакета.
      '@kerneldreams/nrd/web': sibling('../nrd/dist/web/index.js'),
      '@kerneldreams/nrd/node': sibling('../nrd/dist/node/index.js'),
      '@kerneldreams/nrd': sibling('../nrd/dist/index.js'),
      '@kerneldreams/chat-store/memory': sibling('../chat-store/dist/memory/index.js'),
      '@kerneldreams/chat-store': sibling('../chat-store/dist/index.js'),
    },
  },
})
