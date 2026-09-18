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
/**
 * Ceiling for the model itself to render. A stall hunt wants this SHORT (a
 * stalled load never recovers, so waiting the full budget out only costs wall
 * clock); a capture run of a mega-set wants it long. Default unchanged.
 */
const MODEL_MS = Number(process.env.PROBE_MODEL_MS ?? 240_000);

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
/**
 * Every intercepted chunk, recorded — because `prodHookPatched: false` alone
 * cannot say WHY the hook is missing, and the two causes need opposite fixes:
 *
 *  - the interception itself failed. An unhandled throw in a route handler
 *    leaves the request neither fulfilled nor continued, so the page's
 *    `await import()` of that chunk never settles and the panel hangs. Handled
 *    here: retry once, then hand the request back to the browser (unpatched but
 *    WORKING), so a Playwright hiccup degrades to "no debug handle" instead of
 *    a hang that reads like a broken deployment.
 *  - the chunk was never REQUESTED, i.e. the app never reached
 *    `import('@viewer/ldraw/index.js')`. That is an application-side stall and
 *    the routeEvents list is what proves it: on 2026-09-18, 7 of 18 sets hung
 *    on craftmatic.click with `{"error":"no viewer","status":"1 set found"}`,
 *    and this list showed all four entry chunks fetched cleanly with the viewer
 *    chunk absent — which ruled the harness out and moved the hunt into the
 *    app's own load chain.
 */
const routeEvents = [];

// ── Stall instrumentation ────────────────────────────────────────────────────
// A stalled load leaves NOTHING behind: no failed request, no console error,
// no exception — the status line just stops. To say WHERE it stopped, the
// deployed viewer chunk gets stage markers at the boundaries between its load
// stages, plus a counter on the `if(stale())return` bail-outs and a handle
// published at the TOP of load() (the existing hook publishes one only at the
// very end, so a stalled load has no handle at all).
//
// Each anchor below appears exactly once in the deployed chunk; a miss is
// reported in `routeEvents[].stageMisses` rather than silently ignored, since
// a renamed minified local would otherwise turn "not instrumented" into
// "nothing happened".
const STAGE_PATCHES = [
  // load() entry — publish the viewer before any await.
  ['async load(e,s){if(this.disposed)',
   'async load(e,s){globalThis.__lvEarly=this,globalThis.__stage="enter",globalThis.__loadCalls=(globalThis.__loadCalls||0)+1;if(this.disposed)'],
  // Every part geometry prefetched (the "N/N parts (100%)" point).
  ['if(i())return;const h=d=>d?d.tris.length',
   'if(i())return;globalThis.__stage="prefetched";const h=d=>d?d.tris.length'],
  // repairIncompleteGeometry() returned.
  ['const p=new Map;for(const d of o)h(De(d))===0',
   'globalThis.__stage="repaired";const p=new Map;for(const d of o)h(De(d))===0'],
  // buildStepGroup() returned — meshes exist.
  ['g.group.name="model"', 'globalThis.__stage="meshes",g.group.name="model"'],
];
/** Count the silent `stale → return` bail-outs inside load(). */
const STALE_PATCH = ['if(i())return;', 'if(i()){globalThis.__staleBails=(globalThis.__staleBails||0)+1;return}'];

// Network truth: which requests are in flight at the moment of the stall, and
// which finished last. `page.on('requestfailed')` cannot answer that — a
// deadlocked promise issues no request at all, and "zero pending" is exactly
// the observation that separates a hung await from a hung fetch.
await page.addInitScript(() => {
  const log = { inflight: new Map(), done: [], seq: 0 };
  globalThis.__net = log;
  const orig = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    const id = ++log.seq;
    log.inflight.set(id, { url, t: Date.now() });
    try {
      const r = await orig(...args);
      log.done.push({ url, status: r.status, ms: Date.now() - log.inflight.get(id).t });
      return r;
    } catch (e) {
      log.done.push({ url, error: String(e).slice(0, 80), ms: Date.now() - log.inflight.get(id).t });
      throw e;
    } finally {
      log.inflight.delete(id);
      if (log.done.length > 400) log.done.splice(0, 200);
    }
  };
});

// ── Slow models-index fault (PROBE_SLOW_INDEX_MS=<ms>) ───────────────────────
// On production `/lego-models-index.json` is a 3.8 MB download; on dev it is a
// local read that finishes in a millisecond. That difference IS the production
// stall's race window: two overlapping searches each fetch the index, the
// slower one finishes after the user has clicked a set, and its clean-up
// clears the selection under the load that click started. Delaying the
// response here reproduces production's timing on dev, deterministically.
// Only the DUPLICATE fetches are delayed, because that is what production
// does: two overlapping searches start two downloads of the same file, the
// first one renders the results the user clicks, and the second lands later.
// A uniform delay would move both together and reproduce nothing.
// `indexFetches` is itself a result: a build that shares one in-flight fetch
// records 1 here no matter what this delay is set to.
// The catalog is delayed too — not for its own sake, but because the panel's
// browse-all search fires from `ensureCatalog().then()`. If the catalog is
// already loaded when the user searches (dev: a local read), that second
// search has long finished and there is no overlap to reproduce. On production
// the catalog is a multi-MB download and the overlap is the normal case.
const SLOW_INDEX_MS = Number(process.env.PROBE_SLOW_INDEX_MS ?? 0);
/** When the set card was clicked — the duplicate-index hold releases on it. */
let clickedAt = null;
let indexFetches = 0;
if (SLOW_INDEX_MS > 0) {
  await page.route('**/lego-models-index.json', async route => {
    // A DUPLICATE fetch is held until just after the set is clicked. That is
    // the scheduling production produces by itself: the two downloads finish
    // within a few hundred ms of each other, and the click lands in between
    // roughly half the time. Pinning it makes the A/B deterministic instead of
    // a coin flip — the delay is an ORDERING, not an invented latency.
    if (++indexFetches > 1) {
      const until = Date.now() + SLOW_INDEX_MS;
      while (clickedAt === null && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 150));
    }
    await route.continue();
  });
  await page.route('**/lego-catalog.json', async route => {
    await new Promise(r => setTimeout(r, 2_000));
    await route.continue();
  });
  // And the model file itself, because the window this race has to land in is
  // "after the click, before the load's first staleness guard". On production
  // that model file is a CDN fetch of a few hundred ms to a second; on dev it
  // is a disk read of ~5 ms, so without this the duplicate index can only ever
  // arrive too late to prove anything.
  await page.route('**/lego-models/**', async route => {
    await new Promise(r => setTimeout(r, 1_500));
    await route.continue();
  });
}

// ── Upstream-throttle fault injection (PROBE_FAULT_503=<percent>) ────────────
// Production relays an upstream-throttled part as `503 no-store` (see
// worker/ldraw-omr.js), and the client deliberately leaves a transiently-failed
// part UNCACHED so a later reference can retry. Dev serves every part off disk,
// so that state never occurs there — which is exactly why the stall class it
// causes is invisible in dev. This reproduces it: a deterministic slice of part
// STEMS is dropped from the `_batch` answer (the mirror "does not have" them)
// and 503s on every direct candidate path, with the worker's own ~600 ms
// in-worker retry delay. Off unless the env var is set.
const FAULT_503 = Number(process.env.PROBE_FAULT_503 ?? 0);
const faultStem = rel => {
  const stem = rel.split('/').pop().replace(/\.dat$/i, '');
  let h = 0;
  for (const c of stem) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 100 < FAULT_503;
};
let faulted503 = 0;
if (FAULT_503 > 0) {
  await page.route('**/ldraw-parts/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/_batch')) {
      const resp = await route.fetch();
      let body = await resp.text();
      try {
        const data = JSON.parse(body);
        for (const rel of Object.keys(data.found ?? {})) {
          if (faultStem(rel)) { delete data.found[rel]; (data.missing ??= []).push(rel); }
        }
        body = JSON.stringify(data);
      } catch { /* not JSON — pass through */ }
      const headers = { ...resp.headers() };
      delete headers['content-encoding'];
      delete headers['content-length'];
      await route.fulfill({ status: resp.status(), headers, body });
      return;
    }
    const rel = u.pathname.slice('/ldraw-parts/'.length);
    if (rel && !rel.startsWith('_') && faultStem(rel)) {
      faulted503++;
      await new Promise(r => setTimeout(r, 600)); // the worker's own retry beat
      await route.fulfill({ status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' }, body: '' });
      return;
    }
    await route.continue();
  });
}

await page.route('**/assets/*.js', async route => {
  const url = route.request().url();
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await route.fetch();
      let body = await resp.text();
      const patched = body.includes(PROD_HOOK_ANCHOR);
      const stageMisses = [];
      let staleSites = 0;
      if (patched) {
        body = body.replace(PROD_HOOK_ANCHOR, `globalThis.__ldrawViewer=this,${PROD_HOOK_ANCHOR}`);
        prodHookPatched = true;
        // Stage markers go in the same chunk as the end-of-load hook.
        for (const [find, replace] of STAGE_PATCHES) {
          if (body.includes(find)) body = body.replace(find, replace);
          else stageMisses.push(find.slice(0, 32));
        }
        staleSites = body.split(STALE_PATCH[0]).length - 1;
        body = body.split(STALE_PATCH[0]).join(STALE_PATCH[1]);
      }
      const headers = { ...resp.headers() };
      // The fetched body is already decoded; keeping the original encoding/length
      // headers would make the browser try to inflate plain text.
      delete headers['content-encoding'];
      delete headers['content-length'];
      await route.fulfill({ status: resp.status(), headers, body });
      routeEvents.push({ url: url.slice(-44), status: resp.status(), bytes: body.length, patched, ms: Date.now() - t0,
        ...(patched ? { stageMisses, staleSites } : {}) });
      return;
    } catch (e) {
      routeEvents.push({ url: url.slice(-44), attempt, error: String(e).slice(0, 140), ms: Date.now() - t0 });
    }
  }
  // Last resort: let the browser fetch it itself. The hook will be missing for
  // that chunk (reported via prodHookPatched + routeEvents), but the page still
  // WORKS, so the run degrades to "no debug handle" instead of hanging for the
  // probe's entire model budget.
  try { await route.continue(); }
  catch (e) { routeEvents.push({ url: url.slice(-44), error: `continue: ${String(e).slice(0, 120)}` }); }
});

// Playwright's default navigation timeout is 30 s, which a loaded box or a
// cold vite server exceeds — and the probe then dies with a TimeoutError and
// writes no result at all, which reads like a stall but is a harness failure.
// Same budget as every other boot wait.
await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded', timeout: BOOT_MS });
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

// The panel's own browse-all search runs on init and owns the status line and
// the search button until it finishes. BOTH entry points have to wait it out:
// dropping a file in mid-init is silently lost (the load never starts, the
// viewer chunk is therefore never fetched, `prodHookPatched` stays false and
// the probe waits out its whole model budget reporting "Browsing all sets").
// Invisible in dev, where the index is a local read; reproducible on production,
// where that first search is a 3.8 MB network fetch. Measured 2026-09-18.
await page.waitForFunction(
  () => {
    const b = document.getElementById('lego-search-btn');
    return !!b && !b.disabled;
  }, null, { timeout: SEARCH_MS });

if (target.startsWith('file:')) {
  const abs = target.slice(5);
  if (!existsSync(abs)) { console.error(`no such file: ${abs}`); process.exit(1); }
  await page.setInputFiles('#lego-mpd-input', abs);
} else {
  // (The browse-all wait above is what makes this click land: clicking the
  // DISABLED search button is a silent no-op, and the probe then scanned the
  // leftover browse-all cards and reported `no-card (cards=48)`.)
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
  clickedAt = Date.now();
  if (clicked !== 'clicked') { console.error(`search failed: ${clicked}`); process.exit(1); }
}

// Wait for the viewer to report a loaded model.
const deadline = Date.now() + MODEL_MS;
let bricks = 0;
// Status TRANSITIONS, timestamped. A stall's whole visible signature is "the
// status line stopped changing", so the last transition's timestamp is what
// dates the stall; polling the final value alone cannot.
const statusTimeline = [];
const t0Wait = Date.now();
const sampleStatus = async () => {
  const s = await page.evaluate(() => ({
    status: document.getElementById('lego-status')?.textContent?.slice(0, 200) ?? null,
    badge: document.getElementById('lego-source-badge')?.textContent ?? null,
    selectDisabled: document.getElementById('lego-source-select')?.disabled ?? null,
    stage: globalThis.__stage ?? null,
    staleBails: globalThis.__staleBails ?? 0,
    loadCalls: globalThis.__loadCalls ?? 0,
  })).catch(() => null);
  if (!s) return;
  const last = statusTimeline[statusTimeline.length - 1];
  if (!last || last.status !== s.status || last.stage !== s.stage || last.badge !== s.badge) {
    statusTimeline.push({ ms: Date.now() - t0Wait, ...s });
  }
};
while (Date.now() < deadline) {
  await sampleStatus();
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
  if (!v) {
    // Everything needed to place a silent stall, gathered at the moment it is
    // observed: how far into load() the viewer got, whether a newer load
    // cancelled it, and what (if anything) the network is still waiting on.
    const early = globalThis.__lvEarly;
    const net = globalThis.__net;
    return {
      error: 'no viewer',
      // Distinguish "the model never loaded" from "the model loaded but the
      // debug handle is missing" — they need opposite fixes.
      brickCountAttr: document.querySelector('[data-brick-count]')?.dataset?.brickCount ?? null,
      status: document.getElementById('lego-status')?.textContent?.slice(-900) ?? null,
      stall: {
        stage: globalThis.__stage ?? null,
        staleBails: globalThis.__staleBails ?? 0,
        loadCalls: globalThis.__loadCalls ?? 0,
        viewerSeen: !!early,
        loadSeq: early?.loadSeq ?? null,
        disposed: early?.disposed ?? null,
        loaded: early?.loaded ?? null,
        warpRunning: early?.warp?.running ?? null,
        missingParts: early?.missingParts?.length ?? null,
        badge: document.getElementById('lego-source-badge')?.textContent ?? null,
        selectDisabled: document.getElementById('lego-source-select')?.disabled ?? null,
        inflight: net ? [...net.inflight.values()].map(r => ({ url: r.url.slice(-70), ageMs: Date.now() - r.t })) : null,
        netDone: net ? net.done.length : null,
        lastDone: net ? net.done.slice(-8).map(d => ({ url: d.url.slice(-60), status: d.status ?? d.error, ms: d.ms })) : null,
      },
    };
  }
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
// Part-fetch health, on EVERY run, not just a stalled one: an upstream
// throttle relayed as `503 no-store` is the condition that makes a part text
// fail transiently and stay uncached, and the stall rate tracks it. Without
// this number a run that renders and a run that hangs look identical after
// the fact. (`net.done` is capped, so these are the last ~400 requests.)
probe.partFetch = await page.evaluate(() => {
  const done = globalThis.__net?.done ?? [];
  const parts = done.filter(d => d.url.includes('/ldraw-parts/'));
  const by = {};
  for (const d of parts) { const k = String(d.status ?? d.error); by[k] = (by[k] ?? 0) + 1; }
  return { recorded: parts.length, byStatus: by };
});
probe.origin = DEV;
probe.prodHookPatched = prodHookPatched;
probe.routeEvents = routeEvents;
probe.statusTimeline = statusTimeline;
if (SLOW_INDEX_MS > 0) probe.indexFetches = indexFetches;
if (FAULT_503 > 0) probe.fault503 = { percent: FAULT_503, injected: faulted503 };
probe.failedRequests = [...failedRequests].slice(0, 12);
writeFileSync(join(outDir, `${label}-probe.json`), JSON.stringify(probe, null, 1));
writeFileSync(join(outDir, `${label}-positions.json`), JSON.stringify(positions));

// Fixed-camera captures for the visual record.
// ONLY the LEGO viewer's own canvas. The bare `canvas` fallback used to match
// another tab's renderer, so a run where the LEGO model never loaded still
// produced three screenshots — of an unrelated scene — and each of them then
// burned the full 4 x 25 s retry budget because there was nothing to draw.
// That is 335 s of the 575 s a failed production run cost, and the PNGs it
// left behind were actively misleading. No render, no captures.
// `PROBE_NO_CAPTURE=1` skips the PNGs. A stall hunt only needs the verdict, and
// the three fixed-camera captures (each with a 4×25 s retry budget) dominate a
// successful run's wall clock — enough to make a 15-run A/B impractical.
const noCapture = process.env.PROBE_NO_CAPTURE === '1';
const canvas = (probe.bricks > 0 && !noCapture) ? await page.$('#lego-viewer canvas') : null;
if (!canvas) {
  console.error(noCapture
    ? 'captures disabled (PROBE_NO_CAPTURE=1)'
    : `no LEGO canvas (bricks=${probe.bricks ?? 0}) — skipping captures`);
}
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
