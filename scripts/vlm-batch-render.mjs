/**
 * vlm-batch-render.mjs — headless renders of indexed LEGO sets for VLM grading.
 *
 * For each set number: loads the set through the REAL app (dev server, the
 * same indexed auto-load path prod uses), waits for the render, screenshots
 * ONLY the viewer canvas (no UI chrome — cleaner for the grader), fetches the
 * Rebrickable box image, and appends a {set, render, box} line to pairs.jsonl
 * for clego/vlm_grade.py --batch.
 *
 * Usage:
 *   bun scripts/vlm-batch-render.mjs sets.txt output/vlm-renders
 *   (dev server must be running: bun dev:web)
 *
 * Sets that fail to load within the timeout are recorded in failed.txt and
 * skipped. Resumable: sets with an existing render PNG are skipped.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const [, , setsFile, outDir] = process.argv;
if (!setsFile || !outDir) {
  console.error('usage: bun scripts/vlm-batch-render.mjs <sets.txt> <outDir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const DEV = process.env.DEV_URL ?? 'http://localhost:4000';
const LOAD_TIMEOUT_MS = 150_000;

// Lines: "<set>" (load via search+click = current top indexed source) or
// "<set>\t<abs path to .ldr/.io>" (load that FILE via the upload input —
// for grading CANDIDATE conversions that are not indexed yet).
const sets = readFileSync(setsFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
  .map(line => {
    const [set, file] = line.split('\t');
    return { set: set.trim(), file: file?.trim() };
  });

// System Chrome (channel) — the ms-playwright chromium builds on this box
// mismatch playwright-core's protocol version and hang on launch.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, channel: undefined } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${DEV}/#lego`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'LEGO');
  btn?.click();
});
await page.waitForTimeout(1500);

import { resolve } from 'node:path';
let done = 0;
for (const { set, file } of sets) {
  const renderPath = resolve(outDir, `render-${set}.png`);
  const boxPath = resolve(outDir, `box-${set}.jpg`);
  if (existsSync(renderPath) && existsSync(boxPath)) { done++; continue; }

  let marker; // status text that proves THIS load finished
  if (file) {
    // Upload-mode: feed the candidate file through the real upload input.
    const text = readFileSync(file, 'utf-8');
    marker = `cand-${set}`;
    const ok = await page.evaluate(async ({ text, name }) => {
      const input = document.getElementById('lego-mpd-input');
      if (!input) return false;
      const f = new File([text], `${name}.ldr`, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { text, name: marker });
    if (!ok) {
      appendFileSync(join(outDir, 'failed.txt'), `${set}\tno-upload-input\n`);
      continue;
    }
  } else {
    marker = set;
    const result = await page.evaluate(async (setnum) => {
      const input = document.getElementById('lego-search');
      input.value = setnum;
      document.getElementById('lego-search-btn').click();
      await new Promise(r => setTimeout(r, 2500));
      const card = [...document.querySelectorAll('.lego-result-card')]
        .find(c => new RegExp(setnum).test(c.textContent));
      if (!card) return 'no-card';
      card.click();
      return 'clicked';
    }, set);
    if (result !== 'clicked') {
      appendFileSync(join(outDir, 'failed.txt'), `${set}\t${result}\n`);
      continue;
    }
  }

  let loaded = false;
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
    await page.waitForTimeout(1500);
    loaded = await page.evaluate((m) => {
      const status = document.getElementById('lego-status')?.textContent ?? '';
      return /bricks rendered/.test(status) && status.includes(m);
    }, marker);
    if (loaded) break;
  }
  if (!loaded) {
    appendFileSync(join(outDir, 'failed.txt'), `${set}\ttimeout\n`);
    continue;
  }

  // Frame + force a fresh frame, then screenshot the canvas element only.
  await page.evaluate(async () => {
    const v = window.__ldrawViewer;
    if (v) { v.setView('iso'); await new Promise(r => setTimeout(r, 2200)); v.composer.render(); }
  });
  const canvas = page.locator('#lego-viewer canvas, .viewer-area canvas, .inline-viewer canvas').first();
  await canvas.screenshot({ path: renderPath });

  if (!existsSync(boxPath)) {
    try {
      execSync(`curl -s --max-time 15 -o "${boxPath}" "https://cdn.rebrickable.com/media/sets/${set}-1.jpg"`);
    } catch { /* box art optional-fail */ }
  }
  if (existsSync(boxPath)) {
    appendFileSync(join(outDir, 'pairs.jsonl'),
      JSON.stringify({ set, render: renderPath.replaceAll('\\', '/'), box: boxPath.replaceAll('\\', '/') }) + '\n');
  } else {
    appendFileSync(join(outDir, 'failed.txt'), `${set}\tno-box-art\n`);
  }
  done++;
  console.log(`[${done}/${sets.length}] ${set} rendered`);
}
await browser.close();
console.log(`done: ${done}/${sets.length}`);
