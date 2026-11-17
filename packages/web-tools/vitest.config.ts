import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Смоук поднимает настоящую pi и ждёт её RPC — 15 s юнит-дефолта мало.
    testTimeout: 60_000,
  },
})
