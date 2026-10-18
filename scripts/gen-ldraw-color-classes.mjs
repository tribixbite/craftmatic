#!/usr/bin/env node
/**
 * Generate web/src/engine/ldraw-color-classes.json from LDConfig.ldr.
 *
 * LDConfig is the authoritative LDraw colour table: RGB, ALPHA, LUMINANCE and
 * the finish keyword (CHROME, PEARLESCENT, RUBBER, MATTE_METALLIC, METAL,
 * MATERIAL GLITTER/SPECKLE). The Bedrock entity path derives its material
 * classes from this file so nothing about a colour's finish is hand-listed.
 *
 * Usage: node scripts/gen-ldraw-color-classes.mjs [path-or-url]
 * Default source: the deployed library mirror (craftmatic.click/ldraw-parts),
 * falling back to the local Studio-bundled copy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEFAULT_URL = 'https://craftmatic.click/ldraw-parts/LDConfig.ldr';
const LOCAL = 'C:/git/clego/extracted/studio_release/app/ldraw/LDConfig.ldr';
const OUT = new URL('../web/src/engine/ldraw-color-classes.json', import.meta.url);

async function loadText(source) {
  if (/^https?:/.test(source)) {
    const r = await fetch(source, { headers: { 'User-Agent': 'craftmatic-gen-color-classes/1.0' } });
    if (!r.ok) throw new Error(`${source}: HTTP ${r.status}`);
    return { text: await r.text(), source };
  }
  return { text: readFileSync(source, 'utf8'), source };
}

const arg = process.argv[2];
let loaded;
try {
  loaded = await loadText(arg ?? DEFAULT_URL);
} catch (err) {
  if (arg) throw err;
  console.warn(`[gen-ldraw-color-classes] ${DEFAULT_URL} unavailable (${err.message}); using ${LOCAL}`);
  loaded = await loadText(LOCAL);
}

const colours = {};
let count = 0;
for (const raw of loaded.text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line.startsWith('0 !COLOUR')) continue;
  const code = /\bCODE\s+(\d+)/.exec(line)?.[1];
  const value = /\bVALUE\s+(#[0-9A-Fa-f]{6})/.exec(line)?.[1];
  if (!code || !value) continue;
  const alpha = Number(/\bALPHA\s+(\d+)/.exec(line)?.[1] ?? 255);
  const luminance = Number(/\bLUMINANCE\s+(\d+)/.exec(line)?.[1] ?? 0);
  const finish = /\bCHROME\b/.test(line) ? 'chrome'
    : /\bPEARLESCENT\b/.test(line) ? 'pearl'
    : /\bRUBBER\b/.test(line) ? 'rubber'
    : /\bMATTE_METALLIC\b/.test(line) ? 'matte_metallic'
    : /\bMETAL\b/.test(line) ? 'metal'
    : /\bMATERIAL\s+GLITTER\b/.test(line) ? 'glitter'
    : /\bMATERIAL\s+SPECKLE\b/.test(line) ? 'speckle'
    : 'none';
  const name = /^0 !COLOUR\s+(\S+)/.exec(line)?.[1] ?? '';
  const entry = { name, rgb: value.toUpperCase() };
  if (alpha !== 255) entry.alpha = alpha;
  if (luminance) entry.luminance = luminance;
  if (finish !== 'none') entry.finish = finish;
  colours[code] = entry;
  count++;
}
if (count < 100) throw new Error(`only ${count} colours parsed from ${loaded.source}; refusing to write`);

const out = {
  _source: loaded.source,
  _sha256: createHash('sha256').update(loaded.text).digest('hex').slice(0, 16),
  _generated: new Date().toISOString().slice(0, 10),
  _count: count,
  colours,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`[gen-ldraw-color-classes] ${count} colours from ${loaded.source} → ${OUT.pathname}`);
