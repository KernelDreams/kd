import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    // След прогона в тестах не пишется: фикстуры не обрастают .runz/runs.
    env: { RUNZ_TRACE: 'off' },
  },
})
