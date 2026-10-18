#!/usr/bin/env node
/**
 * Isolate what each rendering pass CONTRIBUTES to the picture, per pixel.
 *
 * Why it exists: the renderer's look is the product of a long calibration
 * (tone mapping, specularIntensity, four light levels, env intensity — see
 * CLAUDE.md "Renderer conventions"), so a complaint like "there is a haze over
 * the model" cannot be answered by tweaking a constant and eyeballing it. This
 * captures the SAME camera on the SAME model with exactly one pass disabled at
 * a time and reports, in numbers, how much of each pixel that pass was
 * supplying — so the culprit is identified before anything is changed, and the
 * calibrated colours can be re-checked afterwards against the same samples.
 *
 * Sample points are not arbitrary screen coordinates: each is raycast back to
 * the brick under it, so a sample carries its LDraw colour id, its part, and
 * its distance from the camera. That last one is what separates a distance-
 * dependent wash (fog) from a uniform lift (exposure / ambient / env).
 *
 * Needs Chrome and the dev server (which needs the local clego corpus):
 *   bun dev:web                                   # in another shell
 *   node scripts/renderer-pass-isolation.mjs --sets 21063-1,71043-1,10316-1
 *
 * Output: <out>/<set>-<variant>.png plus samples.json / report.txt.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DEV = flag('--url', process.env.DEV_URL ?? 'http://localhost:4000');
const SETS = flag('--sets', '21063-1,71043-1,10316-1').split(',').filter(Boolean);
const OUT = flag('--out', join('output', 'fog-isolation', new Date().toISOString().slice(0, 10)));
const VIEW = flag('--view', 'iso');
/** Comma-separated variant names to run; default = all of them. */
const ONLY = flag('--variants', '').split(',').filter(Boolean);

mkdirSync(OUT, { recursive: true });

/**
 * Each variant disables exactly ONE thing and returns a restore closure, so
 * every capture differs from the baseline in one term only. They run in the
 * page, against the dev-only `window.__ldrawViewer` hook.
 *
 * `all-suspects` is the exception and runs last: it is the candidate FIX, not
 * an isolation step, and only means anything once the singles have ranked.
 */
const VARIANTS = [
  ['baseline', '(nothing disabled)'],
  ['fog-off', 'scene.fog = null'],
  ['sao-off', 'SAOPass removed from the composer'],
  ['vignette-off', 'VignetteShader pass removed'],
  ['env-off', 'scene.environmentIntensity = 0'],
  ['backdrop-off', 'floor + contact shadow + cyc wall hidden'],
  ['reflections-off', 'mirrored floor-reflection meshes hidden'],
  ['exposure-1', 'toneMappingExposure forced to 1.0'],
  ['ambient-off', 'AmbientLight intensity 0'],
  ['hemi-off', 'HemisphereLight intensity 0'],
  // Not isolations — these restore the PRE-FIX parameter values at runtime, so
  // the before/after comparison (and its cost) is measured in one session on
  // one machine instead of across two builds.
  ['legacy-vignette', 'vignette back to offset 1.2 / darkness 0.8 (grey veil)'],
  ['legacy-sao', 'SAO scale/kernel back to maxDim-derived'],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = [];
const all = {};

for (const setNum of SETS) {
  process.stdout.write(`\n── ${setNum} ──\n`);
  try {
    all[setNum] = await runSet(setNum);
  } catch (e) {
    console.log(`  FAILED: ${String(e).slice(0, 300)}`);
    report.push(`${setNum}: FAILED ${String(e).slice(0, 200)}`);
  }
}

await browser.close();
writeFileSync(join(OUT, 'samples.json'), JSON.stringify(all, null, 1));
writeFileSync(join(OUT, 'report.txt'), report.join('\n') + '\n');
console.log(`\n${OUT}`);

// ─── one set ─────────────────────────────────────────────────────────────────

async function runSet(setNum) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));

  await openLegoTab(page);
  await selectSet(page, setNum);
  const bricks = await waitForRender(page);
  if (!bricks) throw new Error('model never finished rendering');

  // Pin the camera EXACTLY. setView() animates, so it is allowed to finish and
  // then the resulting pose is frozen — every variant must re-render from the
  // identical matrix or the comparison measures camera drift, not passes.
  await page.evaluate(v => {
    const vw = window.__ldrawViewer;
    vw.setAutoRotate(false);
    vw.setView(v);
  }, VIEW);
  await page.waitForTimeout(3000);
  const cam = await page.evaluate(() => {
    const v = window.__ldrawViewer;
    v.cameraAnim = null;
    return {
      pos: v.camera.position.toArray(),
      target: v.controls.target.toArray(),
      exposure: v.renderer.toneMappingExposure,
    };
  });

  // Sample grid → raycast → keep only points that land on a brick, each
  // labelled with its LDraw colour and its true distance from the camera.
  const samples = await page.evaluate(() => {
    const v = window.__ldrawViewer;
    const canvas = v.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const out = [];
    for (let gy = 1; gy <= 6; gy++) {
      for (let gx = 1; gx <= 8; gx++) {
        const cx = rect.left + (rect.width * gx) / 9;
        const cy = rect.top + (rect.height * gy) / 7;
        const brick = v.pickBrickAt(cx, cy);
        if (!brick) continue;
        // Scene units are studs and world Y is flipped relative to LDraw
        // (viewer.ts builds each instance matrix with -scale on the Y row),
        // so this is the brick's real scene position.
        const p = [brick.x / 20, -brick.y / 20, brick.z / 20];
        const d = Math.hypot(
          p[0] - v.camera.position.x, p[1] - v.camera.position.y, p[2] - v.camera.position.z);
        out.push({
          px: Math.round(((cx - rect.left) / rect.width) * canvas.width),
          py: Math.round(((cy - rect.top) / rect.height) * canvas.height),
          color: brick.color, part: brick.part, dist: +d.toFixed(2),
        });
      }
    }
    return out;
  });
  console.log(`  ${bricks} instances · ${samples.length}/48 grid points hit a brick`);

  const variants = {};
  for (const [name, what] of VARIANTS) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const applied = await page.evaluate(n => window.__applyVariant(n), name);
    if (applied === 'unavailable') { console.log(`  skip ${name} (not present in this scene)`); continue; }
    // Restore the pinned camera before every capture — a variant that touches
    // the scene can invalidate controls state.
    await page.evaluate(c => {
      const v = window.__ldrawViewer;
      v.cameraAnim = null;
      v.camera.position.set(...c.pos);
      v.controls.target.set(...c.target);
      v.controls.update();
      v.invalidate?.();
    }, cam);
    await page.waitForTimeout(500);

    const shot = await page.evaluate(() => window.__ldrawViewer.captureScreenshot());
    writeFileSync(join(OUT, `${setNum}-${name}.png`),
      Buffer.from(shot.split(',')[1], 'base64'));
    variants[name] = {
      what,
      px: await samplePixels(page, samples),
      stats: await frameStats(page),
      perf: await framePerf(page),
    };
    await page.evaluate(() => window.__restoreVariant?.());
    await page.waitForTimeout(300);
  }

  // ── numbers ──────────────────────────────────────────────────────────────
  const base = variants['baseline'];
  const lines = [`\n═══ ${setNum} — contribution of each pass (mean |ΔRGB| over ${samples.length} brick samples, 0-255) ═══`];
  lines.push('variant           meanΔ  maxΔ   near→far Δ split      frame p01  frame mean  what');
  const ranked = [];
  for (const [name, v] of Object.entries(variants)) {
    if (name === 'baseline') continue;
    const d = samples.map((s, i) => rgbDist(base.px[i], v.px[i]));
    const mean = avg(d), max = Math.max(...d);
    // Split the samples by camera distance at the median: a fog term grows with
    // distance, a global lift does not. This is the discriminating number.
    const med = median(samples.map(s => s.dist));
    const near = avg(d.filter((_, i) => samples[i].dist <= med));
    const far = avg(d.filter((_, i) => samples[i].dist > med));
    ranked.push({ name, mean, max, near, far, ratio: near > 0.01 ? far / near : Infinity });
    lines.push(
      `${name.padEnd(17)} ${mean.toFixed(2).padStart(5)} ${max.toFixed(1).padStart(5)}   ` +
      `${near.toFixed(2).padStart(5)} → ${far.toFixed(2).padStart(5)} (×${(near > 0.01 ? far / near : 0).toFixed(2)})   ` +
      `${String(v.stats.p01).padStart(9)} ${String(v.stats.mean).padStart(11)}  ${v.what}`,
    );
  }
  lines.push(`baseline frame: p01 luminance ${base.stats.p01}, mean ${base.stats.mean}, p99 ${base.stats.p99}`);
  lines.push(`baseline cost : ${base.perf.medianMs} ms median / ${base.perf.p90Ms} ms p90 · ` +
    `${base.perf.calls} draw calls · ${base.perf.triangles.toLocaleString()} tris · ${base.perf.passes} passes`);
  for (const legacy of ['legacy-vignette', 'legacy-sao']) {
    const v = variants[legacy];
    if (v) {
      lines.push(`  vs ${legacy.padEnd(16)}: ${v.perf.medianMs} ms median / ${v.perf.p90Ms} ms p90 · ` +
        `${v.perf.calls} draw calls · ${v.perf.triangles.toLocaleString()} tris`);
    }
  }
  ranked.sort((a, b) => b.mean - a.mean);
  lines.push(`\nlargest contributor: ${ranked[0]?.name} (mean Δ ${ranked[0]?.mean.toFixed(2)})`);
  const distanceDependent = ranked.filter(r => r.ratio > 1.25 && r.mean > 0.5);
  lines.push(`distance-dependent (far/near Δ > 1.25×): ${distanceDependent.map(r => `${r.name} ×${r.ratio.toFixed(2)}`).join(', ') || '(none)'}`);
  const text = lines.join('\n');
  console.log(text);
  report.push(text);

  await page.close();
  return { camera: cam, samples, variants, errors };
}

// ─── page-side helpers ───────────────────────────────────────────────────────

/** Median RGB of a 5×5 patch at each sample point, read from a fresh render. */
function samplePixels(page, samples) {
  return page.evaluate(pts => {
    const v = window.__ldrawViewer;
    v.composer.render(); // explicit render; preserveDrawingBuffer is OFF
    const src = v.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return pts.map(p => {
      const d = ctx.getImageData(Math.max(0, p.px - 2), Math.max(0, p.py - 2), 5, 5).data;
      const ch = [[], [], []];
      for (let i = 0; i < d.length; i += 4) { ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); }
      return ch.map(a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; });
    });
  }, samples);
}

/**
 * Cost of one composited frame, plus the draw-call/triangle counts behind it.
 *
 * `renderer.info` resets per render, so the counts are read straight after a
 * render. The timing is a MEDIAN of many synchronous composer.render() calls:
 * the mean is dominated by occasional multi-frame stalls in a headless tab, and
 * a single sample is worthless. This is a CPU-submit time, not GPU time —
 * enough to catch a pass being added or a kernel exploding, not a GPU profile.
 */
function framePerf(page) {
  return page.evaluate(() => {
    const v = window.__ldrawViewer;
    for (let i = 0; i < 5; i++) v.composer.render(); // warm up
    const t = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      v.composer.render();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    // `renderer.info` resets on EVERY render call by default, so reading it
    // after composer.render() reports only the last pass's fullscreen quad
    // (calls: 1). Disable autoReset and reset once, so the counts accumulate
    // over every pass and describe the whole composited frame.
    const info = v.renderer.info;
    const prevAuto = info.autoReset;
    info.autoReset = false;
    info.reset();
    v.composer.render();
    const frame = { calls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = prevAuto;
    return {
      medianMs: +t[Math.floor(t.length / 2)].toFixed(2),
      p90Ms: +t[Math.floor(t.length * 0.9)].toFixed(2),
      calls: frame.calls, triangles: frame.triangles,
      passes: v.composer.passes.length,
    };
  });
}

/** Whole-frame luminance percentiles — the "is the black point lifted" check. */
function frameStats(page) {
  return page.evaluate(() => {
    const v = window.__ldrawViewer;
    v.composer.render();
    const src = v.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const lum = [];
    for (let i = 0; i < d.length; i += 4 * 7) { // stride-sample; 1/7 of pixels is plenty
      lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    lum.sort((a, b) => a - b);
    const q = p => +lum[Math.floor(p * (lum.length - 1))].toFixed(1);
    return {
      p01: q(0.01), p05: q(0.05), p50: q(0.5), p99: q(0.99),
      mean: +(lum.reduce((a, b) => a + b, 0) / lum.length).toFixed(1),
    };
  });
}

// Function declarations, not const arrows: the driver loop at the top of this
// module runs before any `const` below it is initialised (temporal dead zone).
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }
/** Mean absolute per-channel difference, in 0-255 units. */
function rgbDist(a, b) { return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3; }

// ─── app driving (same contract as scripts/lego-visual-fixtures.mjs) ─────────

async function openLegoTab(page) {
  // Generous nav timeout: a cold Vite dev server transforms the whole module
  // graph on first hit, and 30 s is not enough when the box is also busy.
  await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
  });
  await page.waitForTimeout(1200);
  // Stats overlay forces CONTINUOUS rendering; on-demand rendering in a
  // backgrounded automation tab otherwise leaves the compositor without a fresh
  // frame (CLAUDE.md, browser-automation caveats).
  await page.evaluate(() => {
    const cb = document.getElementById('lego-stats');
    if (cb && !cb.checked) cb.click();
  });
  // Install the variant switcher once per page.
  await page.evaluate(installVariantSwitcher);
}

async function selectSet(page, setNum) {
  const hit = await page.evaluate(async set => {
    const input = document.getElementById('lego-search');
    input.value = set;
    document.getElementById('lego-search-btn').click();
    await new Promise(r => setTimeout(r, 2500));
    const card = [...document.querySelectorAll('.lego-result-card')]
      .find(c => c.querySelector('.lego-result-num')?.textContent.trim() === set);
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  }, setNum);
  if (hit !== 'clicked') throw new Error(`search did not surface a card for ${setNum}`);
}

async function waitForRender(page) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => {
      const v = window.__ldrawViewer;
      if (!v || !v.loaded) return 0;
      let n = 0;
      for (const s of v.stepGroups.values()) {
        s.group.traverse(o => { if (o.isInstancedMesh && !o.userData.mirrorOf) n += (o.userData.originalMatrices?.length ?? 0); });
      }
      return n;
    });
    const settled = n > 0 && await page.evaluate(() =>
      /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '')
      && !(window.__ldrawViewer?.warp?.running));
    if (settled) { await page.waitForTimeout(2500); return n; }
    await page.waitForTimeout(2000);
  }
  return 0;
}

/**
 * Runs IN THE PAGE. Defines `__applyVariant(name)` / `__restoreVariant()`.
 * Every variant records its own undo, so a run cannot leak state into the next
 * capture — the whole method depends on the baseline being reproducible.
 */
function installVariantSwitcher() {
  let undo = null;
  window.__restoreVariant = () => { const u = undo; undo = null; u?.(); window.__ldrawViewer?.invalidate?.(); };
  window.__applyVariant = name => {
    window.__restoreVariant();
    const v = window.__ldrawViewer;
    const passes = v.composer.passes;
    const vignette = passes.find(p => p.material?.uniforms?.darkness);
    const removePass = pass => {
      const i = passes.indexOf(pass);
      if (i < 0) return 'unavailable';
      passes.splice(i, 1);
      undo = () => passes.splice(i, 0, pass);
      return 'ok';
    };
    const hideAll = objs => {
      const wasVisible = objs.map(o => o.visible);
      objs.forEach(o => { o.visible = false; });
      undo = () => objs.forEach((o, i) => { o.visible = wasVisible[i]; });
      return objs.length ? 'ok' : 'unavailable';
    };
    switch (name) {
      case 'baseline': return 'ok';
      case 'fog-off': {
        const f = v.scene.fog;
        if (!f) return 'unavailable';
        v.scene.fog = null;
        undo = () => { v.scene.fog = f; };
        return 'ok';
      }
      case 'sao-off': return v.saoPass ? removePass(v.saoPass) : 'unavailable';
      case 'vignette-off': return vignette ? removePass(vignette) : 'unavailable';
      case 'env-off': {
        const e = v.scene.environmentIntensity;
        v.scene.environmentIntensity = 0;
        undo = () => { v.scene.environmentIntensity = e; };
        return 'ok';
      }
      case 'backdrop-off': return hideAll(v.backdropMeshes ?? []);
      case 'reflections-off': {
        const mirrors = [];
        v.scene.traverse(o => { if (o.userData?.mirrorOf) mirrors.push(o); });
        return hideAll(mirrors);
      }
      case 'exposure-1': {
        const e = v.renderer.toneMappingExposure;
        v.renderer.toneMappingExposure = 1.0;
        undo = () => { v.renderer.toneMappingExposure = e; };
        return 'ok';
      }
      case 'legacy-vignette': {
        if (!vignette) return 'unavailable';
        const o = vignette.uniforms.offset.value, d = vignette.uniforms.darkness.value;
        vignette.uniforms.offset.value = 1.2;
        vignette.uniforms.darkness.value = 0.8;
        undo = () => { vignette.uniforms.offset.value = o; vignette.uniforms.darkness.value = d; };
        return 'ok';
      }
      case 'legacy-sao': {
        if (!v.saoPass) return 'unavailable';
        const p = v.saoPass.params;
        const s = p.saoScale, k = p.saoKernelRadius;
        const maxDim = v.lastMaxDim || 10;
        p.saoScale = Math.max(4, maxDim * 0.4);
        p.saoKernelRadius = Math.max(12, maxDim * 1.0);
        undo = () => { p.saoScale = s; p.saoKernelRadius = k; };
        return 'ok';
      }
      case 'ambient-off':
      case 'hemi-off': {
        const want = name === 'ambient-off' ? 'AmbientLight' : 'HemisphereLight';
        const lights = [];
        v.scene.traverse(o => { if (o.type === want) lights.push(o); });
        if (!lights.length) return 'unavailable';
        const prev = lights.map(l => l.intensity);
        lights.forEach(l => { l.intensity = 0; });
        undo = () => lights.forEach((l, i) => { l.intensity = prev[i]; });
        return 'ok';
      }
      default: return 'unavailable';
    }
  };
}
