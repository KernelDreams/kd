import { defineConfig, devices } from '@playwright/test'

/**
 * Живые приёмки виджета: статика пакета на 7820 (другой origin, чем
 * бэкенды), стенды nr 7800 и ACP 7811 уже подняты (`chat status`); временный
 * стенд с `$auth_key` тест поднимает сам. Модели — живые: секунды до минут.
 */
export const STATIC = process.env.NR_CHAT_STATIC ?? 'http://127.0.0.1:7820'
export const NR_BACKEND = process.env.NR_CHAT_BACKEND ?? 'http://127.0.0.1:7800/api'
export const ACP_BACKEND = process.env.NR_CHAT_ACP ?? 'ws://127.0.0.1:7811/acp'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 120_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: { baseURL: STATIC, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/serve-static.mjs 7820', url: `${STATIC}/demo/index.html`, reuseExistingServer: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
