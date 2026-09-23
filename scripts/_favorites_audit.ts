/**
 * Audit a list of sets against the export pipeline's REAL source choice.
 *
 * For each set: what the picker loads (`indexedTryOrder`), whether that source
 * embeds its parts as `<set> - <mould>.dat` (the shape that defeated every
 * canonical-id match before `ce50c838`, so the export silently lost cars,
 * figures, doors, chairs and vehicle facing), and which user-visible families
 * it would have lost.
 *
 * Usage: bun scripts/_favorites_audit.ts [set…]
 *   No arguments audits Will's 40 favourites.
 * Output: output/favorites-audit.json (gitignored `output/`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';
import { partStem } from '../web/src/engine/part-id.ts';

const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';
const LDRAW_PARTS = 'C:/git/clego/extracted/studio_release/app/ldraw/parts';

const FAVOURITES = [
  '10261', '10303', '10326', '10337', '10341', '10354', '10365', '11371', '11374',
  '21061', '21063', '21318', '21360', '31141', '41395', '41703', '41732', '42172',
  '42639', '42652', '42663', '42670', '43267', '60380', '60446', '71040', '71043',
  '75397', '76269', '76286', '76417', '76419', '76435', '76457', '77092', '80049',
  '910004', '910032', '910047', '910049',
];

const FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['figure', /^(970|971|972|973|3624|3625|3626|3815|3816|3817|3818|3819|3820|3821|3822|3823|10048|10049|92198|92250|92251|92254|93061)/],
  ['wheel', /^(24869|56908|44771|44772|87697|92912|15413|41897|23798|23799|55982|58090|30027|30028|11208|11209|30391|6014|6015|56898|56897|56902|4488|4266|55981|30699|4624|44309|56145|4185)/],
  ['coasterCar', /^(26021|26022|25269)/],
  ['coasterTrack', /^(25059|25061|26559|26560|26561|34738|80564|80562|80566|84571)/],
];

const PREFIXED = /^\d{3,7}(?:-\d{1,2})?\s*-\s*\S/;

interface IndexEntry { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }

const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as { sets: Record<string, IndexEntry> }).sets;
const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = wanted.length ? wanted : FAVOURITES;

interface Row {
  set: string; name: string; src: string; path: string; exists: boolean;
  prefixedPlacements: number; distinctPrefixed: number; resolvable: number;
  families: Record<string, number>; stubDescriptions: number;
}
const rows: Row[] = [];
const missing: string[] = [];

for (const set of targets) {
  const entry = sets[set];
  if (!entry?.models?.length) { missing.push(set); continue; }
  const order = indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts);
  const model = entry.models[order[0]!]!;
  const file = `${CORPUS}/${model.path}`;
  const row: Row = {
    set, name: entry.name ?? '', src: String(model.src), path: model.path, exists: existsSync(file),
    prefixedPlacements: 0, distinctPrefixed: 0, resolvable: 0, families: {}, stubDescriptions: 0,
  };

  if (row.exists && /\.(mpd|ldr)$/i.test(file)) {
    const distinct = new Set<string>();
    let pending: string | null = null;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('0 FILE ')) { pending = line.slice(7).trim(); continue; }
      if (pending !== null) {
        const described = line.startsWith('0 ') ? line.slice(2).trim().toLowerCase() : '';
        if (/\.dat$/i.test(pending) && described === partStem(pending)) row.stubDescriptions++;
        pending = null;
      }
      if (!line.startsWith('1 ')) continue;
      const tok = line.split(/\s+/);
      if (tok.length < 15) continue;
      const base = tok.slice(14).join(' ').replace(/\\/g, '/').split('/').at(-1) ?? '';
      // Only a prefixed PART reached a canonical-id comparison; a prefixed
      // submodel reference is ordinary MPD authoring.
      if (!PREFIXED.test(base) || !/\.dat$/i.test(base)) continue;
      row.prefixedPlacements++;
      distinct.add(partStem(base));
    }
    row.distinctPrefixed = distinct.size;
    row.resolvable = [...distinct].filter(id => existsSync(`${LDRAW_PARTS}/${id}.dat`)).length;
    for (const [label, pattern] of FAMILIES) {
      const n = [...distinct].filter(id => pattern.test(id)).length;
      if (n) row.families[label] = n;
    }
  }
  rows.push(row);
}

const affected = rows.filter(r => Object.keys(r.families).length > 0);
const prefixedAtAll = rows.filter(r => r.prefixedPlacements > 0);

mkdirSync('output', { recursive: true });
writeFileSync('output/favorites-audit.json', JSON.stringify({
  audited: rows.length, missingFromIndex: missing,
  withPrefixedParts: prefixedAtAll.length, withVisibleFamilyLoss: affected.length, rows,
}, null, 1));

console.log(`audited ${rows.length} of ${targets.length} sets` + (missing.length ? `  (not in index: ${missing.join(', ')})` : ''));
console.log(`  first pick embeds prefixed PARTS: ${prefixedAtAll.length}`);
console.log(`  of those, a user-visible family was lost: ${affected.length}\n`);
console.log('set     source          prefixed  families                              name');
for (const row of rows.sort((a, b) => b.prefixedPlacements - a.prefixedPlacements)) {
  if (!row.prefixedPlacements) continue;
  const fam = Object.entries(row.families).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  console.log(`${row.set.padEnd(8)}${row.src.padEnd(15)}${String(row.prefixedPlacements).padStart(6)}    ${fam.padEnd(38)}${row.name}`);
}
const clean = rows.filter(r => !r.prefixedPlacements && r.exists).length;
console.log(`\n${clean} favourites load a source with no prefixed parts; ${rows.filter(r => !r.exists).length} first-pick files are absent locally.`);
console.log('wrote output/favorites-audit.json');
