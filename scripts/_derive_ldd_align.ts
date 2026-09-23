/**
 * Measure an LDD→LDraw correction for a design neither alignment table names.
 *
 * A design with no row is placed from its raw LDD bone at `<design>.dat`, which
 * is wrong twice over: the FILENAME may name a different mould, and the origin
 * convention differs. Both show up as a part sitting studs from where it
 * belongs — which is why 42703's coaster track has seven pieces that join
 * nothing while its three aligned pieces join each other.
 *
 * The measurement needs a set that exists BOTH as an LXFML and as an
 * independently authored LDraw model (Mecabricks). Then nothing is fitted:
 *
 *   1. build the LXFML with this repo's own placement code, so an unrowed
 *      design lands at `rot0 = F·R_bone·F`, `pos0 = 25·(F·t_bone)`;
 *   2. recover the global frame G between the two models from the parts whose
 *      moulds ARE rowed, by trying the 24 axis-aligned rotations and keeping
 *      the one with the most inliers;
 *   3. for each instance of the unrowed design, read its counterpart in the
 *      reference and solve the row exactly:
 *          D = (G·rot0)ᵀ · rot_true
 *          e = (G·rot0)ᵀ · (pos_true − G·pos0 − t_G)
 *   4. vote over instances and sets; a correction is only believable when the
 *      instances agree.
 *
 * Usage:
 *   bun scripts/_derive_ldd_align.ts <in.lxfml> <reference.ldr> [--design 25059]
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import {
  applyMeasuredBound, buildLxfPlacements, validatePartAlign, validateMeasuredAlign, validateTable,
  type LxfPartRecord, type LxfAlignmentTable, type LxfMeasuredTable,
} from '../web/src/engine/lxf-parser.ts';

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [LXFML, REFERENCE] = positional;
if (!LXFML || !REFERENCE) {
  console.error('usage: bun scripts/_derive_ldd_align.ts <in.lxfml> <reference.ldr> [--design N]');
  process.exit(64);
}
const ONLY_DESIGN = flag('design');
/**
 * How far apart two parts may be and still be called the same placement.
 *
 * An independently authored reference is not a copy: it rebuilds the model
 * from the same instructions, so a part can sit a plate or two from where LDD
 * put it. Too tight and a correct frame scores near zero; too loose and a
 * wrong frame scores well. Report the curve rather than trusting one value.
 */
const INLIER_LDU = Number(flag('tol') ?? 2);

// ── tables ─────────────────────────────────────────────────────────────────
const table = validateTable(
  JSON.parse(readFileSync('web/public/ldd-part-map.json', 'utf8')),
  'web/public/ldd-part-map.json', validatePartAlign,
) as LxfAlignmentTable;
const measured = applyMeasuredBound(validateTable(
  JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')),
  'web/public/ldd-measured-align.json', validateMeasuredAlign,
) as LxfMeasuredTable);
const isRowed = (design: string): boolean =>
  table.entries[design] !== undefined || measured.entries[design] !== undefined;

// ── the LXFML, with each record's design kept alongside its placement ───────
const PART_RE = /<Part\b([^>]*)>([\s\S]*?)<\/Part>|<Part\b([^>]*)\/>/g;
const BRICK_RE = /<Brick\b([^>]*)>([\s\S]*?)<\/Brick>/g;
const BONE_RE = /<Bone\b([^>]*?)\/?>/g;
const attr = (head: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(head)?.[1];

const records: LxfPartRecord[] = [];
const designOf: string[] = [];
const xml = readFileSync(LXFML, 'latin1');
for (const brick of xml.matchAll(BRICK_RE)) {
  const brickDesign = attr(brick[1] ?? '', 'designID');
  for (const part of (brick[2] ?? '').matchAll(PART_RE)) {
    const head = part[1] ?? part[3] ?? '';
    const bones = [...(part[2] ?? '').matchAll(BONE_RE)];
    const design = (attr(head, 'designID') ?? brickDesign ?? '3001').split(';')[0]!.trim();
    records.push({
      designID: design,
      materialId: parseInt((attr(head, 'materials') ?? '').split(',')[0]!, 10) || 194,
      transformation: attr(bones[0]?.[1] ?? '', 'transformation') ?? '',
      boneCount: bones.length,
    });
    designOf.push(design);
  }
}
const built = buildLxfPlacements(records, table, measured);
// `buildLxfPlacements` emits one brick per record in order, so the design of
// brick i is designOf[i] — the only way to know which placement is unrowed.
const ours = built.bricks;
if (ours.length !== designOf.length) {
  console.error(`placement count ${ours.length} != record count ${designOf.length}; cannot attribute designs`);
  process.exit(1);
}

const reference = parseLDrawDocument(readFileSync(REFERENCE, 'latin1')).bricks;

// ── 3x3 helpers ────────────────────────────────────────────────────────────
type M = number[];
const I3: M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a: M, b: M): M => [
  a[0]!*b[0]!+a[1]!*b[3]!+a[2]!*b[6]!, a[0]!*b[1]!+a[1]!*b[4]!+a[2]!*b[7]!, a[0]!*b[2]!+a[1]!*b[5]!+a[2]!*b[8]!,
  a[3]!*b[0]!+a[4]!*b[3]!+a[5]!*b[6]!, a[3]!*b[1]!+a[4]!*b[4]!+a[5]!*b[7]!, a[3]!*b[2]!+a[4]!*b[5]!+a[5]!*b[8]!,
  a[6]!*b[0]!+a[7]!*b[3]!+a[8]!*b[6]!, a[6]!*b[1]!+a[7]!*b[4]!+a[8]!*b[7]!, a[6]!*b[2]!+a[7]!*b[5]!+a[8]!*b[8]!];
const tr = (a: M): M => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const ap = (a: M, v: number[]): number[] => [
  a[0]!*v[0]!+a[1]!*v[1]!+a[2]!*v[2]!,
  a[3]!*v[0]!+a[4]!*v[1]!+a[5]!*v[2]!,
  a[6]!*v[0]!+a[7]!*v[1]!+a[8]!*v[2]!];

/** The 24 rotations that map the cubic lattice onto itself. */
function axisAlignedRotations(): M[] {
  const out: M[] = [];
  const basis = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const x of basis) for (const y of basis) {
    if (Math.abs(x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!) > 1e-9) continue;
    const z = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!];
    out.push([x[0]!, y[0]!, z[0]!, x[1]!, y[1]!, z[1]!, x[2]!, y[2]!, z[2]!]);
  }
  return out;
}

const pos = (b: ParsedBrick): number[] => [b.x, b.y, b.z];

/**
 * The global frame between the two models, from the ROWED parts only.
 *
 * A centroid fit is no good here: the two files rarely hold the same
 * inventory, so their centroids are not the same point. Instead every pair of
 * same-mould parts VOTES for the translation it implies, and the right
 * translation is the one many pairs agree on. Quantising the vote to 1 LDU
 * makes that a mode, not a fit, so a hundred disagreeing pairs cannot drag it.
 */
function findGlobalFrame(): { r: M; t: number[]; inliers: number } {
  const anchors = ours.filter((_, i) => isRowed(designOf[i]!));
  const byPart = new Map<string, ParsedBrick[]>();
  for (const b of reference) {
    const s = partStem(b.part);
    const a = byPart.get(s) ?? [];
    a.push(b);
    byPart.set(s, a);
  }
  // Distinctive moulds first: a mould with 200 copies votes for everything.
  const voters = anchors
    .filter(b => (byPart.get(partStem(b.part))?.length ?? 0) > 0)
    .filter(b => (byPart.get(partStem(b.part))!.length) <= 12)
    .slice(0, 900);

  let best = { r: I3, t: [0, 0, 0], inliers: -1 };
  for (const r of axisAlignedRotations()) {
    const votes = new Map<string, { t: number[]; n: number }>();
    for (const b of voters) {
      const p = ap(r, pos(b));
      for (const c of byPart.get(partStem(b.part))!) {
        const t = [c.x - p[0]!, c.y - p[1]!, c.z - p[2]!];
        const key = t.map(v => Math.round(v)).join(',');
        const hit = votes.get(key);
        if (hit) hit.n++;
        else votes.set(key, { t, n: 1 });
      }
    }
    let top: { t: number[]; n: number } | null = null;
    for (const v of votes.values()) if (!top || v.n > top.n) top = v;
    if (!top) continue;
    // Score the winning translation over ALL rowed parts, not just the voters.
    let inliers = 0;
    for (const b of anchors) {
      const p = ap(r, pos(b));
      const q = [p[0]! + top.t[0]!, p[1]! + top.t[1]!, p[2]! + top.t[2]!];
      const candidates = byPart.get(partStem(b.part)) ?? [];
      if (candidates.some(c => Math.hypot(c.x - q[0]!, c.y - q[1]!, c.z - q[2]!) <= INLIER_LDU)) inliers++;
    }
    if (inliers > best.inliers) best = { r, t: top.t, inliers };
  }
  return best;
}

const G = findGlobalFrame();
const anchorCount = ours.filter((_, i) => isRowed(designOf[i]!)).length;
console.log(`${LXFML.replace(/.*lego_sets[/\\]/, '')}  vs  ${REFERENCE.replace(/.*lego_sets[/\\]/, '')}`);
console.log(`  ${ours.length} placements (${anchorCount} rowed), reference ${reference.length}`);
console.log(`  global frame: ${G.inliers}/${anchorCount} rowed parts agree within ${INLIER_LDU} LDU`);
if (G.inliers < 20) {
  console.log('  REFUSED: too few agreeing parts — the two files are not the same build.');
  process.exit(2);
}

// ── solve each unrowed design ──────────────────────────────────────────────
const unrowed = new Map<string, number[]>();
ours.forEach((_, i) => {
  const d = designOf[i]!;
  if (isRowed(d)) return;
  if (ONLY_DESIGN && d !== ONLY_DESIGN) return;
  const a = unrowed.get(d) ?? [];
  a.push(i);
  unrowed.set(d, a);
});

console.log(`\n  unrowed designs present: ${unrowed.size}`);
for (const [design, indices] of [...unrowed].sort((a, b) => b[1].length - a[1].length)) {
  const used = reference.filter(b => !ours.some((o, i) => isRowed(designOf[i]!) && partStem(o.part) === partStem(b.part)));
  const rows: Array<{ part: string; d: M; e: number[] }> = [];
  for (const i of indices) {
    const b = ours[i]!;
    const rot0 = b.rot ?? I3;
    const p0 = ap(G.r, pos(b));
    const world = [p0[0]! + G.t[0]!, p0[1]! + G.t[1]!, p0[2]! + G.t[2]!];
    // The counterpart is the nearest reference part that is NOT already
    // explained by a rowed placement.
    let best: { b: ParsedBrick; d: number } | null = null;
    for (const c of used) {
      const dist = Math.hypot(c.x - world[0]!, c.y - world[1]!, c.z - world[2]!);
      if (!best || dist < best.d) best = { b: c, d: dist };
    }
    if (!best || best.d > 200) continue;
    const rotG = mul(G.r, rot0);
    const rotGT = tr(rotG);
    const D = mul(rotGT, best.b.rot ?? I3);
    const delta = [best.b.x - world[0]!, best.b.y - world[1]!, best.b.z - world[2]!];
    const e = ap(rotGT, delta);
    rows.push({ part: partStem(best.b.part), d: D, e });
  }
  if (!rows.length) { console.log(`    ${design}: no counterpart found`); continue; }
  const parts = new Map<string, number>();
  for (const r of rows) parts.set(r.part, (parts.get(r.part) ?? 0) + 1);
  const spread = (k: number): string => {
    const v = rows.map(r => r.e[k]!);
    return `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}`;
  };
  const mean = [0, 1, 2].map(k => rows.reduce((s, r) => s + r.e[k]!, 0) / rows.length);
  const agree = rows.every(r => r.d.every((v, k) => Math.abs(v - rows[0]!.d[k]!) < 1e-6));
  console.log(`    design ${design}: ${rows.length} instance(s)`);
  console.log(`      reference part: ${[...parts].map(([p, n]) => `${n}x ${p}`).join(', ')}`);
  console.log(`      D identical across instances: ${agree}  D=[${rows[0]!.d.map(v => v.toFixed(2)).join(',')}]`);
  console.log(`      e mean (${mean.map(v => v.toFixed(1)).join(', ')}) LDU   spread x ${spread(0)}  y ${spread(1)}  z ${spread(2)}`);
}
