#!/usr/bin/env node
/**
 * Mirror the LDraw parts library into the `lego-models` R2 bucket so the prod
 * worker serves geometry SELF-HOSTED (R2-first) instead of live-proxying
 * library.ldraw.org, which rate-limits cold big-set bursts (prod incident
 * 2026-08-17: thousands of real parts reported "missing").
 *
 * Keys: ldraw/<relpath-under-library-root>, LOWERCASED (R2 keys are
 * case-sensitive; the client's normId() lowercases every request).
 *   ldraw/parts/3001.dat · ldraw/p/stud.dat · ldraw/unofficial/parts/x.dat
 *
 * ── Source of truth: the UPSTREAM release archives, not a local install ──────
 * The original (2026-08-18) sync uploaded from the LDraw library bundled with
 * Studio (`C:/git/clego/extracted/.../app/ldraw`). That snapshot is frozen at
 * LDraw release 207 — 12,136 official parts against upstream's 24,737 — so
 * every mold released since 2020 was missing from R2 AND (because
 * library.ldraw.org throttles) unreliable via the worker's upstream fallback.
 * Symptom: 10316 Rivendell reported "152 pieces of 14 part types not in
 * library". This script now pulls the two authoritative archives:
 *   official   https://library.ldraw.org/library/updates/complete.zip
 *   unofficial https://library.ldraw.org/library/unofficial/ldrawunf.zip
 *
 * ── Delta is STATELESS ──────────────────────────────────────────────────────
 * No done-file, no committed manifest: the R2 list API returns each object's
 * etag (= content MD5 for our single-shot PUTs), so the delta is computed by
 * comparing archive-content MD5s against R2 etags. New + changed files upload;
 * everything else is skipped. Keys that exist only in R2 (parts retired
 * upstream) are LEFT ALONE — deleting them could break older models.
 *
 * Run:
 *   node scripts/sync-ldraw-r2.mjs                 # full delta sync
 *   node scripts/sync-ldraw-r2.mjs --dry-run       # report the delta only
 *   node scripts/sync-ldraw-r2.mjs --only '^ldraw/parts/'   # subset
 *   node scripts/sync-ldraw-r2.mjs --limit 200     # cap uploads (smoke test)
 *
 * Env: CLOUDFLARE_API_TOKEN (needs R2 read+write on the account).
 *      CLOUDFLARE_ACCOUNT_ID (optional — auto-discovered when omitted).
 *
 * Cloudflare's REST API rate-limits at ~1200 requests / 5 min, so uploads are
 * paced (adaptive backoff on 429). A weekly delta is tens-to-hundreds of files
 * and finishes in seconds; a cold catch-up of ~13k parts takes ~1 h.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ARCHIVES = [
  { url: 'https://library.ldraw.org/library/updates/complete.zip', file: 'complete.zip', strip: 'ldraw/', prefix: '' },
  { url: 'https://library.ldraw.org/library/unofficial/ldrawunf.zip', file: 'ldrawunf.zip', strip: '', prefix: 'unofficial/' },
];
// Directories the worker actually serves (see worker/ldraw-omr.js candidate keys
// and web/src/viewer/ldraw/parts.ts). `models/` and the loose docs are skipped.
const SERVED_DIRS = /^(parts\/textures\/|parts\/s\/|parts\/|p\/48\/|p\/8\/|p\/)/;
const SERVED_EXT = /\.(dat|png)$/i;

const BUCKET = 'lego-models';
const API = 'https://api.cloudflare.com/client/v4';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes(n);

const DRY = has('--dry-run');
const WORKERS = parseInt(flag('--workers', '8'), 10) || 8;
const LIMIT = parseInt(flag('--limit', '0'), 10) || 0;
const ONLY = flag('--only', '') ? new RegExp(flag('--only', '')) : null;
const CACHE = flag('--cache', join(tmpdir(), 'ldraw-sync-cache'));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN is not set'); process.exit(1); }

// ── Cloudflare helpers ──────────────────────────────────────────────────────
const auth = { Authorization: `Bearer ${TOKEN}` };

async function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await fetch(`${API}/accounts`, { headers: auth });
  const j = await r.json();
  if (!j.success || !j.result?.length) throw new Error('cannot resolve account id: ' + JSON.stringify(j.errors));
  if (j.result.length > 1) throw new Error('multiple accounts — set CLOUDFLARE_ACCOUNT_ID');
  return j.result[0].id;
}

/** Every object under `ldraw/` → Map(key → etag). ~48 paged requests for 48k. */
async function listR2(acct) {
  const map = new Map();
  let cursor = '';
  for (;;) {
    const u = new URL(`${API}/accounts/${acct}/r2/buckets/${BUCKET}/objects`);
    u.searchParams.set('prefix', 'ldraw/');
    u.searchParams.set('per_page', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers: auth });
    if (r.status === 429) { await sleep(5000); continue; }
    const j = await r.json();
    if (!j.success) throw new Error('list failed: ' + JSON.stringify(j.errors));
    for (const o of j.result) map.set(o.key, o.etag);
    cursor = j.result_info?.cursor || '';
    if (!cursor || j.result.length === 0) break;
    if (map.size % 10000 < 1000) process.stdout.write(`  listed ${map.size}\r`);
  }
  return map;
}

let backoff = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Object keys go in the URL PATH, so every segment must be percent-encoded — the
 * library really does ship names with `#` in them (`p/box3#8p.dat`), and an
 * unencoded `#` truncates the URL at the fragment, silently addressing the
 * wrong key. `/` stays literal so the key's own structure survives.
 */
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

async function putObject(acct, key, buf) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (backoff) await sleep(backoff);
    let r;
    try {
      r = await fetch(`${API}/accounts/${acct}/r2/buckets/${BUCKET}/objects/${encodeKey(key)}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': key.endsWith('.png') ? 'image/png' : 'text/plain' },
        body: buf,
      });
    } catch { await sleep(1000 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) {
      backoff = Math.min(backoff ? backoff * 2 : 250, 8000);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    backoff = Math.max(0, backoff - 25);
    if (r.ok) return true;
    return false;
  }
  return false;
}

// ── Minimal ZIP reader (central directory + raw inflate; no dependencies) ────
function readZip(buf) {
  // End of central directory: scan backwards for the 0x06054b50 signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  // ZIP64 tail (complete.zip is under 4 GB today, but be safe).
  if (cdOff === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
        break;
      }
    }
  }
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith('/')) continue;
    out.push({ name, method, compSize, localOff });
  }
  return out.map(e => ({
    name: e.name,
    read() {
      const lnLen = buf.readUInt16LE(e.localOff + 26);
      const leLen = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + e.compSize);
      return e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    },
  }));
}

async function fetchArchive({ url, file }) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  // Re-download when older than a day so a same-day rerun is free.
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < 20 * 3600e3;
  if (fresh) { console.log(`  ${file}: cached (${(statSync(path).size / 1e6).toFixed(0)} MB)`); return readFileSync(path); }
  console.log(`  ${file}: downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(path, buf);
  console.log(`  ${file}: ${(buf.length / 1e6).toFixed(0)} MB`);
  return buf;
}

// ── Main ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
console.log('LDraw → R2 delta sync');

/** key → { md5, read() } for everything the worker serves. */
const want = new Map();
for (const a of ARCHIVES) {
  const buf = await fetchArchive(a);
  let kept = 0;
  for (const e of readZip(buf)) {
    let rel = e.name.replace(/\\/g, '/');
    if (a.strip && rel.startsWith(a.strip)) rel = rel.slice(a.strip.length);
    else if (a.strip) continue;
    if (!SERVED_EXT.test(rel) || !SERVED_DIRS.test(rel)) continue;
    const key = ('ldraw/' + a.prefix + rel).toLowerCase();
    if (ONLY && !ONLY.test(key)) continue;
    want.set(key, e);
    kept++;
  }
  console.log(`  ${a.file}: ${kept} served files`);
}
console.log(`upstream: ${want.size} files`);

const acct = await accountId();
console.log('listing R2 …');
const have = await listR2(acct);
console.log(`R2: ${have.size} objects under ldraw/`);

const todo = [];
let same = 0;
for (const [key, entry] of want) {
  const buf = entry.read();
  const md5 = createHash('md5').update(buf).digest('hex');
  const etag = have.get(key);
  if (etag === md5) { same++; continue; }
  todo.push({ key, buf, kind: etag ? 'changed' : 'new' });
}
// New files first: a missing part is a hole in the render, whereas a "changed"
// one is usually just the 2024 CC-BY relicense header rewrite. An interrupted
// run therefore always leaves the highest-value work done.
todo.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'new' ? -1 : 1));
const nNew = todo.filter(t => t.kind === 'new').length;
console.log(`delta: ${nNew} new, ${todo.length - nNew} changed, ${same} unchanged`);

if (DRY) {
  for (const t of todo.slice(0, 40)) console.log(`  ${t.kind.padEnd(7)} ${t.key}`);
  if (todo.length > 40) console.log(`  … ${todo.length - 40} more`);
  process.exit(0);
}
if (!todo.length) { console.log('nothing to do'); process.exit(0); }

const queue = LIMIT ? todo.slice(0, LIMIT) : todo;

/** One pass over `items`; returns the ones that never succeeded. */
async function runPass(items, workers, label) {
  let ok = 0, fail = 0, i = 0;
  const failed = [];
  const t = Date.now();
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      if (await putObject(acct, item.key, item.buf)) ok++;
      else { fail++; failed.push(item); }
      const n = ok + fail;
      if (n % 100 === 0) {
        const rate = n / ((Date.now() - t) / 60000);
        console.log(`${label}${n}/${items.length} ok=${ok} fail=${fail} (${rate.toFixed(0)}/min, ETA ${((items.length - n) / rate).toFixed(0)} min)`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  console.log(`${label}pass done: ok=${ok} fail=${fail} of ${items.length} in ${((Date.now() - t) / 60000).toFixed(1)} min`);
  return failed;
}

let remaining = await runPass(queue, WORKERS, '');
// Cloudflare's API rate-limits at ~1200 requests / 5 min, and a long run drifts
// into it: a cold catch-up saw a few hundred keys exhaust their in-request
// retries in one burst. Those are throttle victims, not bad data, so cool off
// and take another pass at just them with a fraction of the concurrency rather
// than failing the job and waiting a week for the next schedule.
if (remaining.length) {
  console.log(`retrying ${remaining.length} throttled key(s) after a 90 s cool-off`);
  await sleep(90_000);
  backoff = 0;
  remaining = await runPass(remaining, Math.max(2, Math.floor(WORKERS / 8)), 'retry ');
}

console.log(`DONE: ${queue.length - remaining.length}/${queue.length} uploaded in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${remaining.length} still failing`);
if (remaining.length) {
  console.log('still failing (the next run recomputes the delta and picks them up):');
  for (const it of remaining.slice(0, 50)) console.log('  ' + it.key);
}
process.exit(remaining.length ? 1 : 0);
