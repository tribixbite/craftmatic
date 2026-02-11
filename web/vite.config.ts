import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          pako: ['pako'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@engine': resolve(__dirname, 'src/engine'),
      '@viewer': resolve(__dirname, 'src/viewer'),
      '@ui': resolve(__dirname, 'src/ui'),
      // Resolve craftmatic source modules for browser use
      '@craft': resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 4000,
    open: true,
  },
});
