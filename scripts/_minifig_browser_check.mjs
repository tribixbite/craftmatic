/**
 * Headless check of the LEGO tab's custom-minifig popover against the dev
 * server: open the popover, round-trip a backpack through the portable code,
 * export the standalone creator-wand pack, and inspect its script/controllers.
 * It can reuse the isolated browser created by the LEGO probe harness; it never
 * attaches to, creates, or closes a user's normal Chrome profile.
 *
 *   node scripts/_minifig_browser_check.mjs [outDir]     (DEV_URL=http://localhost:4000)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const outDir = process.argv[2] ?? 'output/minifig-browser-check';
mkdirSync(outDir, { recursive: true });
const DEV = process.env.DEV_URL ?? 'http://localhost:4000';

/** Read the standard local ZIP entries emitted by the add-on exporter. Keeping
 * this tiny inspection local lets the documented Node invocation work without
 * loading browser TypeScript modules. */
function readArchiveEntries(archive) {
  const bytes = Buffer.from(archive);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    const name = bytes.toString('utf8', nameStart, nameStart + nameSize);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, data: method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null });
    offset = dataStart + compressedSize;
  }
  if (entries.length === 0) throw new Error('Downloaded add-on is not a readable standard ZIP archive.');
  return entries;
}

const cdpUrl = process.env.PROBE_CDP_URL ?? process.env.CHROME_CDP_URL;
const browser = cdpUrl
  ? await chromium.connectOverCDP(cdpUrl)
  : await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 950 }, acceptDownloads: true, serviceWorkers: 'block',
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const networkErrors = [];
const collect = (list, value) => { if (!list.includes(value)) list.push(value); };
page.on('pageerror', error => collect(pageErrors, String(error).slice(0, 500)));
page.on('console', message => { if (message.type() === 'error') collect(consoleErrors, message.text().slice(0, 500)); });
page.on('requestfailed', request => collect(networkErrors,
  `${request.failure()?.errorText ?? 'request failed'} ${request.url()}`));
page.on('response', response => {
  if (response.status() >= 400) collect(networkErrors, `HTTP ${response.status()} ${response.url()}`);
});

async function openMinifig(target) {
  await target.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
  await target.waitForTimeout(3000);
  await target.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO')?.click(); });
  await target.waitForTimeout(1200);
  await target.locator('button', { hasText: 'Minifig' }).first().click();
  await target.waitForSelector('.mf-pop.is-open', { timeout: 5000 });
  await target.waitForFunction(() => document.querySelectorAll('#mf-torso-color option').length > 20, null, { timeout: 10000 });
}

await openMinifig(page);
await page.fill('#mf-label', 'Browser Knight');
await page.fill('#mf-torso', '973');
await page.selectOption('#mf-torso-color', '4');
await page.fill('#mf-hair', '3901');
await page.selectOption('#mf-hair-color', '0');
await page.fill('#mf-held-right', '3847');
await page.selectOption('#mf-held-right-color', '71');
await page.check('#mf-cape');
await page.selectOption('#mf-cape-color', '4');
await page.fill('#mf-back-part', '2524');
await page.locator('#mf-back-part').dispatchEvent('input');
const figureCode = await page.inputValue('#mf-code');
if (!figureCode.includes('bk=2524:4')) throw new Error(`Backpack was absent from figure code: ${figureCode}`);
await page.fill('#mf-code', figureCode);
await page.locator('#mf-code').dispatchEvent('change');
if (await page.inputValue('#mf-back-part') !== '2524') throw new Error('Figure-code import did not restore backpack part 2524.');
await page.screenshot({ path: join(outDir, 'popover.png') });

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 120000 }),
  page.click('#mf-export-creator'),
]);
const file = join(outDir, download.suggestedFilename());
await download.saveAs(file);
await page.waitForTimeout(500);
const status = await page.evaluate(() => document.getElementById('lego-status')?.textContent ?? '');
const result = await page.evaluate(() => document.querySelector('.mf-pop [data-role="result"]')?.textContent ?? '');
await page.screenshot({ path: join(outDir, 'after-export.png') });
const diskBytes = readFileSync(file);
const archive = diskBytes.buffer.slice(diskBytes.byteOffset, diskBytes.byteOffset + diskBytes.byteLength);
const archiveEntries = readArchiveEntries(archive);
const entries = archiveEntries.map(entry => entry.name);
const scriptEntry = entries.find(entry => /_BP\/scripts\/minifig-wand\.js$/i.test(entry));
if (!scriptEntry) throw new Error(`Creator archive has no minifig-wand.js. Entries: ${entries.join(', ')}`);
const scriptData = archiveEntries.find(entry => entry.name === scriptEntry)?.data;
if (!scriptData) throw new Error(`Creator runtime ${scriptEntry} uses an unsupported ZIP compression method.`);
const script = new TextDecoder().decode(scriptData);
const controllers = entries.filter(entry => /render_controllers\/.*_minifig\.render_controllers\.json$/i.test(entry));
if (!/minifig|creator/i.test(script) || controllers.length === 0) {
  throw new Error(`Creator archive lacks expected creator runtime/controllers (script=${scriptEntry}, controllers=${controllers.length}).`);
}
const diagnosticsEntry = archiveEntries.find(entry => /_BP\/craftmatic-diagnostics\.json$/i.test(entry.name));
if (!diagnosticsEntry?.data) throw new Error('Creator archive has no readable craftmatic-diagnostics.json.');
const entityDiagnostics = JSON.parse(new TextDecoder().decode(diagnosticsEntry.data)).entities;
const diagnosticEntities = Object.entries(entityDiagnostics).map(([entity, diagnostic]) => ({
  entity,
  unresolvedParts: diagnostic.unresolvedParts ?? [],
  aabbFallbackParts: diagnostic.aabbFallbackParts ?? [],
  printFallbackParts: diagnostic.printFallbackParts ?? [],
  substitutedParts: diagnostic.substitutedParts ?? [],
}));
const diagnostics = {
  entities: diagnosticEntities,
  totals: {
    unresolvedParts: diagnosticEntities.reduce((total, entity) => total + entity.unresolvedParts.length, 0),
    aabbFallbackParts: diagnosticEntities.reduce((total, entity) => total + entity.aabbFallbackParts.length, 0),
    printFallbackParts: diagnosticEntities.reduce((total, entity) => total + entity.printFallbackParts.length, 0),
    substitutedParts: diagnosticEntities.reduce((total, entity) => total + entity.substitutedParts.length, 0),
  },
};
if (Object.values(diagnostics.totals).some(total => total !== 0)) {
  throw new Error(`Creator archive has degraded geometry diagnostics: ${JSON.stringify(diagnostics.totals)}`);
}

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
  serviceWorkers: 'block',
});
const mobile = await mobileContext.newPage();
await openMinifig(mobile);
await mobile.screenshot({ path: join(outDir, 'popover-mobile.png') });
const screenshots = ['popover.png', 'after-export.png', 'popover-mobile.png'].map(name => {
  const path = join(outDir, name);
  const size = statSync(path).size;
  if (size >= 4 * 1024 * 1024) throw new Error(`${name} exceeds 4 MB (${size} bytes).`);
  return { name, bytes: size };
});
await mobileContext.close();
await context.close();
// `close` on a CDP-connected Browser disconnects this client after its owned
// contexts have closed; the remote Chrome process and any unrelated tabs stay up.
await browser.close();

console.log(JSON.stringify({
  file, bytes: statSync(file).size, result, status: status.slice(0, 400), figureCode, scriptEntry, controllers,
  diagnostics, screenshots, pageErrors, consoleErrors, networkErrors,
}, null, 1));
