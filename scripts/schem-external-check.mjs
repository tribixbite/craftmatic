/**
 * schem-external-check.mjs — external-viewer compatibility gate (S5).
 *
 * Exports a reference .schem through the REAL shared export path
 * (scripts/_schem_ref.ts → engine/schem-pipeline.ts), loads it into
 * schemat.io's 3D viewer and screenshots the result to output/schem-backlog/.
 *
 * WHY: our own importer round-trips whatever we write, so a palette/colour-space
 * mistake is invisible internally — the S1 bug (LDraw ids read through the
 * BrickLink table → 21063's white castle walls rendered as translucent blue
 * glass) was ONLY visible in an external viewer. The offline half of this gate
 * is test/palette-lint.test.ts; this is the visual half.
 *
 * MANUAL gate, deliberately NOT in CI — it depends on a third-party site.
 *
 * Usage (node, NOT bun — `chromium.launch` hangs under bun on this box):
 *   node scripts/schem-external-check.mjs
 *   node scripts/schem-external-check.mjs C:/git/clego/lego_sets/IO/21063.io 21063
 *   node scripts/schem-external-check.mjs output/vox-work/before.schem before
 *     (a `.schem` argument is viewed AS IS — for A/B-ing two pipeline builds
 *      without re-exporting, e.g. before/after a voxelizer change)
 *
 * Verdict is by eye on the screenshot: 21063 must be a WHITE castle on a
 * green/brown base — no translucent walls, no magenta/orange terrain.
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const SOURCE = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/21063.io';
const LABEL = process.argv[3] ?? '21063';
const OUT_DIR = resolve('output/schem-backlog');
const VIEWER = 'https://schemat.io/view';

/**
 * sha256 of the reference export with the block-shape pass OFF (21063, auto
 * resolution, otherwise defaults) — the invariant that must never move without
 * a deliberate decision. Shapes ON is gated by content diff, not by hash, since
 * a shape refinement is a legitimate change to it.
 *
 * Re-derived 2026-09-08 (was d158bebb54…3fd7) by the inter-part contact pass;
 * before that 52d221188f…4be6b, retired 2026-09-02 by the geometry resolver's
 * half-assembled-part race fix. See scripts/_schem_ref.ts.
 */
const BASELINE_SHA = '53dac11a867f174e4bec7d4d986210ba36381b34a8d7c20d9125a12f939e40e2';

mkdirSync(OUT_DIR, { recursive: true });
const viewOnly = SOURCE.toLowerCase().endsWith('.schem');
const schemPath = viewOnly ? resolve(SOURCE) : resolve(OUT_DIR, `${LABEL}.schem`);

// ── 1. Export through the shared pipeline (unless handed a .schem) ──────────
if (viewOnly) {
  const sha = createHash('sha256').update(readFileSync(schemPath)).digest('hex');
  console.log(`[export] (skipped) viewing ${schemPath}`);
  console.log(`[export] sha256 ${sha}`);
} else {
  console.log(`[export] ${SOURCE} → ${schemPath}`);
  // `--no-shapes` (block-shape pass off) is what the BASELINE_SHA gate below
  // measures; pass a .schem path directly to view a shapes-ON build.
  const refOut = execFileSync('bun', ['scripts/_schem_ref.ts', SOURCE, schemPath, '', '--no-shapes'], {
    encoding: 'utf-8', maxBuffer: 1 << 24,
  });
  const ref = JSON.parse(refOut);
  console.log(`[export] cellLDU ${ref.cellLDU} · ${ref.dims.join('×')} · ${ref.nonAir.toLocaleString()} blocks`);
  console.log(`[export] palette (${ref.palette.length}): ${ref.palette.join(', ')}`);
  console.log(`[export] sha256 ${ref.schemSha256}`);
  if (LABEL === '21063') {
    console.log(ref.schemSha256 === BASELINE_SHA
      ? '[gate ] BYTE-IDENTICAL to the reference baseline ✓'
      : `[gate ] ⚠ HASH DRIFT — expected ${BASELINE_SHA}`);
  }
}

// ── 2. Load it in schemat.io ────────────────────────────────────────────────
// System Chrome (channel) — the ms-playwright chromium builds on this box
// mismatch playwright-core's protocol version and hang on launch.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, channel: undefined } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

console.log(`[view  ] ${VIEWER}`);
await page.goto(VIEWER, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// The drop zone hides a real <input type=file accept=".schem,…"> — set it
// directly rather than driving the file chooser.
const input = page.locator('input[type=file][accept*=".schem"]').first();
await input.setInputFiles(schemPath);

// Give the viewer time to parse + build the mesh (a 1.2M-block model is slow).
await page.waitForTimeout(25_000);

// Optional camera moves, so two builds can be A/B'd on the SAME close view —
// the default framing puts a big model at ~15% of the canvas, where a half-block
// shape change is sub-pixel. `--zoom N` scrolls N notches in (negative = out),
// `--orbit DX,DY` drags the canvas by that many pixels first.
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const orbit = arg('--orbit');
const box = await page.locator('canvas').first().boundingBox();
const cx = box ? box.x + box.width / 2 : 720;
const cy = box ? box.y + box.height / 2 : 500;
if (orbit) {
  const [dx, dy] = orbit.split(',').map(Number);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + (dx || 0), cy + (dy || 0), { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
}
const zoom = Number(arg('--zoom') ?? 0);
if (zoom) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < Math.abs(zoom); i++) {
    await page.mouse.wheel(0, zoom > 0 ? -120 : 120);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
}

const shot = resolve(OUT_DIR, `schemat-io-${LABEL}.png`);
await page.screenshot({ path: shot });
console.log(`[view  ] screenshot → ${shot}`);
if (consoleErrors.length) console.log(`[view  ] page console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);

// A trivially-empty canvas (viewer failed) usually means a tiny PNG.
const bytes = existsSync(shot) ? readFileSync(shot).length : 0;
console.log(`[view  ] png ${(bytes / 1024).toFixed(0)} KB · md5 ${createHash('md5').update(readFileSync(shot)).digest('hex').slice(0, 12)}`);
console.log('[verdict] inspect the screenshot: colours must match the set (21063 = WHITE castle, no translucent walls).');

await browser.close();
