/**
 * L00: fetch and run the OSM inputs of the 22 approved landmarks (BIZ-05 / plan A section 4).
 *
 *   bun scripts/_landmark_inputs.ts discover <slug|all>   one Overpass request per landmark: named candidates near it
 *   bun scripts/_landmark_inputs.ts fetch <slug|all>      one Overpass request per landmark: chosen element + its parts
 *
 * (The pipeline run lives in `scripts/_landmark_run.ts`.)
 * Overpass etiquette: strictly one request at a time, `PAUSE_MS` apart, a generic User-Agent, a request timeout, and
 * a back-off retry on 429/502/504. Output goes under `$CRAFTMATIC_DESIGNS/landmarks/<slug>/` (the PRIVATE designs repo).
 * Clean room: this reads OSM data only; no LEGO set file is opened.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LANDMARKS, type Landmark } from './_landmark_table.js';

const DESIGNS = process.env['CRAFTMATIC_DESIGNS'] ?? 'C:/git/craftmatic-designs';
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'landmark-fixture-fetch/1.0 (one-off ODbL fixture download, sequential)';
const PAUSE_MS = 6000;
const REQUEST_TIMEOUT_MS = 120_000;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** POSTs one Overpass query; retries 429/502/504 (and transport errors) with growing back-off. */
async function overpass(query: string): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status !== 504 && res.status !== 502) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      console.error(`  HTTP ${res.status}, retry ${attempt + 1}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('HTTP')) throw e;
      console.error(`  ${(e as Error).message}, retry ${attempt + 1}`);
    }
    await sleep(20_000 * (attempt + 1));
  }
  throw new Error('overpass: gave up after 5 attempts');
}

const [cmd, which] = process.argv.slice(2) as [string, string];
const chosen: Landmark[] = which === 'all' ? LANDMARKS : LANDMARKS.filter(l => l.slug === which);
if (!cmd || chosen.length === 0) { console.error('usage: _landmark_inputs.ts <discover|fetch> <slug|all>'); process.exit(2); }
const dirOf = (l: Landmark): string => path.join(DESIGNS, 'landmarks', l.slug);

if (cmd === 'discover') {
  for (const l of chosen) {
    const a = `(around:${l.radius},${l.lat},${l.lon})`;
    const q = `[out:json][timeout:90];(nwr["building"]["name"]${a};nwr["man_made"]["name"]${a};nwr["historic"]["name"]${a};nwr["bridge"]["name"]${a};nwr["building:part"]["name"]${a};);out tags center;`;
    const json = await overpass(q) as { elements: Array<{ type: string; id: number; tags?: Record<string, string> }> };
    console.log(`## ${l.slug} (${json.elements.length} named)`);
    for (const e of json.elements) {
      const t = e.tags ?? {};
      console.log(`${e.type}/${e.id}\t${t['name:en'] ?? t['name'] ?? ''}\tbuilding=${t['building'] ?? ''} man_made=${t['man_made'] ?? ''} historic=${t['historic'] ?? ''} h=${t['height'] ?? ''} part=${t['building:part'] ?? ''}`);
    }
    await sleep(PAUSE_MS);
  }
}

if (cmd === 'fetch') {
  for (const l of chosen) {
    if (l.osm.length === 0) { console.error(`${l.slug}: no osm ids chosen yet`); continue; }
    // Resumable: a landmark already fetched is kept (delete its JSON by hand to refetch).
    if (existsSync(path.join(dirOf(l), `${l.slug}.overpass.json`))) { console.log(`${l.slug}: already fetched`); continue; }
    try {
    const sel = l.osm.map(id => { const [t, n] = id.split('/'); return `${t}(${n});`; }).join('');
    // The chosen elements, plus every building:part lying inside any of them (`map_to_area` needs a closed way/relation).
    const q = `[out:json][timeout:120];(${sel})->.m;.m map_to_area->.a;(.m;nwr["building:part"](area.a););out geom;`;
    const json = await overpass(q) as { elements?: unknown[]; osm3s?: unknown; version?: unknown; generator?: unknown };
    const out = {
      version: json.version, generator: json.generator, osm3s: json.osm3s,
      craftmatic: { fetched: new Date().toISOString().slice(0, 10), query: q, licence: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' },
      elements: json.elements ?? [],
    };
    mkdirSync(dirOf(l), { recursive: true });
    writeFileSync(path.join(dirOf(l), `${l.slug}.overpass.json`), JSON.stringify(out, null, 1));
    console.log(`${l.slug}: ${out.elements.length} elements`);
    } catch (e) { console.error(`${l.slug}: FAILED ${(e as Error).message}`); }
    await sleep(PAUSE_MS);
  }
}
