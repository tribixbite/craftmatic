import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@craft': path.resolve(__dirname, 'src'),
      '@ui': path.resolve(__dirname, 'web/src/ui'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/render/server.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
});
