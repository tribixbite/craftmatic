#!/usr/bin/env node
/**
 * Load-performance BASELINE for a big set (audit P2, "keep performance
 * measurable"). Records numbers; changes nothing and optimises nothing.
 *
 * What it measures, and why each is trustworthy here:
 *   • cold vs warm load time — a fresh browser profile (empty IndexedDB) versus
 *     the same profile loading the same set again. The persistent .dat cache is
 *     the whole point of the comparison.
 *   • /ldraw-parts request count, split batch vs individual — the cold-load
 *     bottleneck is round-trips, not bytes (a cold UCS Falcon once took 4+ min
 *     at ~8 candidate probes per part).
 *   • geometry coverage — placements rendered, missing part types, substituted
 *     moulds. A load that got fast by resolving less is not faster.
 *   • explicit composite time — N forced `composer.render()` calls, timed.
 *     Deliberately NOT frames-per-second: an automation tab is backgrounded, so
 *     rAF is throttled and any fps figure from it would be fiction. This
 *     measures the cost of producing a frame, which is the part that regresses.
 *   • renderer.info — draw calls, triangles, geometries, textures.
 *   • JS heap (Chrome's performance.memory, an estimate).
 *
 * A mobile-PROFILE pass (touch + 390x844 viewport → the viewer's IS_MOBILE
 * path: pixel ratio ≤1.5, 1024² shadows, no SAO, tighter edge budget) is run
 * too. It exercises the mobile code path on desktop silicon — it is NOT a
 * device measurement and must never be quoted as phone fps.
 *
 *   bun dev:web                                   # port 4000
 *   node scripts/lego-perf-baseline.mjs [--set 10316-1] [--out DIR]
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';
const SET = flag('--set', '10316-1');
const OUT = flag('--out', join('output', 'visual-fixtures', new Date().toISOString().slice(0, 10)));
const FRAMES = 60;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { generated: new Date().toISOString(), set: SET, dev: DEV, runs: [] };

// Desktop: one context, two loads — the second is warm on BOTH the module-level
// caches and IndexedDB, which is what a returning visitor actually gets.
const desktop = await browser.newContext({ viewport: { width: 1400, height: 950 } });
report.runs.push(await measure(desktop, 'desktop-cold', true));
report.runs.push(await measure(desktop, 'desktop-warm', false));
await desktop.close();

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
report.runs.push(await measure(mobile, 'mobile-profile-cold', true));
await mobile.close();

writeFileSync(join(OUT, 'perf-baseline.json'), JSON.stringify(report, null, 1));
await browser.close();
for (const r of report.runs) {
  console.log(`${r.label.padEnd(20)} load ${String(r.loadMs).padStart(6)} ms · `
    + `${r.requests.batch} batch + ${r.requests.individual} individual part requests · `
    + `${r.placements ?? '?'} placements, ${r.missing ?? '?'} missing · `
    + (r.viewerHook
      ? `composite ${r.compositeMsPerFrame} ms/frame (min ${r.compositeMsPerFrameMin}) · `
        + `${r.renderer.calls} draw calls, ${(r.renderer.triangles / 1e6).toFixed(2)} M tris · `
        + `heap ${r.heapMB} MB · ${r.glRenderer}`
      : '(deployed build — no dev viewer hook, in-page stats unavailable)'));
}
console.log(`\n${join(OUT, 'perf-baseline.json')}`);

/**
 * One load, timed. `fresh` opens a NEW page (cold module caches) and clears
 * IndexedDB first, so "cold" really is cold.
 */
async function measure(context, label, fresh) {
  const page = await context.newPage();
  const requests = { batch: 0, individual: 0, rev: 0, model: 0 };
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/ldraw-parts/_batch')) requests.batch++;
    else if (u.includes('/ldraw-parts/_rev')) requests.rev++;
    else if (u.includes('/ldraw-parts/')) requests.individual++;
    else if (u.includes('/lego-models/')) requests.model++;
  });

  await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
  if (fresh) {
    await page.evaluate(async () => {
      // Clear the persistent part cache so the cold number is honest.
      await new Promise(res => {
        const rq = indexedDB.deleteDatabase('craftmatic-ldraw');
        rq.onsuccess = rq.onerror = rq.onblocked = () => res();
      });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    requests.batch = requests.individual = requests.rev = requests.model = 0;
  }
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
  });
  await page.waitForTimeout(1200);

  const t0 = Date.now();
  const hit = await page.evaluate(async set => {
    const input = document.getElementById('lego-search');
    input.value = set;
    document.getElementById('lego-search-btn').click();
    await new Promise(r => setTimeout(r, 2000));
    const card = [...document.querySelectorAll('.lego-result-card')]
      .find(c => c.querySelector('.lego-result-num')?.textContent.trim() === set);
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  }, SET);
  if (hit !== 'clicked') throw new Error(`no card for ${SET}`);
  // The 2 s the search box is given above is dead time, not load time.
  const clickAt = Date.now();

  // `window.__ldrawViewer` is a DEV-ONLY hook (viewer.ts sets it under
  // import.meta.env.DEV), so against a deployed build the status line is the
  // only completion signal — and the in-page statistics below are unavailable.
  // Reporting them as null beats reporting a guess.
  const deadline = Date.now() + 420_000;
  let loadedAt = null;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const rendered = /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '');
      const v = window.__ldrawViewer;
      return v ? (!!v.loaded && rendered && !(v.warp?.running)) : rendered;
    });
    if (done) { loadedAt = Date.now(); break; }
    await page.waitForTimeout(250);
  }
  if (!loadedAt) throw new Error(`${label}: never finished loading`);
  const hasHook = await page.evaluate(() => !!window.__ldrawViewer);
  if (!hasHook) {
    const status = await page.evaluate(() => document.getElementById('lego-status')?.textContent?.slice(-220) ?? null);
    await page.close();
    return {
      label, loadMs: loadedAt - clickAt, searchOverheadMs: clickAt - t0, requests,
      viewerHook: false, status,
      note: 'deployed build: no dev viewer hook, so placements/renderer/composite/heap are not measurable here',
      placements: null, instances: null, missing: null, substituted: null,
      compositeMsPerFrame: null, compositeMsPerFrameMin: null, glRenderer: null,
      renderer: { calls: null, triangles: null, geometries: null, textures: null }, heapMB: null,
    };
  }

  const stats = await page.evaluate(async frames => {
    const v = window.__ldrawViewer;
    let placements = 0, instances = 0;
    for (const s of v.stepGroups.values()) {
      s.group.traverse(o => {
        if (!o.isInstancedMesh || o.userData.mirrorOf) return;
        const n = o.userData.originalMatrices?.length ?? 0;
        instances += n;
        if (o.userData.primary) placements += n;
      });
    }
    // Forced composites: measures the cost of a frame without depending on
    // rAF, which a backgrounded automation tab throttles into meaninglessness.
    // Three batches, MEDIAN reported and MIN kept: a single batch on a loaded
    // box swings by 3x, and a swing that large is evidence about the machine,
    // not the code.
    v.composer.render();                      // warm shaders/uploads first
    await new Promise(r => setTimeout(r, 300));
    const batches = [];
    for (let b = 0; b < 3; b++) {
      const t = performance.now();
      for (let i = 0; i < frames; i++) v.composer.render();
      batches.push((performance.now() - t) / frames);
      await new Promise(r => setTimeout(r, 200));
    }
    batches.sort((x, y) => x - y);

    // renderer.info.render is reset at the START of every renderer.render()
    // call while autoReset is on, so reading it after a composer pass reports
    // only that pass's fullscreen quad. Disable, reset, render ONE frame, read.
    const info = v.renderer.info;
    const priorAutoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    v.composer.render();
    const snapshot = {
      calls: info.render.calls, triangles: info.render.triangles,
      geometries: info.memory.geometries, textures: info.memory.textures,
    };
    info.autoReset = priorAutoReset;

    // Which GL implementation actually drew this. Headless Chrome commonly
    // falls back to SwiftShader (software), whose timings are comparable
    // run-to-run on one box and meaningless as absolutes.
    let glRenderer = null;
    try {
      const gl = v.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { /* no debug info — reported as null */ }

    return {
      placements, instances,
      compositeMsPerFrame: +batches[1].toFixed(2),
      compositeMsPerFrameMin: +batches[0].toFixed(2),
      compositeBatches: batches.map(x => +x.toFixed(2)),
      glRenderer,
      renderer: snapshot,
      missing: (v.missingParts ?? []).length,
      substituted: (v.substitutedParts ?? []).length,
      edgesDropped: !!v.edgesDroppedForSize,
      pixelRatio: v.renderer.getPixelRatio(),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      status: document.getElementById('lego-status')?.textContent?.slice(-220) ?? null,
    };
  }, FRAMES);

  await page.close();
  return { label, loadMs: loadedAt - clickAt, searchOverheadMs: clickAt - t0, requests, viewerHook: true, ...stats };
}
