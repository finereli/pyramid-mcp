import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Each test uses a unique DO name, so per-test isolation isn't needed —
        // and isolatedStorage trips a known SQLite-DO storage-stack bug.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
