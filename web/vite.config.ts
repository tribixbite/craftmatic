import { defineConfig } from 'vite';
import { resolve } from 'path';

/** Build-time version string: v2026.02.20 */
const appVersion = `v${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`;

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
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
