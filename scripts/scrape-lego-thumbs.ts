#!/usr/bin/env bun
/**
 * Download all LEGO set thumbnail images from Rebrickable CDN.
 * Saves to web/public/lego-thumbs/{set_num}.jpg
 * Skips already-downloaded files.
 *
 * Usage: bun scripts/scrape-lego-thumbs.ts [--concurrency 20]
 *
 * ~22k images at ~15-50 KB each ≈ ~400-800 MB total.
 * First run takes ~30-60 min depending on connection.
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CDN_CSV  = 'https://cdn.rebrickable.com/media/downloads/sets.csv.gz';
const CDN_IMG  = 'https://cdn.rebrickable.com/media/sets';
const OUT_DIR  = resolve(import.meta.dir, '../web/public/lego-thumbs');
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '20');

// ─── Setup ───────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

// ─── Download + parse sets.csv.gz ────────────────────────────────────────────

console.log('Fetching sets.csv.gz…');
const csvResp = await fetch(CDN_CSV);
if (!csvResp.ok) throw new Error(`HTTP ${csvResp.status} fetching sets.csv.gz`);
const csvBuf = await csvResp.arrayBuffer();
const csvText = new TextDecoder().decode(gunzipSync(Buffer.from(csvBuf)));

const lines = csvText.split('\n');
const header = lines[0]?.split(',').map(s => s.trim().toLowerCase()) ?? [];
const iNum = header.indexOf('set_num');
if (iNum < 0) throw new Error('set_num column not found in CSV');

const setNums: string[] = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i]?.trim();
  if (!line) continue;
  // Simple split by comma (set_num never contains commas or quotes)
  const num = line.split(',')[iNum]?.trim();
  if (num) setNums.push(num);
}

console.log(`Found ${setNums.length.toLocaleString()} sets in catalog.`);

// ─── Filter already-downloaded ───────────────────────────────────────────────

const todo = setNums.filter(n => !existsSync(join(OUT_DIR, `${n}.jpg`)));
console.log(`${(setNums.length - todo.length).toLocaleString()} already downloaded, ${todo.length.toLocaleString()} remaining.`);

if (todo.length === 0) {
  console.log('All thumbnails already present. Done.');
  process.exit(0);
}

// ─── Download with concurrency limit ─────────────────────────────────────────

let done = 0;
let failed = 0;
const failures: string[] = [];
const startTime = Date.now();

async function downloadOne(setNum: string): Promise<void> {
  const url  = `${CDN_IMG}/${encodeURIComponent(setNum)}.jpg`;
  const dest = join(OUT_DIR, `${setNum}.jpg`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status !== 404) {
        failures.push(`${setNum}: HTTP ${resp.status}`);
        failed++;
      }
      // 404 = no image for this set — expected for many sets, just skip
      return;
    }
    const buf = await resp.arrayBuffer();
    writeFileSync(dest, Buffer.from(buf));
  } catch (err) {
    failures.push(`${setNum}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  } finally {
    done++;
    if (done % 500 === 0 || done === todo.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = done / elapsed;
      const eta = (todo.length - done) / rate;
      const pct = ((done / todo.length) * 100).toFixed(1);
      console.log(
        `  ${pct}% — ${done.toLocaleString()}/${todo.length.toLocaleString()} ` +
        `(${rate.toFixed(0)}/s, ETA ${Math.round(eta)}s, ${failed} failed)`,
      );
    }
  }
}

// Run in batches of CONCURRENCY
for (let i = 0; i < todo.length; i += CONCURRENCY) {
  await Promise.all(todo.slice(i, i + CONCURRENCY).map(downloadOne));
}

// ─── Report ──────────────────────────────────────────────────────────────────

const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
const saved = todo.length - failed;
console.log(`\nDone in ${elapsed}s. Saved ${saved.toLocaleString()} images, ${failed} failures.`);

if (failures.length > 0) {
  console.log('\nFirst 20 failures:');
  failures.slice(0, 20).forEach(f => console.log('  ' + f));
}
