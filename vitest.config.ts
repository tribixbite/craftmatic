import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';

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
    },
  },
  test: {
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
