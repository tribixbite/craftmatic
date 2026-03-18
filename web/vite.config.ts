import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, createReadStream } from 'node:fs';

// Path to clego's reconstructed LDR files (dev only)
const CLEGO_RECONSTRUCTED = 'C:/git/clego/lego_sets/Reconstructed';

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
          tiles3d: ['3d-tiles-renderer'],
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
  plugins: [
    {
      name: 'serve-clego-reconstructed',
      configureServer(server) {
        server.middlewares.use('/lego-reconstructed', (req, res, next) => {
          if (!existsSync(CLEGO_RECONSTRUCTED)) { next(); return; }
          const filename = (req.url ?? '').replace(/^\//, '').replace(/\.\./g, '');
          if (!filename) { next(); return; }
          const filePath = `${CLEGO_RECONSTRUCTED}/${filename}`;
          if (!existsSync(filePath)) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          createReadStream(filePath).pipe(res);
        });
      },
    },
  ],
  server: {
    port: 4000,
    open: true,
    proxy: {
      '/ldraw-omr': {
        target: 'https://library.ldraw.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ldraw-omr/, '/library/omr'),
      },
      // BFF inventory proxy — dev only, no token injection.
      // In prod the CF Worker handles the full server-side token exchange.
      '/bff/inventory': {
        target: 'https://api.prod.studio.bricklink.info',
        changeOrigin: true,
        rewrite: (path) => {
          const setNum = path.replace(/^\/bff\/inventory\//, '');
          return `/api/v1/info/set/${setNum}/inventory?breakMinifigures=true&breakParts=true&breakSubsets=true&includeVariants=true`;
        },
      },
    },
  },
});
