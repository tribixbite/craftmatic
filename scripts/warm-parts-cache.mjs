#!/usr/bin/env node
/**
 * Gentle edge-cache warmer for the prod /ldraw-parts proxy.
 *
 * Walks the LOCAL LDraw library's primitive dirs (p/, p/48/ — the shared
 * backbone every part resolution depends on) and GETs each file through
 * craftmatic.click/ldraw-parts/ at a polite rate, so the Cloudflare edge
 * caches a 200 for a week (renewed on every hit). After a cold-burst
 * rate-limit incident (2026-08-17) this keeps the primitive tier immune to
 * upstream throttling; individual sets self-heal on reload for the rest.
 *
 * Usage: node scripts/warm-parts-cache.mjs [--rps 3] [--dirs p,p/48]
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIB = 'C:/git/clego/extracted/studio_release/app/ldraw';
const BASE = 'https://craftmatic.click/ldraw-parts';

const args = process.argv.slice(2);
const rps = parseFloat(args[args.indexOf('--rps') + 1] || '3') || 3;
const dirs = (args.includes('--dirs') ? args[args.indexOf('--dirs') + 1] : 'p,p/48').split(',');

const files = [];
for (const d of dirs) {
  try {
    for (const f of readdirSync(join(LIB, d))) {
      if (f.toLowerCase().endsWith('.dat')) files.push(`${d}/${f}`);
    }
  } catch (e) { console.error(`skip ${d}: ${e.message}`); }
}
console.log(`${files.length} primitives to warm at ${rps} rps (~${Math.round(files.length / rps / 60)} min)`);

let ok = 0, miss = 0, throttled = 0, err = 0;
const gap = 1000 / rps;
for (let i = 0; i < files.length; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/${files[i]}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) ok++;
    else if (r.status === 404) miss++;
    else { throttled++; await new Promise(res => setTimeout(res, 4000)); }
    await r.arrayBuffer().catch(() => {});
  } catch { err++; }
  if (i % 200 === 0) console.log(`${i}/${files.length} ok=${ok} miss=${miss} throttled=${throttled} err=${err}`);
  const dt = Date.now() - t0;
  if (dt < gap) await new Promise(res => setTimeout(res, gap - dt));
}
console.log(`DONE: ok=${ok} miss=${miss} throttled=${throttled} err=${err} of ${files.length}`);
