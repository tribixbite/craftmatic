/**
 * Rail-vehicle audit: which sources carry TRAIN track (not the roller-coaster
 * moulds `coaster-track.ts` already routes), which carry train running gear,
 * and whether the source lays that track UNDER the train.
 *
 * Classification is by the part library's own description (`descriptionOf`,
 * the second line of a `0 FILE` part), never by a hand list of ids:
 *   rail     "Train Track …" / "Monorail Track …" (sub-parts `~` excluded;
 *            level-crossing gates and sleeper plates are not running rail)
 *   coaster  "… Roller Coaster …" / "Rollercoaster" track (routed today)
 *   wheel    "Train Wheel …"   bogie "… Bogie …"   base "Train Base …"
 * "Under the train" is measured on placement origins: a train wheel or bogie
 * whose origin is within `UNDER_XZ` LDU horizontally of a rail origin and
 * 0..`UNDER_Y` LDU above it (LDraw y is down) counts as standing on track.
 *
 * Usage: bun scripts/_rail_audit.ts [set…] [--json=out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { peekDatText, seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { descriptionOf } from '../web/src/engine/ldraw-part-geometry.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';

const LDRAW = 'C:/git/clego/extracted/studio_release/app/ldraw';
setLDrawRoot(LDRAW);
const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';
const FAVOURITES = [
  '10261', '10303', '10326', '10337', '10341', '10354', '10365', '11371', '11374',
  '21061', '21063', '21318', '21360', '31141', '41395', '41703', '41732', '42172',
  '42639', '42652', '42663', '42670', '43267', '60380', '60446', '71040', '71043',
  '75397', '76269', '76286', '76417', '76419', '76435', '76457', '77092', '80049',
  '910004', '910032', '910047', '910049',
];
const TRAINS = ['10277', '60198', '60052', '60336', '60337'];
const UNDER_XZ = 200, UNDER_Y = 120;

export type RailClass = 'rail' | 'coaster' | 'wheel' | 'bogie' | 'base';
/** Classify one placed part by its library description. */
export function railClass(description: string): RailClass | null {
  const d = description.replace(/^[=_]+\s*/, '');
  if (/^~/.test(d)) return null;
  if (/Roller\s*Coaster|Rollercoaster/i.test(d)) return /Track/i.test(d) ? 'coaster' : null;
  if (/^(Train|Monorail) Track\b/i.test(d) && !/Sleeper|Level Crossing|Lever|Command Rod|Connector/i.test(d)) return 'rail';
  if (/^Train Wheel\b/i.test(d)) return 'wheel';
  if (/Bogie/i.test(d)) return 'bogie';
  if (/^Train Base\b/i.test(d)) return 'base';
  return null;
}

async function loadBricks(file: string): Promise<ParsedBrick[]> {
  const bytes = readFileSync(file);
  let text: string;
  if (/\.io$/i.test(file)) {
    const io = await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    text = io.text;
    seedDatTexts(io.customParts);
  } else text = bytes.toString('utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts(embeddedPartTexts(doc));
  return doc.bricks;
}

const descCache = new Map<string, string>();
async function describe(part: string): Promise<string> {
  if (descCache.has(part)) return descCache.get(part)!;
  let d = '';
  // Embedded (seeded) text first, then the library on disk: never the network
  // mirror, which made the first run hang for minutes on a single set.
  const seeded = peekDatText(part);
  const name = part.toLowerCase().replace(/\\/g, '/').replace(/\.dat$/, '') + '.dat';
  const onDisk = ['parts', 'UnOfficial/parts'].map(dir => `${LDRAW}/${dir}/${name}`).find(f => existsSync(f));
  const t = seeded ?? (onDisk ? readFileSync(onDisk, 'utf8') : null);
  d = t ? descriptionOf(t) : '';
  descCache.set(part, d);
  return d;
}

interface Row {
  set: string; name: string; path: string; bricks: number;
  rail: number; coaster: number; wheel: number; bogie: number; base: number;
  railMoulds: Record<string, number>; gearMoulds: Record<string, number>; gearOnRail: number; gear: number; verdict: string;
}

const argv = process.argv.slice(2);
const jsonOut = argv.find(a => a.startsWith('--json='))?.slice(7);
const targets = argv.filter(a => !a.startsWith('--'));
const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as { sets: Record<string, { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }> }).sets;
const rows: Row[] = [];
// `--all`: every set in the index (a quiet line per set that has any rail or gear).
const ALL = argv.includes('--all');
for (const set of ALL ? Object.keys(sets) : targets.length ? targets : [...FAVOURITES, ...TRAINS]) {
  const entry = sets[set];
  if (!entry?.models?.length) { console.log(`${set}: not in index`); continue; }
  // The picker's order, skipping an `.lxf` (LDD XML; this audit reads LDraw
  // text only). The row names the file it actually read.
  const order = indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts);
  const pick = order.find(i => !/\.lxf$/i.test(entry.models![i]!.path)) ?? order[0]!;
  const model = entry.models[pick]!;
  if (pick !== order[0] && !ALL) console.log(`${set}: first pick ${entry.models[order[0]!]!.path} is LXF; audited ${model.path}`);
  let bricks: ParsedBrick[];
  try { bricks = await loadBricks(`${CORPUS}/${model.path}`); } catch (e) { if (!ALL) console.log(`${set}: load failed ${String(e)}`); continue; }
  const row: Row = { set, name: entry.name ?? '', path: model.path, bricks: bricks.length, rail: 0, coaster: 0, wheel: 0, bogie: 0, base: 0, railMoulds: {}, gearMoulds: {}, gearOnRail: 0, gear: 0, verdict: '' };
  const rails: ParsedBrick[] = [], gear: ParsedBrick[] = [];
  for (const b of bricks) {
    // The coaster moulds by the extractor's own profile table (an MPD's embedded
    // `10261 - 25061.dat` carries a stub description), everything else by description.
    const profile = coasterTrackProfile(b.part);
    const c = profile && profile.family !== 'train' ? 'coaster' : railClass(await describe(b.part));
    if (!c) continue;
    row[c]++;
    if (c === 'rail') { rails.push(b); const s = partStem(b.part); row.railMoulds[s] = (row.railMoulds[s] ?? 0) + 1; }
    if (c === 'wheel' || c === 'bogie' || c === 'base') { const s = partStem(b.part); row.gearMoulds[s] = (row.gearMoulds[s] ?? 0) + 1; }
    if (c === 'wheel' || c === 'bogie') gear.push(b);
  }
  row.gear = gear.length;
  row.gearOnRail = gear.filter(g => rails.some(r => Math.hypot(g.x - r.x, g.z - r.z) <= UNDER_XZ && r.y - g.y >= 0 && r.y - g.y <= UNDER_Y)).length;
  row.verdict = !row.rail ? (row.gear || row.base ? 'train, no track in source' : row.coaster ? 'coaster track only' : 'no rail')
    : !row.gear ? 'track, no train running gear'
    : row.gearOnRail ? `train on its track (${row.gearOnRail}/${row.gear} wheels/bogies over a rail)` : 'track and train apart';
  rows.push(row);
  if (ALL && !row.rail && !row.gear && !row.base) continue;
  console.log(`${set.padEnd(7)} ${row.name.slice(0, 34).padEnd(34)} rail ${String(row.rail).padStart(3)} coaster ${String(row.coaster).padStart(3)} wheel ${String(row.wheel).padStart(3)} bogie ${String(row.bogie).padStart(3)} base ${String(row.base).padStart(2)}  ${row.verdict} ${JSON.stringify(row.railMoulds)} ${JSON.stringify(row.gearMoulds)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
