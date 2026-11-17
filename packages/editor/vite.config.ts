import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import pkg from './package.json' with { type: 'json' }

const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]
const isExternal = (id: string) => external.some((dep) => id === dep || id.startsWith(`${dep}/`)) && !id.endsWith('?inline')

export default defineConfig({
  base: './',
  // В монорепе kd корневой typescript старше: @typescript/vfs не должен тянуть второй экземпляр в воркер.
  resolve: {
    alias: [{ find: /^typescript$/, replacement: fileURLToPath(new URL('./node_modules/typescript/lib/typescript.js', import.meta.url)) }],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        react: fileURLToPath(new URL('./src/react.tsx', import.meta.url)),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: isExternal,
      output: {
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'worker.js',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // Atomic's dist uses extensionless relative imports: let Vite resolve them.
    server: { deps: { inline: ['@atomic-editor/editor'] } },
  },
})
