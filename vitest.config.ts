import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Fails a test file that leaves a database open: the mistake Windows punishes and Linux forgives.
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
