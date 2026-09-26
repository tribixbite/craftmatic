import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { existsSync } from 'fs';

// The local copy of the prod part mirror (clego's `ldraw_ref/`), when this
// machine has it: tests needing post-2020 parts then read the disk instead of
// the network (ldraw-geometry.ts `probeMirror`, `CRAFTMATIC_LDRAW_REF`).
const LDRAW_REF = process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/ldraw_ref';
// The mirror's answers cached on disk (ldraw-geometry.ts `mirrorCacheRead`):
// a corpus test then asks the network for a part once, not on every run.
const LDRAW_MIRROR_CACHE = process.env.CRAFTMATIC_LDRAW_MIRROR_CACHE ?? path.resolve(__dirname, 'output/ldraw-mirror-cache');

// Live-network integration tests hit real external APIs (OSM Overpass,
// Nominatim, Parcl, the LDraw OMR). They're valuable but FLAKY — an upstream
// 429/timeout would otherwise fail CI and, worse, BLOCK the production deploy
// (deploy.yml runs `bun run test`). So they're excluded from the default run
// and gated behind `RUN_LIVE_TESTS=1` (see `bun run test:live`). The
// deterministic offline suites fully cover our own code.
const LIVE_TESTS = [
  'test/import-osm-live.test.ts',
  'test/import-osm-trees.test.ts',
  'test/import-water.test.ts',
  'test/parcl-osm-pipeline.test.ts',
  'test/lego-pipeline.test.ts',
  'test/import-overture.test.ts', // S3-hosted PMTiles archive
];

export default defineConfig({
  resolve: {
    alias: {
      '@craft': path.resolve(__dirname, 'src'),
      '@ui': path.resolve(__dirname, 'web/src/ui'),
      '@engine': path.resolve(__dirname, 'web/src/engine'),
      '@viewer': path.resolve(__dirname, 'web/src/viewer'),
    },
  },
  test: {
    // With the local copy present the suite is OFFLINE: everything the mirror
    // serves is on this machine (Studio's library + `ldraw_ref/`), so no test
    // waits on prod. The 10303 tests "needed" the mirror only because the local
    // lookup skipped `UnOfficial/parts/s/` and a null mirror skipped `ldraw_ref/`
    // (both fixed 2026-09-26). Without the copy (CI), answers are cached on disk.
    env: { ...(existsSync(LDRAW_REF) ? { CRAFTMATIC_LDRAW_REF: LDRAW_REF, CRAFTMATIC_LDRAW_MIRROR: process.env.CRAFTMATIC_LDRAW_MIRROR ?? 'off' } : {}), CRAFTMATIC_LDRAW_MIRROR_CACHE: LDRAW_MIRROR_CACHE },
    include: ['test/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      ...(process.env['RUN_LIVE_TESTS'] ? [] : LIVE_TESTS),
    ],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/render/server.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
});
