/**
 * Headless check of the LEGO tab's custom-minifig popover against the dev
 * server: open the popover, set a torso/hair/held item, click Download and
 * capture the .mcaddon the browser downloads; print its size, the status line
 * and the entity files inside it.
 *
 *   node scripts/_minifig_browser_check.mjs [outDir]     (DEV_URL=http://localhost:4000)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'output/minifig-browser-check';
mkdirSync(outDir, { recursive: true });
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click(); });
await page.waitForTimeout(1200);

const btn = page.locator('button', { hasText: 'Minifig' }).first();
await btn.click();
await page.waitForSelector('.mf-pop.is-open', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('#mf-torso-color option').length > 20, null, { timeout: 10000 });
await page.fill('#mf-label', 'Browser Knight');
await page.fill('#mf-torso', '973');
await page.selectOption('#mf-torso-color', '4');
await page.fill('#mf-hair', '3901');
await page.selectOption('#mf-hair-color', '0');
await page.fill('#mf-held-right', '3847');
await page.selectOption('#mf-held-right-color', '71');
await page.check('#mf-cape');
await page.selectOption('#mf-cape-color', '4');
await page.screenshot({ path: join(outDir, 'popover.png') });

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 120000 }),
  page.click('#mf-export'),
]);
const file = join(outDir, download.suggestedFilename());
await download.saveAs(file);
await page.waitForTimeout(500);
const status = await page.evaluate(() => document.getElementById('lego-status')?.textContent ?? '');
const result = await page.evaluate(() => document.querySelector('.mf-pop [data-role="result"]')?.textContent ?? '');
await page.screenshot({ path: join(outDir, 'after-export.png') });
await browser.close();

console.log(JSON.stringify({ file, bytes: statSync(file).size, result, status: status.slice(0, 400), errors }, null, 1));
