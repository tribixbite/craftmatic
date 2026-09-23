/**
 * Solve the LDD→LDraw correction for a coaster mould from the track itself.
 *
 * A design with no alignment row is placed from its raw LDD bone, and for
 * track that shows as a piece joining nothing. The correction is recoverable
 * without any second source, because track is a CHAIN: the pieces whose
 * moulds are rowed are anchors in the right place, and the unrowed mould's
 * correction is whatever makes its endpoints meet theirs.
 *
 * The correction acts entirely in part-local space — `composeLxfMeasured`
 * gives `pos = t_ldr + R_ldr·e`, `rot = R_ldr·D`, so an endpoint sample `s`
 * becomes `D·s + e`. So for a candidate rotation D, hypothesising that one
 * endpoint of an unrowed piece meets one anchor endpoint FIXES e:
 *
 *     e = rot0ᵀ·(A − pos0) − D·s
 *
 * Every (D, piece-endpoint, anchor-endpoint) triple is one hypothesis; each is
 * scored by how many joins it makes across the WHOLE model, so a hypothesis
 * that happens to close one seam and break the rest cannot win.
 *
 * This is also the decisive experiment: if no correction joins anything, the
 * mould is not why the track is broken and the source is.
 *
 * Usage: bun scripts/_solve_track_align.ts <model.ldr> [--design 25059] [--top 5]
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';
import { partStem } from '../web/src/engine/part-id.ts';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FILE = argv.find(a => !a.startsWith('--'));
if (!FILE) { console.error('usage: bun scripts/_solve_track_align.ts <model.ldr> [--design N]'); process.exit(64); }
const TOP = Number(flag('top') ?? 5);
/** The stitcher's own join tolerance. */
const JOIN_LDU = 3;

const partMap = JSON.parse(readFileSync('web/public/ldd-part-map.json', 'utf8')) as Record<string, unknown>;
const mapEntries = (partMap['entries'] ?? partMap) as Record<string, unknown>;
const measured = JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')) as Record<string, unknown>;
const measEntries = (measured['entries'] ?? measured) as Record<string, unknown>;
const rowed = (mould: string): boolean => mapEntries[mould] !== undefined || measEntries[mould] !== undefined;

type V = [number, number, number];
type M = number[];
const I3: M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const tr = (a: M): M => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const ap = (a: M, v: readonly number[]): V => [
  a[0]!*v[0]!+a[1]!*v[1]!+a[2]!*v[2]!,
  a[3]!*v[0]!+a[4]!*v[1]!+a[5]!*v[2]!,
  a[6]!*v[0]!+a[7]!*v[1]!+a[8]!*v[2]!];
const mulM = (a: M, b: M): M => [
  a[0]!*b[0]!+a[1]!*b[3]!+a[2]!*b[6]!, a[0]!*b[1]!+a[1]!*b[4]!+a[2]!*b[7]!, a[0]!*b[2]!+a[1]!*b[5]!+a[2]!*b[8]!,
  a[3]!*b[0]!+a[4]!*b[3]!+a[5]!*b[6]!, a[3]!*b[1]!+a[4]!*b[4]!+a[5]!*b[7]!, a[3]!*b[2]!+a[4]!*b[5]!+a[5]!*b[8]!,
  a[6]!*b[0]!+a[7]!*b[3]!+a[8]!*b[6]!, a[6]!*b[1]!+a[7]!*b[4]!+a[8]!*b[7]!, a[6]!*b[2]!+a[7]!*b[5]!+a[8]!*b[8]!];

function axisAlignedRotations(): M[] {
  const out: M[] = [];
  const basis = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const x of basis) for (const y of basis) {
    if (Math.abs(x[0]!*y[0]! + x[1]!*y[1]! + x[2]!*y[2]!) > 1e-9) continue;
    const z = [x[1]!*y[2]! - x[2]!*y[1]!, x[2]!*y[0]! - x[0]!*y[2]!, x[0]!*y[1]! - x[1]!*y[0]!];
    out.push([x[0]!, y[0]!, z[0]!, x[1]!, y[1]!, z[1]!, x[2]!, y[2]!, z[2]!]);
  }
  return out;
}

const bricks = parseLDrawDocument(readFileSync(FILE, 'latin1')).bricks;

/** One track placement, with the profile samples that give its endpoints. */
interface Piece {
  mould: string; brick: ParsedBrick; rot: M; pos: V;
  /** Ends in PART space, plus the neighbouring sample that gives the tangent. */
  ends: Array<{ s: V; inner: V }>;
}
const pieces: Piece[] = [];
for (const b of bricks) {
  const p = coasterTrackProfile(b.part);
  if (!p) continue;
  const s = p.samples;
  if (!s || s.length < 2) continue;
  pieces.push({
    mould: partStem(b.part), brick: b, rot: b.rot ?? I3, pos: [b.x, b.y, b.z],
    ends: [
      { s: s[0] as unknown as V, inner: s[1] as unknown as V },
      { s: s.at(-1) as unknown as V, inner: s.at(-2) as unknown as V },
    ],
  });
}

const DESIGN = flag('design');
const targets = [...new Set(pieces.filter(p => !rowed(p.mould)).map(p => p.mould))]
  .filter(m => !DESIGN || m === DESIGN);
const anchors = pieces.filter(p => rowed(p.mould));

console.log(`${FILE.replace(/.*lego_sets[/\\]/, '')}: ${pieces.length} track pieces`);
console.log(`  anchors (rowed): ${anchors.length}  [${[...new Set(anchors.map(a => a.mould))].join(', ')}]`);
console.log(`  unrowed designs to solve: ${targets.length ? targets.join(', ') : '(none)'}`);
if (!targets.length || !anchors.length) process.exit(0);

/** World endpoint of a piece under a candidate correction. */
const endWorld = (p: Piece, end: { s: V; inner: V }, D: M, e: V): { at: V; out: V } => {
  const local: V = [
    ap(D, end.s)[0] + e[0], ap(D, end.s)[1] + e[1], ap(D, end.s)[2] + e[2]];
  const localIn: V = [
    ap(D, end.inner)[0] + e[0], ap(D, end.inner)[1] + e[1], ap(D, end.inner)[2] + e[2]];
  const w = ap(p.rot, local), wi = ap(p.rot, localIn);
  const at: V = [w[0] + p.pos[0], w[1] + p.pos[1], w[2] + p.pos[2]];
  const inner: V = [wi[0] + p.pos[0], wi[1] + p.pos[1], wi[2] + p.pos[2]];
  const d: V = [at[0] - inner[0], at[1] - inner[1], at[2] - inner[2]];
  const m = Math.hypot(d[0], d[1], d[2]) || 1;
  return { at, out: [d[0] / m, d[1] / m, d[2] / m] };
};

/** Every anchor endpoint, in world space, with its outward tangent. */
const anchorEnds = anchors.flatMap(a => a.ends.map(end => endWorld(a, end, I3, [0, 0, 0])));

/** How many endpoints of `mould`'s pieces meet an anchor endpoint under (D, e)? */
function score(mould: string, D: M, e: V): { joins: number; residual: number } {
  let joins = 0, residual = 0;
  for (const p of pieces) {
    if (p.mould !== mould) continue;
    for (const end of p.ends) {
      const w = endWorld(p, end, D, e);
      let best = Infinity, bestDot = -1;
      for (const a of anchorEnds) {
        const dist = Math.hypot(w.at[0] - a.at[0], w.at[1] - a.at[1], w.at[2] - a.at[2]);
        if (dist < best) {
          best = dist;
          bestDot = -(w.out[0] * a.out[0] + w.out[1] * a.out[1] + w.out[2] * a.out[2]);
        }
      }
      if (best <= JOIN_LDU && bestDot >= 0.97) { joins++; residual += best; }
    }
  }
  return { joins, residual };
}

for (const mould of targets) {
  const mine = pieces.filter(p => p.mould === mould);
  const seen = new Map<string, { D: M; e: V; joins: number; residual: number }>();
  for (const D of axisAlignedRotations()) {
    for (const p of mine) {
      const rotT = tr(p.rot);
      for (const end of p.ends) {
        const Ds = ap(D, end.s);
        for (const a of anchorEnds) {
          const delta: V = [a.at[0] - p.pos[0], a.at[1] - p.pos[1], a.at[2] - p.pos[2]];
          const back = ap(rotT, delta);
          const e: V = [back[0] - Ds[0], back[1] - Ds[1], back[2] - Ds[2]];
          // A correction is bounded by the part itself; anything larger is not
          // an origin convention, it is a coincidence.
          if (Math.hypot(e[0], e[1], e[2]) > 400) continue;
          const key = D.map(v => v.toFixed(0)).join('') + '|' + e.map(v => v.toFixed(1)).join(',');
          if (seen.has(key)) continue;
          const sc = score(mould, D, e);
          if (sc.joins > 0) seen.set(key, { D, e, ...sc });
        }
      }
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.joins - a.joins || a.residual - b.residual);
  console.log(`\n  ${mould}: ${mine.length} piece(s), ${mine.length * 2} endpoints`);
  if (!ranked.length) {
    console.log('    NO correction joins this mould to any anchor.');
    console.log('    => the mould is not why this track is broken; the source places the piece somewhere no correction reaches.');
    continue;
  }
  for (const r of ranked.slice(0, TOP)) {
    console.log(`    joins ${r.joins}/${mine.length * 2}  residual ${r.residual.toFixed(2)} LDU  e=(${r.e.map(v => v.toFixed(1)).join(', ')})  D=[${r.D.join(',')}]`);
  }
}
