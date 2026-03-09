#!/usr/bin/env bun
/**
 * Pre-build script: download Rebrickable CSVs and write a compact JSON catalog
 * to web/public/lego-catalog.json so the browser app works without fetching
 * from Rebrickable at runtime.
 *
 * Usage: bun scripts/prebuild-lego-catalog.ts
 * Runs automatically as part of: bun run prebuild:lego
 */

import { gunzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CDN = 'https://cdn.rebrickable.com/media/downloads';
const OUT  = resolve(import.meta.dir, '../web/public/lego-catalog.json');

console.log('Fetching Rebrickable CSVs…');

const [setsGz, themesGz] = await Promise.all([
  fetch(`${CDN}/sets.csv.gz`).then(r => { if (!r.ok) throw new Error(`sets.csv.gz: HTTP ${r.status}`); return r.arrayBuffer(); }),
  fetch(`${CDN}/themes.csv.gz`).then(r => { if (!r.ok) throw new Error(`themes.csv.gz: HTTP ${r.status}`); return r.arrayBuffer(); }),
]);

console.log('Parsing…');

const setsText   = new TextDecoder().decode(gunzipSync(Buffer.from(setsGz)));
const themesText = new TextDecoder().decode(gunzipSync(Buffer.from(themesGz)));

// ─── Parse sets.csv ──────────────────────────────────────────────────────────

interface CatalogSet {
  set_num: string;
  name: string;
  year: number;
  theme_id: number;
  num_parts: number;
}

function parseSets(csv: string): CatalogSet[] {
  const lines = csv.split('\n');
  const h = lines[0].trim().toLowerCase().split(',');
  const iNum = h.indexOf('set_num');
  const iName = h.indexOf('name');
  const iYear = h.indexOf('year');
  const iTheme = h.indexOf('theme_id');
  const iParts = h.indexOf('num_parts');

  const out: CatalogSet[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i].trim());
    if (!cols || cols.length < 3) continue;
    const set_num = cols[iNum]?.trim();
    const name    = cols[iName]?.trim();
    if (!set_num || !name) continue;
    out.push({
      set_num,
      name,
      year:      parseInt(cols[iYear]  ?? '0') || 0,
      theme_id:  parseInt(cols[iTheme] ?? '0') || 0,
      num_parts: parseInt(cols[iParts] ?? '0') || 0,
    });
  }
  return out;
}

// ─── Parse themes.csv ────────────────────────────────────────────────────────

interface CatalogTheme {
  id: number;
  name: string;
  parent_id: number | null;
}

function parseThemes(csv: string): CatalogTheme[] {
  const lines = csv.split('\n');
  const h = lines[0].trim().toLowerCase().split(',');
  const iId     = h.indexOf('id');
  const iName   = h.indexOf('name');
  const iParent = h.indexOf('parent_id');

  const out: CatalogTheme[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i].trim());
    if (!cols || cols.length < 2) continue;
    const id   = parseInt(cols[iId] ?? '');
    const name = cols[iName]?.trim();
    if (!id || !name) continue;
    const parentRaw = cols[iParent]?.trim();
    out.push({
      id,
      name,
      parent_id: parentRaw ? (parseInt(parentRaw) || null) : null,
    });
  }
  return out;
}

// ─── Simple CSV line splitter (handles quoted fields) ────────────────────────

function splitCsvLine(line: string): string[] | null {
  if (!line) return null;
  const cols: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { cols.push(''); break; }
    if (line[i] === '"') {
      i++;
      let val = '';
      while (i < line.length) {
        if (line[i] === '"') { i++; if (line[i] === '"') { val += '"'; i++; } else break; }
        else val += line[i++];
      }
      cols.push(val);
      if (line[i] === ',') i++;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      cols.push(line.slice(start, i));
      if (i < line.length) i++;
    }
  }
  return cols;
}

// ─── Build + write ───────────────────────────────────────────────────────────

const sets   = parseSets(setsText);
const themes = parseThemes(themesText);

console.log(`Parsed ${sets.length.toLocaleString()} sets, ${themes.length} themes`);

const catalog = { sets, themes };
mkdirSync(resolve(import.meta.dir, '../web/public'), { recursive: true });
writeFileSync(OUT, JSON.stringify(catalog));

const sizeMB = (Buffer.byteLength(JSON.stringify(catalog)) / 1024 / 1024).toFixed(1);
console.log(`Written to web/public/lego-catalog.json (${sizeMB} MB)`);
