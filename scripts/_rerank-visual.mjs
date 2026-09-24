#!/usr/bin/env node
/**
 * Render the CURRENT primary and the PROPOSED alternate of every `needs-visual`
 * source-switch proposal, from two fixed views each, so the pair can be graded
 * against the set's box art.
 *
 * WHY THE SOURCE PICKER AND NOT THE AUTO-LOAD. The auto-load resolves whatever
 * the index + the read-time conv-demotion + the quality gate pick; that is the
 * incumbent by definition and can never show the alternate. `renderSourcePicker`
 * populates `#lego-source-select` with one option PER INDEX POSITION, in index
 * order, so setting `.value` to the entry's position and firing `onchange` loads
 * exactly the file under test — `allowBroken: true`, i.e. even a gated
 * conversion renders, which is what a visual review needs.
 *
 *   bun dev:web                                   # port 4000, another shell
 *   node scripts/_rerank-visual.mjs [--jobs F] [--out DIR] [--lanes N]
 *                                   [--only 31199,75222] [--force]
 *
 * Output: <OUT>/<set>/{primary,alt}-{v1,v2}.png plus <OUT>/<set>/render.json
 * (placements, missing moulds, bbox, status line) and <OUT>/_render_log.json.
 * Existing PNGs are skipped unless --force, so the run is resumable.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const has = n => args.includes(n);

const DEV = process.env.DEV_URL ?? 'http://localhost:4000';
const JOBS = flag('--jobs', 'C:/git/clego/geograde/_rerank_visual_jobs.json');
const OUT = flag('--out', join('output', 'rerank-visual-2026-09-20'));
const LANES = Math.max(1, parseInt(flag('--lanes', '2'), 10));
const ONLY = (flag('--only', '') || '').split(',').filter(Boolean);
const FORCE = has('--force');
/** Two fixed views, the same two for every model, so a pair is comparable. */
const VIEWS = [['v1', 'iso'], ['v2', 'front']];

const jobs = JSON.parse(readFileSync(JOBS, 'utf8'))
  .filter(j => !ONLY.length || ONLY.includes(j.set));

/** A capture is done when both views of both candidates are already on disk. */
function done(job) {
  if (FORCE) return false;
  return ['primary', 'alt'].every(w => VIEWS.every(([tag]) => {
    const p = join(OUT, job.set, `${w}-${tag}.png`);
    return existsSync(p) && statSync(p).size > 2000;
  }));
}

async function openLegoTab(page) {
  await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
  });
  await page.waitForTimeout(1200);
  // The stats overlay forces CONTINUOUS rendering. With on-demand rendering a
  // backgrounded automation tab never presents a fresh frame and every
  // canvas.screenshot() times out (CLAUDE.md, browser-automation caveats).
  await page.evaluate(() => {
    const cb = document.getElementById('lego-stats');
    if (cb && !cb.checked) cb.click();
  });
}

/** Search for the set and click its card (only `.lego-result-card` is clickable). */
async function selectSet(page, set) {
  const hit = await page.evaluate(async s => {
    const input = document.getElementById('lego-search');
    input.value = s;
    document.getElementById('lego-search-btn').click();
    await new Promise(r => setTimeout(r, 2600));
    const cards = [...document.querySelectorAll('.lego-result-card')];
    const num = c => c.querySelector('.lego-result-num')?.textContent.trim() ?? '';
    const card = cards.find(c => num(c) === `${s}-1`)
      ?? cards.find(c => num(c).split('-')[0] === s)
      ?? null;
    if (!card) return `no-card(${cards.length} results)`;
    card.click();
    return 'clicked';
  }, set);
  if (hit !== 'clicked') throw new Error(`search did not surface a card for ${set}: ${hit}`);
  // The source picker only exists once getModelsIndex() has resolved.
  await page.waitForFunction(
    () => !document.getElementById('lego-source-row')?.hidden, null,
    { timeout: 90_000 });
}

/**
 * Load one index position through the source picker and wait for it to settle.
 * Returns the measurement bundle, or throws.
 */
async function loadIndexEntry(page, i, expectPath) {
  await page.evaluate(idx => {
    const v = window.__ldrawViewer;
    if (v) v.loaded = false;                 // so waitForRender cannot see the previous model
    const sel = document.getElementById('lego-source-select');
    sel.value = String(idx);
    sel.onchange();
  }, i);
  const n = await waitForRender(page);
  if (!n) throw new Error(`render did not settle for index ${i} (${expectPath})`);
  return measure(page);
}

async function waitForRender(page) {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => {
      const v = window.__ldrawViewer;
      if (!v || !v.loaded) return 0;
      let n = 0;
      for (const s of v.stepGroups.values()) {
        s.group.traverse(o => {
          if (o.isInstancedMesh && !o.userData.mirrorOf) n += (o.userData.originalMatrices?.length ?? 0);
        });
      }
      return n;
    });
    const settled = n > 0 && await page.evaluate(() =>
      /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '')
      && !(window.__ldrawViewer?.warp?.running));
    if (settled) { await page.waitForTimeout(2000); return n; }
    await page.waitForTimeout(1500);
  }
  return 0;
}

/** Everything worth recording beside the images, in one page evaluation. */
function measure(page) {
  return page.evaluate(() => {
    const v = window.__ldrawViewer;
    v.setAutoRotate(false);
    // All layers/steps visible: a step-limited view would hide parts of the
    // model and make a complete file look like a fragment.
    v.setMaxStep(v.getSliderMode() === 'layer' ? v.getMaxAvailableLayer() : v.getMaxAvailableStep());
    v.setExplodeFactor(0);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let instances = 0, placements = 0;
    for (const s of v.stepGroups.values()) {
      s.group.traverse(o => {
        if (!o.isInstancedMesh || o.userData.mirrorOf) return;
        const a = o.instanceMatrix.array;
        const cnt = o.userData.originalMatrices?.length ?? 0;
        for (let i = 0; i < cnt; i++) {
          const b = i * 16;
          const p = [a[b + 12], a[b + 13], a[b + 14]];
          for (let k = 0; k < 3; k++) {
            if (p[k] < lo[k]) lo[k] = p[k];
            if (p[k] > hi[k]) hi[k] = p[k];
          }
          instances++;
          if (o.userData.primary) placements++;
        }
      });
    }
    return {
      instances, placements,
      missing: (v.missingParts ?? []).length,
      substituted: (v.substitutedParts ?? []).length,
      sizeStuds: v.getModelSizeStuds?.() ?? null,
      bbox: { span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map(x => +x.toFixed(1)) },
      badge: document.getElementById('lego-source-badge')?.textContent ?? null,
      status: document.getElementById('lego-status')?.textContent?.slice(-260) ?? null,
    };
  });
}

async function shoot(page, canvas, file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await canvas.screenshot({ path: file, timeout: 25_000 }); return true; }
    catch { await page.waitForTimeout(1800); }      // throttled rAF — documented retry
  }
  return false;
}

async function captureViews(page, dir, which) {
  const canvas = await page.$('#lego-viewer canvas') ?? await page.$('canvas');
  if (!canvas) throw new Error('no canvas');
  const shots = [];
  for (const [tag, view] of VIEWS) {
    await page.evaluate(vw => { window.__ldrawViewer?.setView(vw); }, view);
    await page.waitForTimeout(2400);
    const f = join(dir, `${which}-${tag}.png`);
    shots.push({ view, file: f, ok: await shoot(page, canvas, f) });
  }
  return shots;
}

async function runJob(page, job) {
  const dir = join(OUT, job.set);
  mkdirSync(dir, { recursive: true });
  const rec = { set: job.set, name: job.name, at: new Date().toISOString() };
  await selectSet(page, job.set);
  for (const [which, i, path] of [['primary', job.primary_i, job.primary_path],
                                  ['alt', job.alt_i, job.alt_path]]) {
    rec[which] = { i, path, ...(await loadIndexEntry(page, i, path)) };
    rec[which].shots = await captureViews(page, dir, which);
  }
  writeFileSync(join(dir, 'render.json'), JSON.stringify(rec, null, 1));
  return rec;
}

async function lane(browser, queue, log) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    serviceWorkers: 'block',                 // the PWA worker breaks /lego-models/*
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await openLegoTab(page);
  for (;;) {
    const job = queue.shift();
    if (!job) break;
    const t0 = Date.now();
    try {
      const rec = await runJob(page, job);
      const s = +((Date.now() - t0) / 1000).toFixed(1);
      log.push({ set: job.set, ok: true, seconds: s,
                 primary: rec.primary.placements, alt: rec.alt.placements });
      console.log(`  ok  ${job.set} ${String(job.name).slice(0, 34).padEnd(34)} `
        + `primary ${rec.primary.placements} / alt ${rec.alt.placements}  ${s}s  `
        + `(${queue.length} left)`);
    } catch (e) {
      log.push({ set: job.set, ok: false, error: String(e).slice(0, 300) });
      console.log(`  ERR ${job.set}: ${String(e).slice(0, 160)}`);
      // A wedged viewer poisons every later job in this lane — reload the tab.
      try { await openLegoTab(page); } catch { /* lane is done for */ }
    }
  }
  await ctx.close();
}

const todo = jobs.filter(j => !done(j));
console.log(`${jobs.length} jobs, ${jobs.length - todo.length} already captured, `
  + `${todo.length} to render on ${LANES} lane(s)`);
if (todo.length) {
  // `channel: 'chrome'` — the system Chrome, as every other harness here uses
  // (CLAUDE.md: Chrome for browser testing, not Edge). The bundled
  // chrome-headless-shell for this playwright-core is not installed on this box.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const log = [];
  await Promise.all(Array.from({ length: Math.min(LANES, todo.length) },
    () => lane(browser, todo, log)));
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, '_render_log.json'), JSON.stringify(log, null, 1));
  const bad = log.filter(r => !r.ok);
  console.log(`done: ${log.length - bad.length} ok, ${bad.length} failed`);
  if (bad.length) console.log(bad.map(b => `  ${b.set}: ${b.error}`).join('\n'));
}
