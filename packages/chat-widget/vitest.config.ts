import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // DOM — из jsdom вручную (test/dom.ts): окружение `jsdom` подменяет
    // AbortController, и fetch Node отвергает его signal.
    environment: 'node',
    setupFiles: ['test/dom.ts'],
    include: ['test/**/*.test.ts'],
  },
})
