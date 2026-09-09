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

  // ── The production PATH, not just its endpoints (audit P2) ────────────────
  // The audit's finding was that "the app rendered" is not evidence: the two
  // reported defects both came from assets that were served, fine, and wrong.
  // These exercise the specific assets whose ABSENCE is silent.

  it('serves BOTH LDD alignment tables (the measured one is fix-critical for 71043)', async () => {
    // `/ldd-part-map.json` is the ldraw.xml-derived table; `/ldd-measured-align.json`
    // is the MEASURED one shipped 2026-09-09. Held out against authentic Studio
    // truth, the measured table took geometric agreement from 7.15 % to 72.70 %
    // — so a 404 here is not a degradation, it is 71043 rendering as a pile.
    // Both are static assets, i.e. they are absent on the Pages mirror by
    // construction and present only on the supported deployment.
    for (const [asset, minEntries] of [['/ldd-part-map.json', 4000], ['/ldd-measured-align.json', 100]] as const) {
      const r = await fetch(`${PROD}${asset}`, { signal: AbortSignal.timeout(20000) });
      expect(r.status, `${asset} must be served`).toBe(200);
      const table = await r.json() as Record<string, unknown>;
      expect(Object.keys(table).length, `${asset} entry count`).toBeGreaterThan(minEntries);
    }
  });

  it('serves a model through the WORKER route with the index-recorded hash', async () => {
    // Distinct from the r2.dev check above: prod's MODELS_BASE is the
    // same-origin worker route, and it is the one that decodes `#`/`%` before
    // the R2 lookup. Schema 2 gives every entry a sha256/12, so "are the
    // deployed bytes the ones the index describes?" is now answerable — the
    // index's grade, lineage and defect list describe THAT file, not the path.
    const idx = await fetch(`${PROD}/lego-models-index.json`, { signal: AbortSignal.timeout(30000) });
    expect(idx.status).toBe(200);
    const data = await idx.json() as LegoIndexShape;
    const entry = Object.values(data.sets).find(e => e.models.some(m => m.hash));
    expect(entry, 'a schema-2 index must carry per-file hashes').toBeTruthy();
    const model = entry!.models.find(m => m.hash)!;
    const r = await fetch(`${PROD}/lego-models/${model.path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(30000) });
    expect(r.status, `worker route for ${model.path}`).toBe(200);
    const buf = await r.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(500);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hash12 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    expect(hash12, `deployed ${model.path} must be the file the index describes`).toBe(model.hash);
  });

  it('declares the index schema and its measured-assembly provenance', async () => {
    const r = await fetch(`${PROD}/lego-models-index.json`, { signal: AbortSignal.timeout(30000) });
    const data = await r.json() as LegoIndexShape;
    expect(data.generated, 'index generation date').toBeTruthy();
    expect(data.schema ?? 1, 'schema 2 = per-file hash/asm/sev metadata').toBeGreaterThanOrEqual(2);
    // `geograde` carries the verification date + thresholds behind `asm`. Its
    // absence would mean every entry reports 'unverified', which is a real
    // degradation of the source ranking even though nothing visibly breaks.
    expect(data.geograde, 'measured-assembly provenance').toBeTruthy();
  });

  it('resolves a part AND every sub-file it references (recursive load)', async () => {
    // A part is a tree: 3001 pulls studs, boxes and edges out of `p/`. The
    // renderer resolves those recursively, and a sub-file that resolves nowhere
    // is a SILENT hole — the parent still renders, just with gaps. One level of
    // that tree is checked here through the real candidate-path ladder.
    const root = await fetch(`${PROD}/ldraw-parts/parts/3001.dat`, { signal: AbortSignal.timeout(20000) });
    expect(root.status).toBe(200);
    const refs = [...new Set([...(await root.text()).matchAll(/^1\s+\S+(?:\s+\S+){12}\s+(\S+)\s*$/gm)]
      .map(m => m[1]!.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/, '')))];
    expect(refs.length, '3001 must reference sub-files at all').toBeGreaterThan(0);
    for (const ref of refs) {
      const stem = ref.split('/').pop()!;
      const candidates = ref.includes('/')
        ? [`p/${ref}.dat`, `parts/${ref}.dat`]
        : [`p/${stem}.dat`, `parts/${stem}.dat`, `parts/s/${stem}.dat`, `p/48/${stem}.dat`];
      let hit = false;
      for (const c of candidates) {
        const rr = await fetch(`${PROD}/ldraw-parts/${c}`, { signal: AbortSignal.timeout(20000) });
        if (rr.status === 200 && (await rr.text()).length > 10) { hit = true; break; }
      }
      expect(hit, `sub-file ${ref} of 3001 resolves nowhere → a silent hole in every brick`).toBe(true);
    }
  });

  it('records app, index and library revisions together', async () => {
    // The audit's ask: these three move independently, and a defect report that
    // names only one of them is not reproducible. Printed as one record.
    const html = await (await fetch(`${PROD}/`, { signal: AbortSignal.timeout(15000) })).text();
    // The build's entry bundle — a content fingerprint of the deployed app.
    // NOT a git commit: vite's __APP_VERSION__ is only a build DATE, and this
    // filename hash is the closest identifier the deployment actually exposes.
    const bundle = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? null;
    const idx = await (await fetch(`${PROD}/lego-models-index.json`, { signal: AbortSignal.timeout(30000) })).json() as LegoIndexShape;
    const revResp = await fetch(`${PROD}/ldraw-parts/_rev`, { signal: AbortSignal.timeout(20000) });
    // 404 is a SUPPORTED answer until the weekly sync has published a stamp
    // (scripts/sync-ldraw-r2.mjs); the client treats an unknown revision as
    // "keep the cache", never as "the library changed". Once a stamp exists
    // this can tighten to `toBe(200)`.
    expect([200, 404]).toContain(revResp.status);
    const rev = revResp.status === 200 ? (await revResp.json() as { rev?: string }) : null;
    if (rev) expect(typeof rev.rev, '_rev must carry a string revision').toBe('string');
    console.log('[prod-smoke] deployment revisions: ' + JSON.stringify({
      appBundle: bundle,
      indexGenerated: idx.generated,
      indexSchema: idx.schema ?? 1,
      geogradeGenerated: idx.geograde?.generated ?? null,
      libraryRevision: rev?.rev ?? '(no /ldraw-parts/_rev stamp yet)',
    }));
    expect(bundle, 'the app shell must reference a hashed entry bundle').toBeTruthy();
  });
});

interface LegoIndexShape {
  generated: string;
  schema?: number;
  geograde?: { generated?: string };
  sets: Record<string, { models: { path: string; hash?: string }[] }>;
}
