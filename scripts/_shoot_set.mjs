/**
 * Load a set in the LEGO tab and screenshot the viewer.
 *
 * A visual check that a parser change reaches the screen: run it, look at the
 * picture. Offline-first, so it costs nothing and needs no device.
 *
 * Runs under NODE, not bun: `chromium.launch` hangs under bun on this box.
 * `serviceWorkers: 'block'` is mandatory — the PWA worker intercepts
 * `/lego-models/*` and a search-loaded set fails with net::ERR_FAILED while
 * curl answers 200, leaving the UI on "No 3D model found".
 *
 * Usage: node scripts/_shoot_set.mjs <set> <out.png> [waitMs]
 *        node scripts/_shoot_set.mjs --file <model.ldr|.mpd|.io|.lxf> <out.png> [waitMs]
 *
 * `--file` loads a local model through the LEGO tab's upload input instead of
 * the index, so a regenerated candidate is drawn by the same viewer as the
 * shipped file without touching the corpus (A/B shots, 2026-09-24).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const fileMode = process.argv[2] === '--file';
const [setNumber, outPath, waitMsArg] = process.argv.slice(fileMode ? 3 : 2);
if (!setNumber || !outPath) {
  console.error('usage: node scripts/_shoot_set.mjs <set> | --file <model> <out.png> [waitMs]');
  process.exit(64);
}
const WAIT = Number(waitMsArg ?? 90000);
mkdirSync(outPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  serviceWorkers: 'block',
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

// CRAFTMATIC_URL points the shot at another dev server (a worktree's own port).
await page.goto(`${process.env.CRAFTMATIC_URL ?? 'http://localhost:4000'}/?tab=lego`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lego-search', { timeout: 30000 });
if (fileMode) {
  // `setNumber` is the model path here; the input is hidden, which setInputFiles allows.
  await page.setInputFiles('#lego-mpd-input', setNumber);
} else {
  await page.fill('#lego-search', setNumber);
  await page.click('#lego-search-btn');
  await page.waitForSelector('.lego-result-card', { timeout: 30000 });

  // Only `.lego-result-card` elements are click targets; a wrapper silently no-ops.
  const cards = await page.$$('.lego-result-card');
  let clicked = false;
  for (const card of cards) {
    const label = (await card.getAttribute('title')) ?? '';
    const text = await card.innerText().catch(() => '');
    if (text.includes(setNumber) || label.includes(setNumber)) { await card.click(); clicked = true; break; }
}
if (!clicked && cards[0]) { await cards[0].click(); clicked = true; }
if (!clicked) { console.log(`NO RESULT CARD for ${setNumber}`); await browser.close(); process.exit(2); }
}

/**
 * Wait for the load to FINISH, not merely to stop changing: a big set sits on
 * one "Loading …" line for a long time, so a stability check alone screenshots
 * an empty canvas and calls it a result.
 */
const read = () => page.evaluate(() => {
  const badge = document.querySelector('.lego-source-badge, #lego-status, .lego-status');
  const canvas = document.querySelector('#lego-viewer canvas');
  return {
    status: badge?.textContent?.trim().slice(0, 160) ?? '',
    hasCanvas: Boolean(canvas),
    // A canvas exists before anything is drawn in it; ask WebGL for the draw
    // count instead by sampling whether the picture is a flat background.
    drawn: canvas ? canvas.width > 0 && canvas.height > 0 : false,
  };
});

const deadline = Date.now() + WAIT;
let last = await read();
let settled = 0;
while (Date.now() < deadline) {
  const now = await read();
  const done = now.hasCanvas && !/loading|prefetch|voxel|resolving/i.test(now.status);
  if (done) { settled++; if (settled >= 4) { last = now; break; } }
  else settled = 0;
  last = now;
  await page.waitForTimeout(750);
}

const viewer = await page.$('#lego-viewer');
await (viewer ?? page).screenshot({ path: outPath });

/** A flat image means the model never drew; report it rather than pass silently. */
const variety = await page.evaluate(() => {
  const canvas = document.querySelector('#lego-viewer canvas');
  if (!canvas) return -1;
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return -2;
  const w = 160, h = 120;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) seen.add((px[i] >> 3 << 10) | (px[i + 1] >> 3 << 5) | (px[i + 2] >> 3));
  return seen.size;
});

console.log(JSON.stringify({ setNumber, out: outPath, ...last, distinctColours: variety, errors: errors.slice(0, 6) }, null, 1));
await browser.close();
