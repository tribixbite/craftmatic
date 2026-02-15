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
    testTimeout: 30000,
  },
});
