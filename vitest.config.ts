import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server bundle targets Node; tests run in the same environment.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
