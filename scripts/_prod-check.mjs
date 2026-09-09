import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [, , set, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
await p.goto('https://craftmatic.click/#lego', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
await p.evaluate(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'LEGO')?.click());
await p.waitForTimeout(1500);
await p.evaluate(() => { const c = document.getElementById('lego-stats'); if (c && !c.checked) c.click(); });
const r = await p.evaluate(async s => {
  const i = document.getElementById('lego-search'); i.value = s;
  document.getElementById('lego-search-btn').click();
  await new Promise(x => setTimeout(x, 3000));
  const card = [...document.querySelectorAll('.lego-result-card')].find(c => new RegExp(s).test(c.textContent));
  if (!card) return 'no-card'; card.click(); return 'clicked';
}, set);
if (r !== 'clicked') { console.log(JSON.stringify({ set, error: r })); await b.close(); process.exit(1); }
let status = '';
for (const t0 = Date.now(); Date.now() - t0 < 260000;) {
  await p.waitForTimeout(2500);
  status = await p.evaluate(() => document.getElementById('lego-status')?.textContent ?? '');
  if (/bricks rendered/.test(status)) break;
}
const canvas = await p.$('#lego-viewer canvas') ?? await p.$('canvas');
for (const v of ['iso', 'front']) {
  await p.evaluate(() => {});
  await p.waitForTimeout(2500);
  for (let k = 0; k < 4; k++) {
    try { await canvas.screenshot({ path: join(outDir, `prod-${set}-${v}.png`), timeout: 25000 }); break; }
    catch { await p.waitForTimeout(1500); }
  }
}
const req = await p.evaluate(() => performance.getEntriesByType('resource')
  .filter(e => /ldd-|lego-models\//.test(e.name)).map(e => e.name.replace(/^https?:\/\/[^/]+/, '')));
console.log(JSON.stringify({ set, status: status.slice(-500), assets: req }, null, 1));
await b.close();
