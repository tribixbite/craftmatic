/**
 * Report where a built pinball pack's tap targets stand from the planned eye:
 * each target's fitted box (model blocks, relative to the eye), the box the
 * pack ships for it, whether two targets' boxes overlap, and whether every
 * sampled ray to a target crosses its own box and misses the others. Reads
 * `scripts/pinball.js`'s CONFIG out of an unpacked behaviour pack.
 *
 * Usage: bun scripts/_pinball_zone_report.ts <unpacked BP dir or pinball.js> [--pick=camera|level] [--pitch=0]
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fitPinballZone, type PinballRuntimeConfig } from '../web/src/engine/bedrock-pinball.ts';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: bun scripts/_pinball_zone_report.ts <BP dir | pinball.js> [--pick=camera|level] [--pitch=0]'); process.exit(64); }
const flag = (k: string): string | undefined => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const file = statSync(target).isDirectory() ? join(target, 'scripts', 'pinball.js') : target;
const js = readFileSync(file, 'utf8');
const cfg = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(js)?.[1] ?? 'null') as PinballRuntimeConfig | null;
if (!cfg) { console.error(`${file}: no CONFIG`); process.exit(1); }
const pick = flag('pick') === 'level' ? 'level' : 'camera';
const pitch = Number(flag('pitch') ?? 0);

const m = cfg.map;
const plane = (u: number, w: number, h: number): number[] => [0, 1, 2].map(k => m.p0[k]! + u * m.u[k]! + w * m.w[k]! + h * m.n[k]!);
const eye = cfg.cameraEye, look = cfg.cameraLook;
const reachH = Math.hypot(look[0] - eye[0], look[2] - eye[2]);
const facing = [eye[0], look[1], eye[2]].map((v, k) => (k === 1 ? v : v + (look[k]! - eye[k]!)));
void reachH;
const samples = (rect: number[], h: number): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) out.push(plane(rect[0]! + (rect[1]! - rect[0]!) * i / 4, rect[2]! + (rect[3]! - rect[2]!) * j / 4, h));
  return out;
};
const boxes = cfg.zones.specs.map(s => {
  const fit = fitPinballZone(eye, eye, facing, samples(s.rect, s.h), cfg.zones.reach, pick, pitch);
  const size = s.role === 'plunger' ? cfg.zones.plungerBox : cfg.zones.flipperBox;
  const lo = [fit.centre[0]! - size.width / 2, fit.centre[1]! - size.height / 2, fit.centre[2]! - size.width / 2];
  const hi = [fit.centre[0]! + size.width / 2, fit.centre[1]! + size.height / 2, fit.centre[2]! + size.width / 2];
  return { role: s.role, spec: s, fit, lo, hi };
});
/** Slab test: the distance along a unit ray from `o` to where it enters box [lo, hi], or Infinity. */
const enter = (o: number[], d: number[], lo: number[], hi: number[]): number => {
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (o[k]! < lo[k]! || o[k]! > hi[k]!) return Infinity; continue; }
    let a = (lo[k]! - o[k]!) / d[k]!, b = (hi[k]! - o[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
};
const rows = boxes.map(b => {
  let own = 0, other = 0, total = 0;
  for (const p of samples(b.spec.rect, b.spec.h)) {
    const d = p.map((v, k) => v - eye[k]!); const l = Math.hypot(d[0]!, d[1]!, d[2]!); const u = d.map(v => v / l);
    total++;
    // The first box along the ray is the one a tap picks.
    const hits = boxes.map(o => ({ role: o.role, t: enter(eye, u, o.lo, o.hi) })).filter(h => Number.isFinite(h.t)).sort((x, y) => x.t - y.t);
    if (hits[0]?.role === b.role) own++; else if (hits.length) other++;
  }
  const rel = b.fit.centre.map((v, k) => +(v - eye[k]!).toFixed(3));
  return { role: b.role, centreFromEye: rel, fitSize: b.fit.hi.map((v, k) => +(v - b.fit.lo[k]!).toFixed(3)), shipped: b.role === 'plunger' ? cfg.zones.plungerBox : cfg.zones.flipperBox, rayHitsOwn: `${own}/${total}`, rayHitsOther: other };
});
const overlaps: string[] = [];
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const a = boxes[i]!, b = boxes[j]!;
  if ([0, 1, 2].every(k => a.lo[k]! < b.hi[k]! && b.lo[k]! < a.hi[k]!)) overlaps.push(`${a.role}/${b.role}`);
}
console.log(JSON.stringify({ pick, pitch, reach: cfg.zones.reach, zones: rows, overlaps }, null, 1));

// --svg=<file>: the seated camera's picture (pinhole, in tangent units, so it
// holds for any field of view): the playfield outline, both flippers at rest
// and raised, the waiting ball, and each target box's silhouette. A target
// "on" its part covers that part here.
const svgOut = flag('svg');
if (svgOut) {
  const { writeFileSync } = await import('node:fs');
  const f0 = facing.map((v, k) => v - eye[k]!); const fl = Math.hypot(f0[0]!, f0[1]!, f0[2]!); const f = f0.map(v => v / fl);
  const r0 = [-f[2]!, 0, f[0]!]; // f x up (the camera's right), normalised below
  const rl = Math.hypot(r0[0]!, r0[2]!) || 1; const r = r0.map(v => v / rl);
  const u = [r[1]! * f[2]! - r[2]! * f[1]!, r[2]! * f[0]! - r[0]! * f[2]!, r[0]! * f[1]! - r[1]! * f[0]!];
  const proj = (p: number[]): [number, number] | null => {
    const d = p.map((v, k) => v - eye[k]!); const z = d[0]! * f[0]! + d[1]! * f[1]! + d[2]! * f[2]!;
    if (z <= 1e-6) return null;
    return [(d[0]! * r[0]! + d[1]! * r[1]! + d[2]! * r[2]!) / z, (d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!) / z];
  };
  const S = 900, X = (t: number): number => S / 2 + t * S / 2, Y = (t: number): number => S / 2 - t * S / 2;
  const poly = (pts: number[][], stroke: string, fill = 'none', width = 2): string => {
    const q = pts.map(proj).filter((v): v is [number, number] => !!v);
    return `<polygon points="${q.map(([a, b]) => `${X(a).toFixed(1)},${Y(b).toFixed(1)}`).join(' ')}" stroke="${stroke}" fill="${fill}" stroke-width="${width}"/>`;
  };
  const sim = cfg.sim, R = sim.ballRadius, h0 = cfg.ballH - R;
  const parts: string[] = [];
  const g = [sim.u0, sim.u0 + sim.rows * sim.cell, sim.w0, sim.w0 + sim.cols * sim.cell];
  parts.push(poly([[g[0]!, g[2]!], [g[0]!, g[3]!], [g[1]!, g[3]!], [g[1]!, g[2]!]].map(([a, b]) => plane(a!, b!, h0)), '#888'));
  for (const fp of sim.flippers) for (const [ang, col] of [[fp.restAngle, '#3c3'], [fp.activeAngle, '#cf4']] as const) {
    const du = Math.sin(ang), dw = Math.cos(ang), nu = -dw, nw = du;
    const tip = [fp.pivot[0] + du * fp.length, fp.pivot[1] + dw * fp.length];
    parts.push(poly([
      [fp.pivot[0] + nu * fp.pivotRadius, fp.pivot[1] + nw * fp.pivotRadius], [tip[0]! + nu * fp.tipRadius, tip[1]! + nw * fp.tipRadius],
      [tip[0]! - nu * fp.tipRadius, tip[1]! - nw * fp.tipRadius], [fp.pivot[0] - nu * fp.pivotRadius, fp.pivot[1] - nw * fp.pivotRadius],
    ].map(([a, b]) => plane(a!, b!, h0 + R * 0.5)), col as string));
  }
  const ring: number[][] = [];
  for (let k = 0; k < 24; k++) ring.push(plane(sim.launch[0] + Math.cos(k / 24 * Math.PI * 2) * R, sim.launch[1] + Math.sin(k / 24 * Math.PI * 2) * R, cfg.ballH));
  parts.push(poly(ring, '#fff'));
  // A box's silhouette: the convex hull of its eight corners' projections.
  for (const b of boxes) {
    const pts: [number, number][] = [];
    for (const x of [b.lo[0]!, b.hi[0]!]) for (const y of [b.lo[1]!, b.hi[1]!]) for (const z of [b.lo[2]!, b.hi[2]!]) { const q = proj([x, y, z]); if (q) pts.push(q); }
    pts.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    const cr = (o: number[], a: number[], c: number[]): number => (a[0]! - o[0]!) * (c[1]! - o[1]!) - (a[1]! - o[1]!) * (c[0]! - o[0]!);
    const lower: number[][] = [], upper: number[][] = [];
    for (const p of pts) { while (lower.length >= 2 && cr(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop(); lower.push(p); }
    for (const p of [...pts].reverse()) { while (upper.length >= 2 && cr(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop(); upper.push(p); }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    const col = b.role === 'plunger' ? '#fd4' : '#6cf';
    parts.push(`<polygon points="${hull.map(([a, c]) => `${X(a!).toFixed(1)},${Y(c!).toFixed(1)}`).join(' ')}" stroke="${col}" fill="${col}" fill-opacity="0.18" stroke-width="2"/>`);
    const c = proj(b.fit.centre);
    if (c) parts.push(`<text x="${X(c[0]).toFixed(0)}" y="${Y(c[1]).toFixed(0)}" fill="${col}" font-size="18" text-anchor="middle">${b.role}</text>`);
  }
  writeFileSync(svgOut, `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="#101418"/>${parts.join('')}<text x="10" y="24" fill="#ccc" font-size="16">seated camera, tangent units (grey: playfield; green/lime: flippers rest/raised; white: waiting ball; boxes: tap targets, ${pick} pick)</text></svg>`);
  console.log(`wrote ${svgOut}`);
}
