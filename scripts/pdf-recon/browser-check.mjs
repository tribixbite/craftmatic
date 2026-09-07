import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.env.AUDIT_OUT ?? 'output/pdf-recon-audit/browser');
mkdirSync(out, { recursive: true });
const base = process.env.AUDIT_URL ?? 'http://127.0.0.1:4000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${base}/#lego`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'LEGO', exact: true }).first().click();
  await page.locator('#lego-source-filter').waitFor({ state: 'visible' });
  await page.locator('#lego-source-filter').selectOption('recon');
  await page.waitForFunction(() => /sets? found/.test(document.querySelector('#lego-status')?.textContent ?? ''), null, { timeout: 90000 });
  const search = await page.evaluate(async () => {
    const [idx, catalog] = await Promise.all([
      fetch('/lego-models-index.json').then(r => r.json()),
      fetch('/lego-catalog.json').then(r => r.json()),
    ]);
    function best(sn) {
      const models = (idx.sets[sn] ?? idx.sets[sn.replace(/-\d+$/, '')])?.models ?? [];
      return models[0]?.conv ? (models.find(m => !m.conv) ?? models[0]) : models[0];
    }
    const expected = catalog.sets.filter(s => {
      const src = best(s.set_num)?.src ?? '';
      return src === 'pdf_recon' || src.startsWith('recon');
    }).length;
    return { expected, status: document.querySelector('#lego-status').textContent,
             cards: document.querySelectorAll('.lego-result-card').length,
             more: document.querySelector('#lego-show-more')?.textContent };
  });
  if (!search.status.includes(search.expected.toLocaleString('en-US'))) {
    throw new Error(`Search count mismatch: ${JSON.stringify(search)}`);
  }
  writeFileSync(`${out}/search.json`, JSON.stringify(search, null, 2));
  await page.screenshot({ path: `${out}/search.png` });
  if (base.startsWith('https://')) {
    writeFileSync(`${out}/prod-errors.json`, JSON.stringify(errors, null, 2));
  } else {
    const files = [
      ['truth-41624', 'C:/git/clego/lego_sets/OMR/41624-1.mpd'],
      ['vlm-41624', 'C:/git/clego/lego_sets/ReconV8/41624.ldr'],
      ['pdfdet-41624', 'output/pdf-recon-audit/deterministic-v5/template/41624/41624.ldr'],
      ['pdfdet-40377', 'output/pdf-recon-audit/deterministic-v5/template/40377/40377.ldr'],
    ];
    const renders = [];
    for (const [name, path] of files) {
      await page.evaluate(({ text, name }) => {
        const input = document.querySelector('#lego-mpd-input');
        const dt = new DataTransfer();
        dt.items.add(new File([text], `${name}.ldr`, { type: 'text/plain' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, { text: readFileSync(path, 'utf8'), name });
      await page.waitForFunction(name => {
        const s = document.querySelector('#lego-status')?.textContent ?? '';
        return s.includes(name) && s.includes('bricks rendered');
      }, name, { timeout: 180000 });
      await page.evaluate(() => window.__ldrawViewer.setView('iso'));
      await page.waitForTimeout(1500);
      const capture = await page.evaluate(() => ({
        image: window.__ldrawViewer.captureScreenshot(),
        status: document.querySelector('#lego-status').textContent,
      }));
      writeFileSync(`${out}/${name}.png`, Buffer.from(capture.image.split(',')[1], 'base64'));
      renders.push({ name, path, status: capture.status });
      console.log(name, capture.status);
    }
    writeFileSync(`${out}/renders.json`, JSON.stringify({ search, renders, errors }, null, 2));
  }
  console.log(JSON.stringify(search));
} finally {
  await browser.close();
}
