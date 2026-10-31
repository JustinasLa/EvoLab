import { defineConfig } from 'vitest/config';

// Separate discovery leaves the mandatory unit/coverage suite unchanged.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/long-run/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
