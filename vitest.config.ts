import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // All suites share one Postgres database and reset it, so files run one after another.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 300_000,
    hookTimeout: 300_000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5433/wallet_test',
      LLM_PROVIDER: 'mock',
    },
  },
});
