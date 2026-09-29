/**
 * Does the LIVE site draw this set? Loads `<base>/?tab=lego&set=<sku>` in a
 * real Chrome (the deep link selects the set and auto-loads its best indexed
 * model), waits for the viewer's source badge to stop saying "loading", and
 * screenshots the page. Prints one JSON line:
 *   {"ok":true,"seconds":9,"badge":"dbix_conv_v3 · 1,764 parts","status":"","errors":[]}
 * Exit 0 when a model was drawn, 1 when the badge never settled, reported a
 * failure, or the set was not found.
 *
 * Usage (node, NOT bun — chromium.launch hangs under bun on this box):
 *   node scripts/_live_set_check.mjs 11390 [--out shot.png] [--base https://craftmatic.click] [--timeout 150]
 *
 * Service workers are blocked so the check reads the deployed modules, not a
 * cached copy (the PWA trap in CLAUDE.md).
 *
 * — Opus 5.5
 */
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const sku = argv.find(a => !a.startsWith('--'));
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
if (!sku) { console.error('usage: node scripts/_live_set_check.mjs <sku> [--out shot.png] [--base URL] [--timeout s]'); process.exit(2); }
const BASE = opt('base', 'https://craftmatic.click').replace(/\/$/, '');
const OUT = resolve(opt('out', `output/live-set-${sku}.png`));
const TIMEOUT_S = Number(opt('timeout', '150'));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`));

const started = Date.now();
let badge = '', status = '', ok = false, found = true;
try {
  await page.goto(`${BASE}/?tab=lego&set=${encodeURIComponent(sku)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    badge = (await page.locator('#lego-source-badge').textContent().catch(() => '')) ?? '';
    status = (await page.locator('#lego-status').textContent().catch(() => '')) ?? '';
    const lower = `${badge} ${status}`.toLowerCase();
    if (/not in the catalog|not found|no model/.test(lower) && !badge) { found = false; break; }
    if (/fail|error|could not|unable/.test(lower) && !/loading/.test(lower)) break;
    // A settled badge names its source and has no `loading` suffix.
    if (badge && !/loading|…/.test(badge.toLowerCase())) { ok = true; break; }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);           // let the last frame draw
  await page.screenshot({ path: OUT, fullPage: false });
} catch (e) {
  errors.push(`check: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
const seconds = Math.round((Date.now() - started) / 1000);
// Console errors, deduplicated with a count: a part-alias probe can 404 forty
// times and it is one fact, not forty.
const counts = new Map();
for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
const distinct = [...counts].map(([text, n]) => (n > 1 ? `${text} (x${n})` : text));
console.log(JSON.stringify({ ok: ok && found, found, seconds, badge: badge.trim(), status: status.trim(), errors: distinct, screenshot: OUT }));
process.exit(ok && found ? 0 : 1);
