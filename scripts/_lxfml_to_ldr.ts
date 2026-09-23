/**
 * Build an `.ldr` from an LXFML with THIS repo's own placement code.
 *
 * The corpus carries converted `.ldr` files produced elsewhere, and when one
 * of them is wrong there is no way to tell whether the source is bad or the
 * conversion is — until the same source is run through our own reader and the
 * two are compared. 42703 Mermaid Roller Coaster Ride is the case that forced
 * this: its DbixConvV3 `.ldr` spans 86.6 x 30.0 x 39.7 studs where the LXFML
 * spans 68.8 x 19.2 x 29.2, so the model ships inflated and its coaster track
 * cannot stitch into a route.
 *
 * Uses `buildLxfPlacements` — the DOM-free core of `lxf-parser.ts` — with the
 * two shipped alignment tables, so what comes out is exactly what the app
 * would draw from the same file.
 *
 * Usage: bun scripts/_lxfml_to_ldr.ts <in.lxfml|in.lxf> [out.ldr] [--quiet]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {
  applyDerivedAlign, applyMeasuredBound, buildLxfPlacements, describeLxfDiagnostics,
  validatePartAlign, validateMeasuredAlign, validateTable,
  type LxfPartRecord, type LxfAlignmentTable, type LxfMeasuredTable,
} from '../web/src/engine/lxf-parser.js';

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
// `--part-map <path>` swaps the shipped ldraw.xml table for another one, so a
// candidate row can be tested against a model before it is generated into
// `web/public/ldd-part-map.json`.
const partMapIndex = argv.indexOf('--part-map');
const PART_MAP = partMapIndex >= 0 ? argv[partMapIndex + 1] : undefined;
const partMapValueIndex = partMapIndex >= 0 ? partMapIndex + 1 : -1;
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== partMapValueIndex);
const IN = positional[0];
if (!IN || (partMapIndex >= 0 && !PART_MAP)) {
  console.error('usage: bun scripts/_lxfml_to_ldr.ts <in.lxfml|in.lxf> [out.ldr] [--part-map <table.json>] [--quiet]');
  process.exit(64);
}
const OUT = positional[1];

const PART_MAP_PATH = PART_MAP ?? 'web/public/ldd-part-map.json';
const table = validateTable(
  JSON.parse(readFileSync(PART_MAP_PATH, 'utf8')),
  PART_MAP_PATH, validatePartAlign,
) as LxfAlignmentTable;
// `applyMeasuredBound` is NOT optional. The learned table carries 325 rows
// whose origin correction is longer than the part it corrects — 50665 Minifig
// Helmet moves 4,360 LDU on a 52 LDU part — and the app drops them on load.
// A script that validates the table without this ships those rows and flings
// parts across the model, which then reads as a bad source.
const measured = applyDerivedAlign(applyMeasuredBound(validateTable(
  JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')),
  'web/public/ldd-measured-align.json', validateMeasuredAlign,
) as LxfMeasuredTable));

/** The single LXFML entry of a `.lxf` ZIP (stored or deflated), or the file itself. */
function lxfmlBytes(path: string): Buffer {
  const buf = readFileSync(path);
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') return buf;
  // Minimal local-header walk: enough for the one entry a .lxf carries.
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const compressed = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('latin1');
    const start = at + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compressed);
    if (/\.lxfml$/i.test(name)) return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    at = start + compressed;
  }
  throw new Error(`no .lxfml entry in ${path}`);
}

const PART_RE = /<Part\b([^>]*)>([\s\S]*?)<\/Part>|<Part\b([^>]*)\/>/g;
const BRICK_RE = /<Brick\b([^>]*)>([\s\S]*?)<\/Brick>/g;
const BONE_RE = /<Bone\b([^>]*?)\/?>/g;
const attr = (head: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(head)?.[1];

function readRecords(path: string): LxfPartRecord[] {
  const xml = lxfmlBytes(path).toString('utf8');
  const out: LxfPartRecord[] = [];
  for (const brick of xml.matchAll(BRICK_RE)) {
    const brickDesign = attr(brick[1] ?? '', 'designID');
    for (const part of (brick[2] ?? '').matchAll(PART_RE)) {
      const head = part[1] ?? part[3] ?? '';
      const bones = [...(part[2] ?? '').matchAll(BONE_RE)];
      out.push({
        designID: (attr(head, 'designID') ?? brickDesign ?? '3001').split(';')[0]!.trim(),
        materialId: parseInt((attr(head, 'materials') ?? '').split(',')[0]!, 10) || 194,
        transformation: attr(bones[0]?.[1] ?? '', 'transformation') ?? '',
        boneCount: bones.length,
      });
    }
  }
  return out;
}

const records = readRecords(IN);
const { bricks, diagnostics } = buildLxfPlacements(records, table, measured);

const stem = IN.replace(/.*[/\\]/, '').replace(/\.[^.]+$/, '');
const lines = [
  `0 ${stem}`,
  `0 Name: ${stem}.ldr`,
  '0 Author: craftmatic scripts/_lxfml_to_ldr.ts',
  '0 !LINEAGE lxfml-direct: built from the LXFML by this repo’s own placement code',
];
for (const b of bricks) {
  const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const n = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : String(Number(v.toFixed(4))));
  lines.push(`1 ${b.color} ${n(b.x)} ${n(b.y)} ${n(b.z)} ${r.map(n).join(' ')} ${b.part}`);
}
const text = lines.join('\n') + '\n';

if (OUT) writeFileSync(OUT, text, 'latin1');
if (!QUIET) {
  const ext = (i: number): number => {
    const c = bricks.map(b => [b.x, b.y, b.z][i]!);
    return c.length ? Math.max(...c) - Math.min(...c) : 0;
  };
  console.log(`${IN.replace(/.*lego_sets[/\\]/, '')}`);
  console.log(`  ${records.length} LXFML part records -> ${bricks.length} placements`);
  console.log(`  extent ${[0, 1, 2].map(i => (ext(i) / 20).toFixed(1)).join(' x ')} studs`);
  const d = describeLxfDiagnostics(diagnostics);
  if (d) console.log(`  ${d}`);
  if (OUT) console.log(`  wrote ${OUT}`);
}
