/**
 * Production smoke test — catches "the deployed app renders nothing".
 *
 * The /ldraw-parts proxy was once a SILENT prod gap: the app deployed fine,
 * but without the Worker route every part fetch 404'd and the renderer
 * quietly fell back to voxelization (ROADMAP.md #5). These checks hit the
 * real production endpoints, so they only run when explicitly requested:
 *
 *   PROD_SMOKE=1 bun test test/prod-smoke.test.ts
 *
 * CI runs them post-deploy + daily via .github/workflows/prod-smoke.yml.
 */

import { describe, it, expect } from 'vitest';

const PROD = process.env['PROD_BASE'] ?? 'https://craftmatic.click';
const enabled = process.env['PROD_SMOKE'] === '1';

describe.skipIf(!enabled)('production smoke', () => {
  it('serves the app shell', async () => {
    const r = await fetch(`${PROD}/`, { signal: AbortSignal.timeout(15000) });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<div id="app"'); // app mount point
  });

  it('serves LDraw part geometry through the Worker proxy (the historic silent gap)', async () => {
    // 3001 = the canonical 2x4 brick; in every set since 1958.
    const r = await fetch(`${PROD}/ldraw-parts/parts/3001.dat`, { signal: AbortSignal.timeout(20000) });
    expect(r.status).toBe(200);
    const text = await r.text();
    // A real LDraw part file: header comment + type-1/3/4 lines.
    expect(text).toMatch(/^0\s/);
    expect(text).toMatch(/^1\s/m);
    // CORS must be present — the browser cannot use the proxy without it.
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('serves p/ primitives through the proxy (renderer needs both trees)', async () => {
    const r = await fetch(`${PROD}/ldraw-parts/p/stud.dat`, { signal: AbortSignal.timeout(20000) });
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(50);
  });

  it('serves OMR models through the Worker proxy', async () => {
    const r = await fetch(`${PROD}/ldraw-omr/10030-1.mpd`, { signal: AbortSignal.timeout(30000) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toMatch(/^0 FILE /im);
  });

  it('serves the bundled set catalog', async () => {
    const r = await fetch(`${PROD}/lego-catalog.json`, { signal: AbortSignal.timeout(20000) });
    expect(r.status).toBe(200);
    const cat = await r.json() as unknown;
    const items = Array.isArray(cat) ? cat : (cat as { sets?: unknown[] }).sets;
    expect(Array.isArray(items)).toBe(true);
    expect((items as unknown[]).length).toBeGreaterThan(10000);
  });
});
