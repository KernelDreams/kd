import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    // file:-зависимости — симлинки: резолвить по пути ссылки, не по реальному.
    preserveSymlinks: true,
  },
})
