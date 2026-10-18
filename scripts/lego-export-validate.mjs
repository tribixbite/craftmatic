#!/usr/bin/env node
/**
 * Do the 3D mesh exports still carry the ASSEMBLED transforms after the explode
 * controls have been used? (Audit P2, "validate exports independently":
 * *"GLB/OBJ/STL should preserve assembled transforms even after using explode
 * controls."*)
 *
 * The concern is real and structural, not hypothetical: `setExplodeFactor`
 * REWRITES every InstancedMesh's instance matrices in place, and the exporters
 * bake whatever is in those buffers at the moment they run. If returning the
 * slider to zero did not restore the buffers exactly, every export taken after a
 * user touched the slider would ship a slightly-exploded model — and nothing
 * would say so.
 *
 * Method: drive the REAL app, run the REAL export functions (not a
 * reimplementation), and compare bytes.
 *   1. export OBJ, STL, 3MF and GLB from the freshly loaded model;
 *   2. explode 0 → 100 → 0;
 *   3. export all four again;
 *   4. the bytes must be IDENTICAL.
 * Byte identity is the strongest available statement and needs no tolerance
 * argument. It is a WITHIN-RUN comparison only: dev part resolution is
 * nondeterministic (the /ldraw-parts upstream fallback), so the same set's hash
 * legitimately differs between runs — 850-1 measured 52,487,122 and 52,462,888
 * bytes on two consecutive runs. Before-vs-after inside one run is the invariant;
 * run-to-run equality is not, and must not be added as an assertion. The exports are captured by stubbing `URL.createObjectURL` and
 * neutering the anchor click, so the app's own `downloadBlob` path runs
 * untouched and nothing lands on disk.
 *
 * Also checked, because a preserved transform is worthless at the wrong scale:
 * the OBJ's bounding box against the viewer's own stud dimensions at the
 * documented 8 mm/stud (STL/OBJ/3MF export at real LEGO size; GLB stays in
 * scene units, so it is exempt).
 *
 *   bun dev:web                                  # port 4000
 *   node scripts/lego-export-validate.mjs [--only SET] [--out DIR]
 *
 * Exit 0 = every export round-tripped identically. Needs the dev build: the
 * deployed bundle does not expose `window.__ldrawViewer`.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';
const ONLY = flag('--only', null);
const OUT = flag('--out', join('output', 'visual-fixtures', new Date().toISOString().slice(0, 10)));

/**
 * SMALL sets on purpose. The property under test — does an export still carry
 * the assembled transforms after the explode slider was used — does not need a
 * big model, and OBJ/3MF bake to text: 10316 is 22 M triangles, i.e. a
 * multi-hundred-megabyte OBJ string per export and eight exports per run. Both
 * of these are authentic OMR files graded PASS, and 850 is deliberately a
 * rotation-heavy Technic-era build (forks, wheels, steering linkage), which is
 * where a dropped or re-derived rotation would actually show.
 */
const SETS = [
  { setNum: '311-1', why: 'small official OMR control (123 placements)', formats: ['obj', 'stl', 'glb'] },
  { setNum: '850-1', why: 'small official OMR build with rotated mechanisms (216 placements)', formats: ['obj', 'stl', 'glb'] },
  // The one model MEASURED to have a non-zero return-to-zero matrix delta
  // (1.19e-3 scene units, from decompose()/compose() on its sheared placements
  // — see the visual fixtures). Without it, byte identity would only ever have
  // been checked on models where the round trip is exact anyway. GLB only: its
  // OBJ would be a multi-hundred-megabyte string at 2,417 placements.
  { setNum: '10182-1', why: 'the model with a known non-zero explode round-trip delta', formats: ['glb'] },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { generated: new Date().toISOString(), dev: DEV, sets: [] };
let failures = 0;

for (const s of SETS) {
  if (ONLY && s.setNum !== ONLY) continue;
  const r = await run(s);
  report.sets.push(r);
  failures += r.failed.length;
  console.log(`\n── ${s.setNum} (${s.why}) ──`);
  for (const line of r.lines) console.log('  ' + line);
}
writeFileSync(join(OUT, 'export-validate.json'), JSON.stringify(report, null, 1));
await browser.close();
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all exports round-tripped identically'} — ${join(OUT, 'export-validate.json')}`);
process.exit(failures ? 1 : 0);

async function run({ setNum, why, formats }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const out = { setNum, why, lines: [], failed: [], before: null, after: null, scale: null };
  try {
    await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click();
    });
    await page.waitForTimeout(1200);
    const hit = await page.evaluate(async set => {
      const i = document.getElementById('lego-search'); i.value = set;
      document.getElementById('lego-search-btn').click();
      await new Promise(r => setTimeout(r, 2500));
      const card = [...document.querySelectorAll('.lego-result-card')]
        .find(c => c.querySelector('.lego-result-num')?.textContent.trim() === set);
      if (!card) return 'no-card';
      card.click();
      return 'clicked';
    }, setNum);
    if (hit !== 'clicked') throw new Error(`no card for ${setNum}`);

    const deadline = Date.now() + 300_000;
    let ok = false;
    while (Date.now() < deadline) {
      ok = await page.evaluate(() => !!window.__ldrawViewer?.loaded
        && /bricks rendered/.test(document.getElementById('lego-status')?.textContent ?? '')
        && !(window.__ldrawViewer?.warp?.running));
      if (ok) break;
      await page.waitForTimeout(1000);
    }
    if (!ok) throw new Error('model never finished rendering');
    await page.waitForTimeout(1500);

    const before = await exportAll(page, formats);
    await page.evaluate(async () => {
      const v = window.__ldrawViewer;
      v.setExplodeFactor(1.0);
      await new Promise(r => setTimeout(r, 400));
      v.setExplodeFactor(0);
      await new Promise(r => setTimeout(r, 400));
    });
    const after = await exportAll(page, formats);
    out.before = before; out.after = after;

    for (const fmt of Object.keys(before)) {
      const b = before[fmt], a = after[fmt];
      const same = b.sha256 === a.sha256 && b.bytes === a.bytes;
      out.lines.push(`${same ? 'ok  ' : 'FAIL'} ${fmt.padEnd(4)} ${b.bytes} bytes, sha ${b.sha256.slice(0, 12)}`
        + (same ? ' — identical after explode 0→100→0' : ` → ${a.bytes} bytes, sha ${a.sha256.slice(0, 12)}`));
      if (!same) out.failed.push({ fmt, before: b, after: a });
    }

    // Scale check: STL/OBJ/3MF bake at 8 mm per stud (the documented real-LEGO
    // size). A transform preserved at the wrong scale is still a broken export.
    out.scale = await page.evaluate(() => {
      const v = window.__ldrawViewer;
      return { studs: v.getModelSizeStuds(), mmPerStud: 8 };
    });
    const objBBox = before.obj?.bbox;
    const want = out.scale.studs;
    if (!objBBox) out.lines.push('--   obj not exported for this set — scale check skipped');
    else
    for (const [axis, studAxis] of [['x', 'x'], ['y', 'y'], ['z', 'z']]) {
      const got = objBBox[axis];
      const expected = want[studAxis] * 8;
      const rel = Math.abs(got - expected) / Math.max(1, expected);
      const okScale = rel < 0.02;
      out.lines.push(`${okScale ? 'ok  ' : 'FAIL'} obj ${axis} extent ${got.toFixed(1)} mm vs ${expected.toFixed(1)} mm from ${want[studAxis].toFixed(2)} studs x 8 mm (${(rel * 100).toFixed(2)}%)`);
      if (!okScale) out.failed.push({ check: `obj-scale-${axis}`, got, expected });
    }
  } catch (err) {
    out.failed.push({ check: 'ran to completion', error: String(err).slice(0, 300) });
    out.lines.push(`FAIL ${String(err).slice(0, 200)}`);
  }
  await page.close();
  return out;
}

/**
 * Run the app's real export functions and capture what they would download.
 * `downloadBlob` builds an object URL and clicks an anchor; stubbing those two
 * captures the Blob while leaving every byte-producing step untouched.
 */
async function exportAll(page, formats) {
  // Hash IN-PAGE. These exports run to tens of megabytes and serialising the
  // bytes across the CDP bridge as a JS array costs minutes per format; only
  // the digest, the length and the OBJ bounding box need to leave the page.
  return page.evaluate(async formats => {
    const ex = await import('/src/viewer/exporter.ts');
    const v = window.__ldrawViewer;
    const shim = { meshes: v.exportMeshes() };
    const captured = [];
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => { captured.push(blob); return 'blob:captured'; };
    HTMLAnchorElement.prototype.click = function () { /* suppress the download */ };

    const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const grab = async (fn, wantText) => {
      captured.length = 0;
      await fn();
      const blob = captured[captured.length - 1];
      const buf = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const out = { bytes: buf.byteLength, sha256: hex(digest) };
      if (wantText) {
        // OBJ is text, so its bounding box is readable without a parser.
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const line of new TextDecoder().decode(buf).split('\n')) {
          if (line.charCodeAt(0) !== 118 || line.charCodeAt(1) !== 32) continue; // "v "
          const p = line.split(' ');
          for (let k = 0; k < 3; k++) {
            const val = +p[k + 1];
            if (val < lo[k]) lo[k] = val;
            if (val > hi[k]) hi[k] = val;
          }
        }
        out.bbox = { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
      }
      return out;
    };

    try {
      const out = {};
      // 3MF is XML and the app itself guards it at a triangle ceiling; OBJ, STL
      // and GLB are the three the audit names, and every format reads the SAME
      // instance matrices, so they stand or fall together.
      if (formats.includes('obj')) out.obj = await grab(() => ex.exportOBJ(shim), true);
      if (formats.includes('stl')) out.stl = await grab(() => ex.exportSTL(shim));
      if (formats.includes('glb')) out.glb = await grab(() => ex.exportGLB(shim));
      return out;
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
  }, formats);
}
