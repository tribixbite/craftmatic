/**
 * Open a built `.mcaddon` in the LEGO tab's add-on walk and screenshot it.
 *
 * The walk draws what the pack actually ships — the collider blocks and, with
 * the `model` legend row on, what the entity looks like in game — so it
 * answers "does this pack put the right thing in the world" without a device.
 *
 * Runs under NODE (chromium.launch hangs under bun here) with
 * serviceWorkers blocked (the PWA worker intercepts /lego-models/*).
 *
 * Usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers]
 *   layers: comma-separated legend kinds to leave ON, e.g. "model" or
 *           "model,collider". Default: whatever the walk opens with.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , packPath, outPath, layersArg] = process.argv;
if (!packPath || !outPath) {
  console.error('usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers]');
  process.exit(64);
}
const wanted = layersArg ? layersArg.split(',').map(s => s.trim()).filter(Boolean) : null;
mkdirSync(outPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

await page.goto('http://localhost:4000/?tab=lego', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lego-addon-walk-file', { state: 'attached', timeout: 30000 });
await page.setInputFiles('#lego-addon-walk-file', resolve(packPath));

// The walk mounts its own panel; wait for the legend rather than a timer.
await page.waitForSelector('.ap-tog', { timeout: 120000 });
await page.waitForTimeout(2500);

if (wanted) {
  // Each legend row has a show/hide toggle keyed by `data-kind`.
  const kinds = await page.$$eval('.ap-tog[data-act="show"]', els =>
    els.map(e => ({ kind: e.dataset.kind, on: e.getAttribute('aria-pressed') === 'true' })));
  for (const { kind, on } of kinds) {
    const shouldBeOn = wanted.includes(kind);
    if (on !== shouldBeOn) {
      await page.click(`.ap-tog[data-act="show"][data-kind="${kind}"]`);
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(1200);
}

// Fly out so the shot shows the model, not the inside of a brick: free-fly,
// then rise and back off. A walk that opens at the player's eye height is
// standing inside the build.
await page.mouse.click(900, 430);
await page.keyboard.press('KeyF');
await page.waitForTimeout(300);
for (let i = 0; i < 40; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(30); }
for (let i = 0; i < 150; i++) { await page.keyboard.press('KeyS'); await page.waitForTimeout(20); }
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);

const state = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.ap-tog[data-act="show"]')]
    .map(e => `${e.dataset.kind}:${e.getAttribute('aria-pressed') === 'true' ? 'on' : 'off'}`);
  const title = document.querySelector('.ap-title')?.textContent?.trim().slice(0, 120) ?? '';
  const legend = (document.querySelector('.ap-legend, .ap-panel')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400);
  return { title, layers: rows, legend };
});

await page.screenshot({ path: outPath });
console.log(JSON.stringify({ pack: packPath, out: outPath, ...state, errors: errors.slice(0, 5) }, null, 1));
await browser.close();
