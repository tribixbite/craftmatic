/**
 * Census of the corpus sources that embed their parts as `<set> - <mould>.dat`.
 *
 * Those ids reached every detector unnormalised until `partStem()` landed
 * (`ce50c838`), so each one silently failed to match any canonical mould id and
 * the pipeline exported a degraded pack — no error, just "this set has no cars
 * / no figures / no doors". This counts the exposure: how many sources carry
 * such ids, how many placed bricks they cover, and how many of them name a
 * mould the LDraw library DOES have (those are the ids a detector can now
 * match, and the descriptions the stub fallback can now recover).
 *
 * Reads only the LDraw text — no geometry resolution — so the whole corpus runs
 * in seconds rather than the hours a per-model pipeline probe would take.
 *
 * Usage: bun scripts/_embedded_prefix_census.ts [root…]
 *   Defaults to C:/git/clego/lego_sets/LDR and .../OMR.
 * Output: output/embedded-prefix-census.json (gitignored `output/`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { partStem } from '../web/src/engine/part-id.ts';

const LDRAW_PARTS = 'C:/git/clego/extracted/studio_release/app/ldraw/parts';
const ROOTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['C:/git/clego/lego_sets/LDR', 'C:/git/clego/lego_sets/OMR'];

/** The id shape this census is about: a placed reference carrying the document's set number. */
const PREFIXED = /^\d{3,7}(?:-\d{1,2})?\s*-\s*\S/;

/** Part families whose LOSS is user-visible, matched on the canonical id. */
const FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['figure', /^(970|971|972|973|3624|3625|3626|3815|3816|3817|3818|3819|3820|3821|3822|3823|10048|10049|92198|92250|92251|92254|93061)/],
  ['wheel', /^(24869|56908|44771|44772|87697|92912|15413|41897|23798|23799|55982|58090|30027|30028|11208|11209|30391|6014|6015|56898|56897|56902|4488|4266|55981|30699|4624|44309|56145|4185)/],
  ['coasterCar', /^(26021|26022|25269)/],
  ['coasterTrack', /^(25059|25061|26559|26560|26561|34738|80564|80562|80566|84571)/],
];

const libraryHas = (() => {
  const cache = new Map<string, boolean>();
  return (id: string): boolean => {
    let hit = cache.get(id);
    if (hit === undefined) { hit = existsSync(join(LDRAW_PARTS, `${id}.dat`)); cache.set(id, hit); }
    return hit;
  };
})();

interface SourceRow {
  file: string;
  placedTotal: number;
  placedPrefixed: number;
  distinctPrefixed: number;
  /** Prefixed ids whose canonical mould the library has — recoverable by `partStem` + the description fallback. */
  distinctResolvable: number;
  /** Prefixed SUBMODEL references: normal MPD authoring, counted only to keep them OUT of the exposure figure. */
  submodelRefs: number;
  families: Record<string, number>;
  /** A stub description line (`0 26021`) that the fallback now replaces. */
  stubDescriptions: number;
}

const rows: SourceRow[] = [];
let scanned = 0;

for (const root of ROOTS) {
  if (!existsSync(root)) { console.error(`skip (absent): ${root}`); continue; }
  for (const name of readdirSync(root)) {
    if (!/\.(mpd|ldr)$/i.test(name)) continue;
    scanned++;
    const text = readFileSync(join(root, name), 'utf8');

    let placedTotal = 0, placedPrefixed = 0, stubDescriptions = 0, submodelRefs = 0;
    const distinct = new Set<string>();
    // A `0 FILE <name>` section whose next description line repeats the mould.
    let pendingSection: string | null = null;

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('0 FILE ')) { pendingSection = line.slice(7).trim(); continue; }
      if (pendingSection !== null) {
        const described = line.startsWith('0 ') ? line.slice(2).trim() : '';
        const canonical = partStem(pendingSection);
        if (described.toLowerCase() === canonical && /\.dat$/i.test(pendingSection)) stubDescriptions++;
        pendingSection = null;
      }
      if (!line.startsWith('1 ')) continue;
      // `1 <colour> x y z a..i <part>` — the reference is everything after 14 tokens.
      const parts = line.split(/\s+/);
      if (parts.length < 15) continue;
      placedTotal++;
      const ref = parts.slice(14).join(' ');
      const base = ref.replace(/\\/g, '/').split('/').at(-1) ?? '';
      if (!PREFIXED.test(base)) continue;
      // A prefixed SUBMODEL reference (`8273-1 - Chassis.ldr`) is normal MPD
      // authoring and was never a detection problem: the parser flattens it
      // away, and no detector matches a mould id against it. Only a prefixed
      // PART (`.dat`) reached a canonical-id comparison and failed it, so it
      // is the only thing this census may count as exposure.
      if (!/\.dat$/i.test(base)) { submodelRefs++; continue; }
      placedPrefixed++;
      distinct.add(partStem(ref));
    }

    if (!placedPrefixed) continue;
    const families: Record<string, number> = {};
    for (const [label, pattern] of FAMILIES) {
      const n = [...distinct].filter(id => pattern.test(id)).length;
      if (n) families[label] = n;
    }
    rows.push({
      file: join(root, name).replace(/\\/g, '/'),
      placedTotal, placedPrefixed,
      distinctPrefixed: distinct.size,
      distinctResolvable: [...distinct].filter(libraryHas).length,
      families, stubDescriptions, submodelRefs,
    });
  }
}

rows.sort((a, b) => b.placedPrefixed - a.placedPrefixed);

const sum = (pick: (row: SourceRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
const withFamily = (label: string): number => rows.filter(row => (row.families[label] ?? 0) > 0).length;

const summary = {
  scanned,
  affectedSources: rows.length,
  affectedPct: +(rows.length / scanned * 100).toFixed(1),
  placedPrefixed: sum(r => r.placedPrefixed),
  distinctPrefixed: sum(r => r.distinctPrefixed),
  distinctResolvable: sum(r => r.distinctResolvable),
  stubDescriptions: sum(r => r.stubDescriptions),
  submodelRefsExcluded: sum(r => r.submodelRefs),
  sourcesWithFigureParts: withFamily('figure'),
  sourcesWithWheelParts: withFamily('wheel'),
  sourcesWithCoasterCars: withFamily('coasterCar'),
  sourcesWithCoasterTrack: withFamily('coasterTrack'),
  /** A source where EVERY placed brick carries the prefix lost detection wholesale. */
  sourcesFullyPrefixed: rows.filter(r => r.placedPrefixed === r.placedTotal).length,
};

mkdirSync('output', { recursive: true });
writeFileSync('output/embedded-prefix-census.json', JSON.stringify({ summary, rows }, null, 1));

console.log(JSON.stringify(summary, null, 1));
console.log('\nworst 12 by placed prefixed bricks:');
for (const row of rows.slice(0, 12)) {
  const fam = Object.entries(row.families).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  console.log(`  ${String(row.placedPrefixed).padStart(5)}/${String(row.placedTotal).padEnd(5)} bricks  ${String(row.distinctResolvable).padStart(4)}/${String(row.distinctPrefixed).padEnd(4)} ids in library  ${fam.padEnd(38)} ${row.file.split('/').slice(-2).join('/')}`);
}
console.log('\nwrote output/embedded-prefix-census.json');
