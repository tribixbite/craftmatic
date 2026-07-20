import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, createReadStream } from 'node:fs';

// Path to clego's reconstructed LDR files (dev only)
const CLEGO_RECONSTRUCTED = 'C:/git/clego/lego_sets/Reconstructed';
const CLEGO_LDR = 'C:/git/clego/lego_sets/LDR';
// Root of ALL clego model sources (OMR/, LDR/, IO/, LXF/, Reconstructed/, …).
// Served at /lego-models/ for the unified best-model index (dev only).
const CLEGO_MODELS_ROOT = 'C:/git/clego/lego_sets';
// Path to LDraw parts library (dev only — served at /ldraw-parts for geometry-accurate mode)
const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';

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
      name: 'serve-ldraw-parts',
      configureServer(server) {
        // FORCE_UPSTREAM: set true to bypass the local clego library and serve
        // ALL parts from library.ldraw.org — mirrors exactly what the deployed
        // CF Worker does, so production part coverage can be verified in dev.
        const FORCE_UPSTREAM = false;
        // In-memory cache of upstream fetches (path → Buffer|null). null = a
        // confirmed upstream 404, so we don't re-hit it.
        //
        // CRITICAL: only cache null on a DEFINITIVE miss (every upstream lib
        // returned a real HTTP response, none ok). A thrown fetch (timeout /
        // throttling during a big model's load burst) must NOT be cached —
        // that turned transient failures into permanently missing parts
        // (73111 etc. exist upstream but rendered as silent holes in dev).
        // Mirrors the browser-side fetchDatText transient/definitive split.
        const upstreamCache = new Map<string, Buffer | null>();
        // Cap concurrent upstream fetches so a 200-part burst doesn't get
        // throttled/refused by library.ldraw.org.
        const MAX_UPSTREAM = 6;
        let upstreamActive = 0;
        const upstreamQueue: (() => void)[] = [];
        const acquire = () => new Promise<void>(res => {
          if (upstreamActive < MAX_UPSTREAM) { upstreamActive++; res(); }
          else upstreamQueue.push(() => { upstreamActive++; res(); });
        });
        const release = () => { upstreamActive--; upstreamQueue.shift()?.(); };

        const fetchUpstream = async (urlPath: string): Promise<Buffer | null> => {
          if (upstreamCache.has(urlPath)) return upstreamCache.get(urlPath)!;
          let rest = urlPath;
          let libs = ['official', 'unofficial'];
          const unof = rest.match(/^unofficial\/(.*)$/i);
          if (unof) { rest = unof[1]; libs = ['unofficial']; }
          await acquire();
          try {
            let sawTransient = false;
            for (const lib of libs) {
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  const r = await fetch(`https://library.ldraw.org/library/${lib}/${rest}`, {
                    signal: AbortSignal.timeout(10000),
                  });
                  if (r.ok) {
                    const buf = Buffer.from(await r.arrayBuffer());
                    upstreamCache.set(urlPath, buf);
                    return buf;
                  }
                  break; // real HTTP response (404 etc.) — next lib, no retry
                } catch {
                  sawTransient = true;
                  if (attempt < 2) await new Promise(res => setTimeout(res, 250 * (attempt + 1)));
                }
              }
            }
            if (!sawTransient) upstreamCache.set(urlPath, null); // definitive miss only
            return null;
          } finally {
            release();
          }
        };

        server.middlewares.use('/ldraw-parts', (req, res, next) => {
          const urlPath = (req.url ?? '').replace(/^\//, '').replace(/\.\./g, '');
          if (!urlPath) { next(); return; }
          const localPath = `${LDRAW_ROOT}/${urlPath}`;
          const haveLocal = !FORCE_UPSTREAM && existsSync(LDRAW_ROOT) && existsSync(localPath);
          if (haveLocal) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            createReadStream(localPath).pipe(res);
            return;
          }
          // Local miss → fall back to the official/unofficial LDraw library
          // (same upstream the production Worker proxies).
          void fetchUpstream(urlPath).then(buf => {
            if (!buf) { res.statusCode = 404; res.end(); return; }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(req.method === 'HEAD' ? undefined : buf);
          });
        });
      },
    },
    {
      name: 'serve-clego-ldr',
      configureServer(server) {
        server.middlewares.use('/lego-sets', (req, res, next) => {
          if (!existsSync(CLEGO_LDR)) { next(); return; }
          const filename = decodeURIComponent((req.url ?? '').replace(/^\//, '')).replace(/\.\./g, '');
          if (!filename) { next(); return; }
          const filePath = `${CLEGO_LDR}/${filename}`;
          if (!existsSync(filePath)) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          createReadStream(filePath).pipe(res);
        });
      },
    },
    {
      // Unified model root: serves ANY file below C:/git/clego/lego_sets
      // (e.g. /lego-models/OMR/10001-1.mpd, /lego-models/LDR/10001%20Metro%20Liner.ldr).
      // Paths come from the unified index (web/public/lego-models-index.json).
      name: 'serve-clego-models',
      configureServer(server) {
        server.middlewares.use('/lego-models', (req, res, next) => {
          if (!existsSync(CLEGO_MODELS_ROOT)) { next(); return; }
          // Decode URL-encoded names (spaces, '#'…), strip query, block traversal.
          // decodeURIComponent throws URIError on malformed %-sequences → 400,
          // not an unhandled middleware exception.
          let rel: string;
          try {
            rel = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, '')).replace(/\.\./g, '');
          } catch {
            res.statusCode = 400; res.end(); return;
          }
          if (!rel) { next(); return; }
          const filePath = `${CLEGO_MODELS_ROOT}/${rel}`;
          if (!existsSync(filePath)) { res.statusCode = 404; res.end(); return; }
          // .io / .lxf are ZIP archives — must be served binary, not text.
          const isBinary = /\.(io|lxf|bin|zip)$/i.test(rel);
          res.setHeader('Content-Type', isBinary ? 'application/octet-stream' : 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          createReadStream(filePath).pipe(res);
        });
      },
    },
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
