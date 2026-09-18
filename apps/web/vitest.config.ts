import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Web unit suite.
 *
 * Deliberately a separate Vitest project from `apps/api`: that suite runs
 * sequentially against a shared PostgreSQL database (see the root
 * `vitest.workspace.ts`), while this one is pure jsdom with no network. Keeping
 * them apart means `vitest run` from `apps/web` never inherits the API's
 * `fileParallelism: false` database contract, and vice versa.
 *
 * Tests live beside the code they cover, so `include` is scoped to `src/**`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
