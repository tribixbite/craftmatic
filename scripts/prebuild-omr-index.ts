#!/usr/bin/env bun
/**
 * Pre-build script: scrape the LDraw OMR catalog via its Livewire API
 * and write a compact index to web/public/omr-index.json.
 *
 * Output format: string[]  — sorted list of set_nums in the OMR
 *   e.g. ["10001-1", "10002-1", "10022-1", "10030-1", ...]
 *
 * At runtime, lego.ts uses this to show OMR availability badges.
 * File lookups use {set_num}.mpd (works for ~95% of sets).
 *
 * Usage: bun scripts/prebuild-omr-index.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OMR_SETS_URL = 'https://library.ldraw.org/omr/sets';
const OUT = resolve(import.meta.dir, '../web/public/omr-index.json');
const TOTAL_SETS = 1470;
const PER_PAGE = 25;
const TOTAL_PAGES = Math.ceil(TOTAL_SETS / PER_PAGE); // 59

// ─── Setup: session cookie + Livewire config ──────────────────────────────────

process.stdout.write('Fetching LDraw OMR catalog page… ');
const initResp = await fetch(OMR_SETS_URL, {
  headers: { 'User-Agent': 'craftmatic-prebuild/1.0', 'Accept': 'text/html' },
});
const cookieStr = (initResp.headers.getSetCookie?.() ?? [])
  .map(c => c.split(';')[0]).join('; ');
const html = await initResp.text();

const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
if (!csrf) throw new Error('Could not find CSRF token');

const lwPath = html.match(/(livewire-[a-f0-9]{8})\/update/)?.[1];
if (!lwPath) throw new Error('Could not find Livewire update path');

const wireMatches = [...html.matchAll(/wire:snapshot="([^"]+)"[^>]*wire:id="([^"]+)"[^>]*wire:name="([^"]+)"/g)];
const omrMatch = wireMatches.find(m => m[3] === 'omr.set');
if (!omrMatch) throw new Error('Could not find omr.set component');
let snap = JSON.parse(omrMatch[1].replace(/&quot;/g, '"'));

console.log(`OK (path: /${lwPath}/update)`);

// ─── Livewire request helper ───────────────────────────────────────────────────

async function lwCall(calls: object[]): Promise<string> {
  const resp = await fetch(`https://library.ldraw.org/${lwPath}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrf!,
      'X-Livewire': '1',
      'Referer': OMR_SETS_URL,
      'Origin': 'https://library.ldraw.org',
      'User-Agent': 'craftmatic-prebuild/1.0',
      'Cookie': cookieStr,
    },
    body: JSON.stringify({ components: [{ snapshot: JSON.stringify(snap), updates: {}, calls }] }),
  });
  if (!resp.ok) throw new Error(`Livewire HTTP ${resp.status}`);
  const data = await resp.json() as { components: Array<{ snapshot: string; effects: { html?: string } }> };
  snap = JSON.parse(data.components[0].snapshot);
  return data.components[0].effects.html ?? '';
}

// ─── Extract set numbers from Livewire page HTML ───────────────────────────────
// Thumbnail URLs: /media/omr_models/{omrId}/conversions/{set_num}-thumb.png

function extractSets(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/omr_models\/\d+\/conversions\/(\d+-\d+)-thumb/g)].map(m => m[1]),
  )];
}

// ─── Load first page (triggers table load) ────────────────────────────────────

process.stdout.write('Loading table… ');
const page1Html = await lwCall([{ path: '', method: 'loadTable', params: [] }]);
const allSets = new Set<string>(extractSets(page1Html));
process.stdout.write(`page 1`);

// ─── Paginate through remaining pages (batches of 8) ─────────────────────────

for (let batch = 0; batch < Math.ceil((TOTAL_PAGES - 1) / 8); batch++) {
  const start = 2 + batch * 8;
  const end = Math.min(TOTAL_PAGES + 1, start + 8);
  const pages = await Promise.all(
    Array.from({ length: end - start }, (_, i) =>
      lwCall([{ path: '', method: 'gotoPage', params: [start + i, 'page'] }])
    ),
  );
  for (const pageHtml of pages) extractSets(pageHtml).forEach(s => allSets.add(s));
  process.stdout.write(`, ${end - 1}`);
  // Small polite delay
  await new Promise(r => setTimeout(r, 200));
}
console.log();

const setList = [...allSets].sort();
console.log(`Collected ${setList.length} sets from LDraw OMR`);

// Validate expected count (warn if significantly off)
if (setList.length < 1000) {
  console.warn(`Warning: expected ~1470 sets but got ${setList.length}`);
}

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(resolve(import.meta.dir, '../web/public'), { recursive: true });
writeFileSync(OUT, JSON.stringify(setList));

const kb = (Buffer.byteLength(JSON.stringify(setList)) / 1024).toFixed(1);
console.log(`Written to web/public/omr-index.json (${kb} KB)`);
