/**
 * Download all LDraw model files from seymouria.pl
 * Saves to data/seymouria/{LDR,IO,LXF}/
 *
 * Usage: bun scripts/download-seymouria.ts
 *        bun scripts/download-seymouria.ts --ldr-only
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = 'https://seymouria.pl/Download';
const OUT_DIR = join(import.meta.dir, '..', 'data', 'seymouria');

const SOURCES = [
  {
    indexUrl: `${BASE_URL}/official-lego-sets-ldr.php`,
    prefix: 'OfficialLegoSets_LDR',
    outDir: 'LDR',
  },
  {
    indexUrl: `${BASE_URL}/official-lego-sets-io.php`,
    prefix: 'OfficialLegoSets_IO',
    outDir: 'IO',
  },
  {
    indexUrl: `${BASE_URL}/official-lego-sets-lxf.php`,
    prefix: 'OfficialLegoSets_LXF',
    outDir: 'LXF',
  },
] as const;

const CONCURRENCY = 4;     // parallel downloads
const DELAY_MS   = 200;    // polite delay between each request
const args = process.argv.slice(2);
const ldrOnly = args.includes('--ldr-only');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractLinks(html: string, prefix: string): string[] {
  const re = new RegExp(`"\\./(?:${prefix}/([^"]+))"`, 'g');
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    files.push(m[1]);
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function downloadFile(url: string, dest: string): Promise<'ok' | 'skip' | 'err'> {
  if (await exists(dest)) return 'skip';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    await writeFile(dest, Buffer.from(buf));
    return 'ok';
  } catch (e) {
    console.error(`  FAIL ${url}: ${e instanceof Error ? e.message : e}`);
    return 'err';
  }
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

async function downloadAll(
  files: string[],
  prefix: string,
  outDir: string,
): Promise<void> {
  const dir = join(OUT_DIR, outDir);
  await mkdir(dir, { recursive: true });

  let ok = 0, skip = 0, err = 0;
  const queue = [...files];
  const workers: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const filename = queue.shift()!;
      const url  = `${BASE_URL}/${prefix}/${encodeURIComponent(filename)}`;
      const dest = join(dir, filename);
      await mkdir(join(dir, '..', outDir), { recursive: true });
      const res = await downloadFile(url, dest);
      if (res === 'ok')   { ok++;   process.stdout.write('.'); }
      if (res === 'skip') { skip++;  process.stdout.write('s'); }
      if (res === 'err')  { err++;   process.stdout.write('!'); }
      if (res !== 'skip') await sleep(DELAY_MS);
    }
  }

  const n = Math.min(CONCURRENCY, files.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  console.log(`\n  ${outDir}: ${ok} downloaded, ${skip} skipped, ${err} errors`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

await mkdir(OUT_DIR, { recursive: true });

for (const src of SOURCES) {
  if (ldrOnly && src.outDir !== 'LDR') continue;

  console.log(`\nFetching index: ${src.indexUrl}`);
  const resp = await fetch(src.indexUrl);
  if (!resp.ok) { console.error(`Failed: ${resp.status}`); continue; }
  const html = await resp.text();

  const files = extractLinks(html, src.prefix);
  console.log(`  Found ${files.length} files → data/seymouria/${src.outDir}/`);

  if (files.length === 0) {
    console.error('  No files found — check regex against page structure');
    continue;
  }

  await downloadAll(files, src.prefix, src.outDir);
}

console.log('\nDone.');
