/**
 * Build a set_num → filename mapping from the seymouria.pl LDR index page.
 * Output: web/public/seymouria-index.json
 *
 * Format: { "10001": "10001 Metro Liner.ldr", "10016": "10016 Tanker.mpd", ... }
 *
 * Key is the leading set number (without variant suffix like -1).
 * Value is the bare filename to reconstruct the download URL.
 *
 * Usage: bun scripts/prebuild-seymouria-index.ts
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const INDEX_URL = 'https://seymouria.pl/Download/official-lego-sets-ldr.php';
const OUT_FILE  = join(import.meta.dir, '..', 'web', 'public', 'seymouria-index.json');

console.log('Fetching seymouria LDR index…');
const resp = await fetch(INDEX_URL);
if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${INDEX_URL}`);
const html = await resp.text();

// Extract href="./OfficialLegoSets_LDR/{filename}"
const re = /"\.\/OfficialLegoSets_LDR\/([^"]+)"/g;
const index: Record<string, string> = {};
let m: RegExpExecArray | null;
while ((m = re.exec(html)) !== null) {
  const filename = m[1]; // e.g. "10001 Metro Liner.ldr"
  // Extract leading set number (digits, optionally followed by letter variants like 'A', 'B')
  const numMatch = filename.match(/^(\d+)/);
  if (!numMatch) continue;
  const setNum = numMatch[1];
  // If multiple models for same set num (A/B model variants), keep first occurrence
  if (!(setNum in index)) {
    index[setNum] = filename;
  }
}

const count = Object.keys(index).length;
console.log(`  Extracted ${count} set entries`);

await mkdir(join(OUT_FILE, '..'), { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(index, null, 0));
console.log(`  Written → ${OUT_FILE}`);
