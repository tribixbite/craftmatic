/**
 * Headless probe of the REAL app's LEGO tab: load a set, then
 *  (a) prove whether explode state can displace an assembled model (audit P0 #2
 *      bullet 1) by diffing live instance matrices against the saved assembled
 *      matrices at explode 0, and again after 0 -> 100 -> 0;
 *  (b) dump every instance's world position + part id so the render can be
 *      compared numerically against the source file offline;
 *  (c) capture canvas PNGs from fixed cameras for the visual record.
 *
 * node lego-probe.mjs <set|file:ABSPATH> <outDir> [label]
 * Prints JSON only — no page snapshots.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , target, outDir, label = 'probe'] = process.argv;
if (!target || !outDir) {
  console.error('usage: node lego-probe.mjs <set|file:ABSPATH> <outDir> [label]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 300)}`));

await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
// Activate the LEGO tab — the hash alone does not switch panels.
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
});
await page.waitForTimeout(1500);

// Force continuous rendering so screenshots always have a fresh frame
// (on-demand rendering + a backgrounded tab otherwise times out the capture).
await page.evaluate(() => {
  const cb = document.getElementById('lego-stats');
  if (cb && !cb.checked) cb.click();
});

if (target.startsWith('file:')) {
  const abs = target.slice(5);
  if (!existsSync(abs)) { console.error(`no such file: ${abs}`); process.exit(1); }
  await page.setInputFiles('#lego-mpd-input', abs);
} else {
  const clicked = await page.evaluate(async set => {
    const input = document.getElementById('lego-search');
    input.value = set;
    document.getElementById('lego-search-btn').click();
    await new Promise(r => setTimeout(r, 2500));
    const card = [...document.querySelectorAll('.lego-result-card')]
      .find(c => new RegExp(set).test(c.textContent));
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  }, target);
  if (clicked !== 'clicked') { console.error(`search failed: ${clicked}`); process.exit(1); }
}

// Wait for the viewer to report a loaded model.
const deadline = Date.now() + 240_000;
let bricks = 0;
while (Date.now() < deadline) {
  bricks = await page.evaluate(() => {
    const v = window.__ldrawViewer;
    if (!v || !v.loaded) return 0;
    let n = 0;
    for (const s of v.stepGroups.values()) {
      s.group.traverse(o => { if (o.isInstancedMesh) n += (o.userData.originalMatrices?.length ?? 0); });
    }
    return n;
  });
  if (bricks > 0) break;
  await page.waitForTimeout
    ? await page.waitForTimeout(2000) : null;
}

const probe = await page.evaluate(async () => {
  const v = window.__ldrawViewer;
  if (!v) return { error: 'no viewer' };
  const THREE = v.THREE ?? null;

  /** max |live matrix - saved assembled matrix| over every instance. */
  const diffToOriginals = () => {
    let max = 0, n = 0, meshes = 0;
    const live = new Array(16), want = new Array(16);
    for (const s of v.stepGroups.values()) {
      s.group.traverse(o => {
        if (!o.isInstancedMesh) return;
        const orig = o.userData.originalMatrices;
        if (!orig) return;
        if (o.userData.mirrorOf) return;          // mirror clones share buffers
        meshes++;
        for (let i = 0; i < orig.length; i++) {
          const a = o.instanceMatrix.array;
          for (let k = 0; k < 16; k++) {
            live[k] = a[i * 16 + k];
            want[k] = orig[i].elements[k];
            const d = Math.abs(live[k] - want[k]);
            if (d > max) max = d;
          }
          n++;
        }
      });
    }
    return { maxAbsDelta: max, instances: n, meshes };
  };

  /** world positions + part ids, straight out of the live instance matrices. */
  const dump = () => {
    const out = [];
    for (const s of v.stepGroups.values()) {
      s.group.traverse(o => {
        if (!o.isInstancedMesh || o.userData.mirrorOf) return;
        const a = o.instanceMatrix.array;
        const cnt = o.userData.originalMatrices?.length ?? 0;
        for (let i = 0; i < cnt; i++) {
          out.push([o.userData.partName ?? o.name ?? '?',
                    +a[i * 16 + 12].toFixed(3), +a[i * 16 + 13].toFixed(3), +a[i * 16 + 14].toFixed(3)]);
        }
      });
    }
    return out;
  };

  const slider = document.getElementById('lego-explode-slider');
  const at0 = diffToOriginals();
  v.setExplodeFactor(1.0);
  const at100 = diffToOriginals();
  v.setExplodeFactor(0);
  const back0 = diffToOriginals();

  return {
    bricks: at0.instances,
    meshes: at0.meshes,
    sliderValue: slider ? slider.value : null,
    explodeZeroMaxDelta: at0.maxAbsDelta,
    explodeFullMaxDelta: at100.maxAbsDelta,
    returnToZeroMaxDelta: back0.maxAbsDelta,
    missingParts: (v.missingParts ?? []).length,
    substitutedParts: [...(v.substitutedParts ?? new Map()).entries?.() ?? []].slice(0, 40),
    unresolvedSubparts: [...(v.unresolvedSubparts ?? [])].slice(0, 40),
    status: document.getElementById('lego-status')?.textContent?.slice(-900) ?? null,
    positions: dump(),
  };
});

const positions = probe.positions ?? [];
delete probe.positions;
writeFileSync(join(outDir, `${label}-probe.json`), JSON.stringify(probe, null, 1));
writeFileSync(join(outDir, `${label}-positions.json`), JSON.stringify(positions));

// Fixed-camera captures for the visual record.
const canvas = await page.$('#lego-viewer canvas') ?? await page.$('canvas');
if (!canvas) console.error('no canvas found — skipping captures');
for (const view of canvas ? ['iso', 'front', 'left'] : []) {
  await page.evaluate(vw => {
    const v = window.__ldrawViewer;
    if (v) { v.setView(vw); }
  }, view);
  await page.waitForTimeout(2800);
  await page.evaluate(() => { window.__ldrawViewer?.composer?.render(); });
  let shot = false;
  for (let attempt = 0; attempt < 4 && !shot; attempt++) {
    try {
      await canvas.screenshot({ path: join(outDir, `${label}-${view}.png`), timeout: 25000 });
      shot = true;
    } catch (e) {
      await page.waitForTimeout(1800);
      if (attempt === 3) console.error(`capture ${view} failed: ${String(e).slice(0, 160)}`);
    }
  }
}

console.log(JSON.stringify({ target, label, bricks, errors: errors.slice(0, 8), ...probe }, null, 1));
await browser.close();
