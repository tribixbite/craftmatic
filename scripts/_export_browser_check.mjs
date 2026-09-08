/**
 * Browser gate for the Minecraft export: drives the REAL LEGO tab in Chrome
 * against the dev server, so the Web-Worker path, the settings popover and the
 * progress banner are all exercised the way a user exercises them.
 *
 * What it checks
 *   1. the ⚙ MC settings popover lists every resolution option (incl. 10/stud);
 *   2. a .schem export completes through the Worker and downloads;
 *   3. how long the export took, and the phases the banner reported.
 *
 * Usage (node, NOT bun — chromium.launch hangs under bun on this box):
 *   node scripts/_export_browser_check.mjs [model.io] [label]
 * Requires `bun dev:web` on port 4000.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const SOURCE = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/76416-1.io';
const LABEL = process.argv[3] ?? 'browser';
const OUT = resolve('output/vox-work');
mkdirSync(OUT, { recursive: true });

// The upload input takes a real file; keep it out of the repo tree.
const tmp = resolve(OUT, `upload-${basename(SOURCE)}`);
copyFileSync(SOURCE, tmp);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:4000/', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /LEGO/i }).first().click().catch(() => {});
await page.waitForTimeout(1500);

// ── 1. resolution options ───────────────────────────────────────────────────
await page.locator('#mc-settings-btn, button:has-text("MC settings")').first().click();
await page.waitForTimeout(400);
const options = await page.locator('select').evaluateAll(
  sels => sels.flatMap(s => [...s.options].map(o => `${o.value}:${o.textContent.trim()}`)),
);
const resOptions = options.filter(o => /stud|Auto/.test(o));
console.log('[settings] resolution options:', JSON.stringify(resOptions));
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(200);

// ── 2. load a model ─────────────────────────────────────────────────────────
await page.locator('#lego-mpd-input').setInputFiles(tmp);
const t0 = Date.now();
await page.waitForFunction(
  () => /brick|piece/i.test(document.querySelector('#lego-status')?.textContent ?? ''),
  { timeout: 240_000 },
);
await page.waitForTimeout(6000);
console.log(`[load    ] ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('[load    ] status:', (await page.locator('#lego-status').textContent() ?? '').replace(/\s+/g, ' ').slice(-260));

// ── 3. export .schem through the Worker ─────────────────────────────────────
const phases = new Set();
const poll = setInterval(async () => {
  const t = await page.locator('#export-progress-bar').first()
    .textContent().catch(() => null);
  if (t) phases.add(t.replace(/\s+/g, ' ').trim());
}, 250);

const dlPromise = page.waitForEvent('download', { timeout: 600_000 });
const sel = page.locator('select').filter({ hasText: /schem|Download|GLB/i }).first();
const tExport = Date.now();
// The download menu is a <select>; pick the .schem entry by its label.
const chosen = await sel.evaluate(s => {
  const o = [...s.options].find(o => /\.schem/i.test(o.textContent));
  if (!o) return null;
  s.value = o.value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return o.textContent.trim();
});
console.log('[export  ] chose:', chosen);
const dl = await dlPromise;
clearInterval(poll);
const saved = resolve(OUT, `${LABEL}.schem`);
if (existsSync(saved)) rmSync(saved);
await dl.saveAs(saved);
console.log(`[export  ] ${((Date.now() - tExport) / 1000).toFixed(1)} s → ${saved}`);
console.log('[export  ] banner phases:', JSON.stringify([...phases].slice(0, 12)));
console.log('[export  ] status:', (await page.locator('#lego-status').textContent() ?? '').replace(/\s+/g, ' ').slice(-260));
if (errors.length) console.log('[errors  ]', errors.slice(0, 6).join(' | '));

await page.screenshot({ path: resolve(OUT, `${LABEL}.png`) });
await browser.close();
rmSync(tmp, { force: true });
