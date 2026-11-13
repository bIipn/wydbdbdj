import { defineConfig } from 'vitest/config';

export default defineConfig({
  // hookTimeout: opening the embedded database in beforeAll is slow when several suites run at once.
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
