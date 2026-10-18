/**
 * Build a set_num → filename mapping from the seymouria.pl LDR index page.
 * Output: web/public/seymouria-index.json
 *
 * Format: { "10001": "10001 Metro Liner.ldr", "10016": "10016 Tanker.mpd", ... }
 *
 * Key is the leading set number (without variant suffix like -1).
 * Value is the bare filename to reconstruct the download URL.
 *
 * The host is a small personal site that intermittently refuses connections
 * from CI runners ("Unable to connect", 2026-10-01 and 2026-10-07 both failed
 * the whole build). The index is committed, so an unreachable host keeps the
 * committed copy with a warning instead of failing the build; the build fails
 * only when there is no copy to keep.
 *
 * Usage: bun scripts/prebuild-seymouria-index.ts
 */

import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const INDEX_URL = 'https://seymouria.pl/Download/official-lego-sets-ldr.php';
const OUT_FILE  = join(import.meta.dir, '..', 'web', 'public', 'seymouria-index.json');
/** Attempts before falling back to the committed index. */
const ATTEMPTS = 3;
/** Per-attempt timeout; a healthy fetch takes about a second. */
const TIMEOUT_MS = 20_000;

/** Fetch the index page, retrying with a short backoff. */
async function fetchIndexHtml(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(INDEX_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${INDEX_URL}`);
      return await resp.text();
    } catch (err) {
      lastError = err;
      console.warn(`  attempt ${attempt}/${ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < ATTEMPTS) await Bun.sleep(2_000 * attempt);
    }
  }
  throw lastError;
}

/** Parse `href="./OfficialLegoSets_LDR/{filename}"` links into set number → filename. */
function parseIndex(html: string): Record<string, string> {
  const re = /"\.\/OfficialLegoSets_LDR\/([^"]+)"/g;
  const index: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const filename = m[1]; // e.g. "10001 Metro Liner.ldr"
    // Leading set number (digits; letter variants like 'A', 'B' follow it).
    const numMatch = filename.match(/^(\d+)/);
    if (!numMatch) continue;
    const setNum = numMatch[1];
    // Several models for one set number (A/B variants): keep the first.
    if (!(setNum in index)) index[setNum] = filename;
  }
  return index;
}

console.log('Fetching seymouria LDR index…');
let index: Record<string, string> | undefined;
try {
  index = parseIndex(await fetchIndexHtml());
  // An empty parse means the page changed shape, not that the catalogue emptied.
  if (Object.keys(index).length === 0) throw new Error('page parsed to 0 entries (layout changed?)');
} catch (err) {
  if (!existsSync(OUT_FILE)) throw err;
  console.warn(`  WARNING: keeping the committed ${OUT_FILE} (${err instanceof Error ? err.message : String(err)})`);
}

if (index) {
  console.log(`  Extracted ${Object.keys(index).length} set entries`);
  await mkdir(join(OUT_FILE, '..'), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(index, null, 0));
  console.log(`  Written → ${OUT_FILE}`);
}
