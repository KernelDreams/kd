import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // packages/* — замороженные копии (рантайм переехал в kd/packages/runz-runtime)
    include: ['tests/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 15000,
    // След прогона в тестах не пишется: фикстуры не обрастают .runz/runs. trace.test включает сам.
    // RUNZ_HOME — корень CLI: встроенные скрипты (template и др.) рантайм ищет здесь
    env: { RUNZ_TRACE: 'off', RUNZ_HOME: import.meta.dirname },
  },
})
