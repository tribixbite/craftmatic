/**
 * Census: which LXFML sources carry a finished-model page (top-level `<Step>`
 * with direct `<Explode>` placements, `composeRootStep`) that MOVES parts, and
 * by how much. The count is reported per FILE and per distinct SET, with the
 * moved-part share, so a file whose page only nudges a minifig arm is not
 * counted as "needs assembly" beside one whose page carries a 3,000-part
 * sub-build.
 *
 * Reads `.lxfml` directly and `.lxf` (ZIP, IMAGE100.LXFML preferred). Only the
 * refID schema (`<Parts partRefs="…">`) has frame pairs; the uuid schema
 * (`<Part partRef="uuid">`, explosionPosition only) is counted separately and
 * NOT applied — its explodes are display offsets with no stored frame.
 *
 * Usage: bun scripts/_root_step_census.ts <out.json> <dir-or-file>...
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { compositionMoves, findRootComposition, readPartOrigins } from '../web/src/engine/lxfml-assembly.ts';

/** The LXFML text of a `.lxf` ZIP (IMAGE100.LXFML preferred) or a bare `.lxfml`. */
function lxfmlText(path: string): string {
  const buf = readFileSync(path);
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') return buf.toString('utf8');
  const entries: { name: string; data: Buffer }[] = [];
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const flags = buf.readUInt16LE(at + 6);
    const method = buf.readUInt16LE(at + 8);
    const compressed = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('latin1');
    const start = at + 30 + nameLen + extraLen;
    // A data-descriptor entry (bit 3) has no size here; stop rather than misread.
    if (flags & 8 && compressed === 0) break;
    const data = buf.subarray(start, start + compressed);
    if (/\.lxfml$/i.test(name)) entries.push({ name, data: method === 0 ? Buffer.from(data) : inflateRawSync(data) });
    at = start + compressed;
  }
  const pick = entries.find(e => /IMAGE100\.LXFML$/i.test(e.name)) ?? entries[0];
  if (!pick) throw new Error('no .lxfml entry');
  return pick.data.toString('utf8');
}

interface Row {
  file: string; set: string; schema: 'refID' | 'uuid' | 'none';
  parts: number; rootPlacements: number; moved: number; movedShare: number;
  maxMoveUnits: number; bigMoved: number; uuidRootExplodes: number; error?: string;
}

const MOVE_EPS = 0.08; // LDD units (0.1 of a stud): anything smaller is float noise
const BIG_MOVE = 4.0;  // 5 studs: a sub-build relocation, not a pose nudge

function census(path: string): Row {
  const file = path.replace(/\\/g, '/').replace(/.*lego_sets\//, '');
  const set = (/(\d{3,7})/.exec(file.split('/').pop()!)?.[1]) ?? file;
  const row: Row = { file, set, schema: 'none', parts: 0, rootPlacements: 0, moved: 0, movedShare: 0, maxMoveUnits: 0, bigMoved: 0, uuidRootExplodes: 0 };
  let xml: string;
  try { xml = lxfmlText(path); } catch (e) { row.error = String(e); return row; }
  const origins = readPartOrigins(xml);
  row.parts = origins.size;
  if (xml.includes('<Parts partRefs=')) row.schema = 'refID';
  else if (/<Explode\b[^>]*uuid=/.test(xml)) row.schema = 'uuid';
  const roots = findRootComposition(xml);
  row.rootPlacements = roots.length;
  if (row.schema === 'uuid') {
    // Direct Explode children of a top-level Step in the uuid schema (counted only).
    const s = xml.indexOf('<Steps');
    if (s >= 0) {
      let depth = 0; const stack: string[] = [];
      for (const m of xml.slice(s).matchAll(/<(\/?)(Steps|Step|SubBuild|ExtraView|EndOnHighView|Explode)\b[^>]*?(\/?)>/g)) {
        const [, close, tag, self] = m;
        if (close) { stack.pop(); if (tag === 'Steps') break; continue; }
        if (tag === 'Explode' && stack.length === 2 && stack[0] === 'Steps' && stack[1] === 'Step') row.uuidRootExplodes++;
        if (!self) stack.push(tag!);
        depth = stack.length;
      }
      void depth;
    }
  }
  const moves = compositionMoves(roots);
  for (const [ref, f] of moves) {
    const p = origins.get(ref);
    if (!p) continue;
    const q = [
      f.r[0]! * p[0] + f.r[1]! * p[1] + f.r[2]! * p[2] + f.t[0],
      f.r[3]! * p[0] + f.r[4]! * p[1] + f.r[5]! * p[2] + f.t[1],
      f.r[6]! * p[0] + f.r[7]! * p[1] + f.r[8]! * p[2] + f.t[2],
    ];
    const d = Math.hypot(q[0]! - p[0], q[1]! - p[1], q[2]! - p[2]);
    // A turn in place moves no origin; count it as moved when it turns > ~1 degree.
    const turned = 3 - (f.r[0]! + f.r[4]! + f.r[8]!) > 3e-4;
    if (d > MOVE_EPS || turned) row.moved++;
    if (d > BIG_MOVE) row.bigMoved++;
    row.maxMoveUnits = Math.max(row.maxMoveUnits, d);
  }
  row.movedShare = row.parts ? row.moved / row.parts : 0;
  return row;
}

const [outPath, ...inputs] = process.argv.slice(2);
if (!outPath || !inputs.length) {
  console.error('usage: bun scripts/_root_step_census.ts <out.json> <dir-or-file>...');
  process.exit(64);
}
const files: string[] = [];
for (const input of inputs) {
  if (statSync(input).isDirectory()) {
    for (const n of readdirSync(input)) if (/\.(lxfml|lxf)$/i.test(n)) files.push(join(input, n));
  } else files.push(input);
}
const rows: Row[] = [];
for (const [i, f] of files.entries()) {
  rows.push(census(f));
  if ((i + 1) % 200 === 0) console.error(`${i + 1}/${files.length}`);
}
writeFileSync(outPath, JSON.stringify(rows, null, 1));
const by = (pred: (r: Row) => boolean) => {
  const rs = rows.filter(pred);
  return `${rs.length} files / ${new Set(rs.map(r => r.set)).size} sets`;
};
console.log(`files ${rows.length}; errors ${rows.filter(r => r.error).length}`);
console.log(`refID schema: ${by(r => r.schema === 'refID')}; uuid schema: ${by(r => r.schema === 'uuid')}; none: ${by(r => r.schema === 'none')}`);
console.log(`root placements present: ${by(r => r.rootPlacements > 0)}`);
console.log(`any part moved: ${by(r => r.moved > 0)}; a part moved > ${BIG_MOVE} units: ${by(r => r.bigMoved > 0)}`);
console.log(`>= 10 parts moved > ${BIG_MOVE} units: ${by(r => r.bigMoved >= 10)}`);
console.log(`uuid-schema root explodes present (not applied): ${by(r => r.uuidRootExplodes > 0)}`);
console.log(`placements moved (sum): ${rows.reduce((s, r) => s + r.moved, 0)}; big: ${rows.reduce((s, r) => s + r.bigMoved, 0)}`);
