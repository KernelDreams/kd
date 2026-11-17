import { defineConfig } from 'vitest/config'

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
  },
})
