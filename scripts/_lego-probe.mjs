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

/**
 * Boot budget for the app shell + the lazily-imported LEGO panel. Dev serves
 * unbundled modules from a warm vite cache; production has to fetch, parse and
 * execute hashed chunks off the CDN, so the same fixed 3.5 s wait that was fine
 * locally was not a safe bound there. Every wait below is on a real condition —
 * this is only the ceiling before we give up. Override with PROBE_BOOT_MS.
 */
const BOOT_MS = Number(process.env.PROBE_BOOT_MS ?? 60_000);
/** Ceiling for the search request + result cards to appear. */
const SEARCH_MS = Number(process.env.PROBE_SEARCH_MS ?? 45_000);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// `serviceWorkers: 'block'` is REQUIRED, not hygiene. The PWA service worker
// installs on first load and then intercepts `/lego-models/*`; in a fresh
// automation context those fetches come back `net::ERR_FAILED`, the loader
// walks the whole source ladder and ends at "No 3D model found — trying BL
// parts inventory", which reads exactly like a missing model. Search mode was
// unusable this way while `file:` mode (no network fetch for the model) worked,
// so the failure looked like a bug in the index. Measured 2026-09-17.
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
const failedRequests = new Set();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
// Request-level failures, which the console only ever reports as the useless
// "Failed to load resource". Cloudflare's own analytics beacon is excluded: it
// fails with net::ERR_ADDRESS_INVALID on every production page load (the
// injected src carries a bare version token, not a real path) and has nothing
// to do with the app. That one line was the red herring that made a healthy
// production load look like a network fault. Measured 2026-09-18.
const BENIGN_REQUEST_FAILURE = /static\.cloudflareinsights\.com/;
page.on('requestfailed', r => {
  if (BENIGN_REQUEST_FAILURE.test(r.url())) return;
  failedRequests.add(`${r.failure()?.errorText ?? 'failed'} ${r.url().slice(0, 160)}`);
});

// ── Production debug hook ────────────────────────────────────────────────────
// `window.__ldrawViewer` is assigned behind `import.meta.env.DEV`, so Vite
// CONSTANT-FOLDS the whole block away in a production build: on craftmatic.click
// the model renders perfectly and the probe still reported `{"bricks":0,
// "error":"no viewer"}`, because the handle simply does not exist there.
//
// Rather than ship a debug global to users, re-enable it in the bytes the
// browser is about to run: the deployed viewer chunk contains the statement
// `this.loaded=!0,this.requestShadowUpdate(),this.container.dataset.brickCount=…`
// exactly once, so prefixing the assignment with `globalThis.__ldrawViewer=this,`
// restores the same handle at the same point in the load. NOTHING else is
// touched — part resolution, geometry and colour all run the deployed code, so
// the numbers this probe reports are the numbers real users get.
// Dev is unaffected: vite serves /src/*.ts, never /assets/*.js, so the glob
// never matches and the already-present dev hook is used as before.
const PROD_HOOK_ANCHOR = 'this.container.dataset.brickCount=';
let prodHookPatched = false;
await page.route('**/assets/*.js', async route => {
  const resp = await route.fetch();
  let body = await resp.text();
  if (body.includes(PROD_HOOK_ANCHOR)) {
    body = body.replace(PROD_HOOK_ANCHOR, `globalThis.__ldrawViewer=this,${PROD_HOOK_ANCHOR}`);
    prodHookPatched = true;
  }
  const headers = { ...resp.headers() };
  // The fetched body is already decoded; keeping the original encoding/length
  // headers would make the browser try to inflate plain text.
  delete headers['content-encoding'];
  delete headers['content-length'];
  await route.fulfill({ status: resp.status(), headers, body });
});

await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
// Activate the LEGO tab — the hash alone does not switch panels. Wait for the
// nav to actually exist rather than guessing at a boot time.
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'LEGO'),
  null, { timeout: BOOT_MS });
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
});
// The LEGO panel is a lazily-imported chunk; its search box is the signal that
// the module has executed and bound its handlers.
await page.waitForSelector('#lego-search', { state: 'attached', timeout: BOOT_MS });
await page.waitForSelector('#lego-search-btn', { state: 'attached', timeout: BOOT_MS });

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
  // The panel fires its own browse-all search on init and DISABLES the search
  // button for the duration. Clicking a disabled button is a silent no-op, so
  // the query never ran and the probe then scanned the browse-all cards and
  // reported `no-card (cards=48)`. Wait for that first search to finish.
  await page.waitForFunction(
    () => {
      const b = document.getElementById('lego-search-btn');
      return !!b && !b.disabled;
    }, null, { timeout: SEARCH_MS });
  await page.evaluate(set => {
    const input = document.getElementById('lego-search');
    input.value = set;
    document.getElementById('lego-search-btn').click();
  }, target);
  // Wait for this query's own results: the button re-enables only in doSearch's
  // finally, so "enabled again AND a card naming the set" cannot be satisfied by
  // the leftover browse-all list. Production fetches the 10k-set index over the
  // network first, so a fixed sleep here was a race. Only `.lego-result-card`
  // elements are click targets.
  await page.waitForFunction(
    set => {
      const b = document.getElementById('lego-search-btn');
      if (!b || b.disabled) return false;
      return [...document.querySelectorAll('.lego-result-card')]
        .some(c => new RegExp(set).test(c.textContent ?? ''));
    },
    target, { timeout: SEARCH_MS }).catch(() => {});
  const clicked = await page.evaluate(set => {
    const card = [...document.querySelectorAll('.lego-result-card')]
      .find(c => new RegExp(set).test(c.textContent));
    if (!card) return `no-card (cards=${document.querySelectorAll('.lego-result-card').length})`;
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
  const settled = bricks > 0 && await page.evaluate(() =>
    /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '')
    && !(window.__ldrawViewer?.warp?.running));
  if (settled) { await page.waitForTimeout(2500); break; }
  await page.waitForTimeout(2000);
}

const probe = await page.evaluate(async () => {
  const v = window.__ldrawViewer;
  if (!v) return {
    error: 'no viewer',
    // Distinguish "the model never loaded" from "the model loaded but the
    // debug handle is missing" — they need opposite fixes.
    brickCountAttr: document.querySelector('[data-brick-count]')?.dataset?.brickCount ?? null,
    status: document.getElementById('lego-status')?.textContent?.slice(-900) ?? null,
  };
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
    // The NAMES matter as much as the count: a part that silently fails to
    // resolve (e.g. a deep `~Moved to` chain) is invisible in a bare count.
    missingPartsList: (v.missingParts ?? []).slice(0, 40),
    substitutedParts: [...(v.substitutedParts ?? new Map()).entries?.() ?? []].slice(0, 40),
    unresolvedSubparts: [...(v.unresolvedSubparts ?? [])].slice(0, 40),
    status: document.getElementById('lego-status')?.textContent?.slice(-900) ?? null,
    positions: dump(),
  };
});

const positions = probe.positions ?? [];
delete probe.positions;
probe.origin = DEV;
probe.prodHookPatched = prodHookPatched;
probe.failedRequests = [...failedRequests].slice(0, 12);
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

// Optional close-ups: PROBE_VIEWS='[{"name":"tower","pos":[x,y,z],"target":[x,y,z]}]' in
// scene units (1 stud = 1 unit, Y up), applied straight to the camera + orbit target.
const extra = process.env.PROBE_VIEWS ? JSON.parse(process.env.PROBE_VIEWS) : [];
for (const view of canvas ? extra : []) {
  await page.evaluate(vw => {
    const v = window.__ldrawViewer;
    if (!v) return;
    v.camera.position.set(vw.pos[0], vw.pos[1], vw.pos[2]);
    v.controls.target.set(vw.target[0], vw.target[1], vw.target[2]);
    v.controls.update();
    v.needsRender = true;
  }, view);
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__ldrawViewer?.composer?.render(); });
  try { await canvas.screenshot({ path: join(outDir, `${label}-${view.name}.png`), timeout: 25000 }); }
  catch (e) { console.error(`capture ${view.name} failed: ${String(e).slice(0, 160)}`); }
}

console.log(JSON.stringify({ target, label, bricks, errors: errors.slice(0, 8), ...probe }, null, 1));
await browser.close();
