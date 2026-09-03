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

  it('serves the model corpus index + a model from R2 (prod search→load path)', async () => {
    // Prod loads indexed models from the public R2 bucket (see MODELS_BASE in
    // lego.ts). If this breaks, search → pick silently degrades for ~10k sets.
    const R2 = 'https://pub-02c7ef4c74d5445691176fe4b4455d50.r2.dev';
    const idx = await fetch(`${R2}/lego-models-index.json`, { signal: AbortSignal.timeout(30000) });
    expect(idx.status).toBe(200);
    const data = await idx.json() as { sets: Record<string, { models: { path: string }[] }> };
    expect(Object.keys(data.sets).length).toBeGreaterThan(5000);
    // Fetch the first model of a known-indexed set, with CORS for the browser.
    const model = data.sets['8849']?.models[0];
    expect(model).toBeTruthy();
    const r = await fetch(`${R2}/models/${model!.path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { Origin: PROD },
      signal: AbortSignal.timeout(30000),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy();
    expect((await r.text()).length).toBeGreaterThan(1000);
  });

  // ── `#` in a filename: prod-only, invisible until someone looks ──────────
  // A `#` is a URL FRAGMENT delimiter, so every hop has to agree on encoding:
  // the client sends %23, the worker decodes before the R2 lookup, and the
  // SYNC must percent-encode the key it PUTs. `wrangler r2 object put` does
  // NOT — it truncated `…/31378_step #cr.ldr` to `…/31378_step ` on upload
  // (and read it back the same way, so the CLI reported success), killing 96
  // index paths / 20 sets / 9 primary picks in prod while dev served them
  // fine. Both trees really do contain such names, so both are asserted.
  it('serves a model whose filename contains "#" (worker decode + sync encoding agree)', async () => {
    const idx = await fetch(`${PROD}/lego-models-index.json`, { signal: AbortSignal.timeout(30000) });
    expect(idx.status).toBe(200);
    const data = await idx.json() as { sets: Record<string, { models: { path: string }[] }> };
    const hashPath = Object.values(data.sets)
      .flatMap(e => e.models.map(m => m.path))
      .find(p => p.includes('#'));
    if (!hashPath) return; // corpus may sanitise these names one day — not a failure
    const r = await fetch(`${PROD}/lego-models/${hashPath.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(30000) });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^1\s/m); // real geometry, not an error body
  });

  it('serves the one library part whose filename contains "#" (p/box3#8p.dat)', async () => {
    const r = await fetch(`${PROD}/ldraw-parts/p/box3%238p.dat`, { signal: AbortSignal.timeout(20000) });
    expect(r.status).toBe(200);
    expect((await r.text())).toMatch(/^\s*[0-9]/);
  });
});
