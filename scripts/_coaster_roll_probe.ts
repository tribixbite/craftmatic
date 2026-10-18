/**
 * Where does the car ROLL about the track, and how fast?
 *
 * Reported from the device on 10303: the cart makes a "physically impossible
 * around-track swivel" entering and leaving the inverted loops, with a "strange
 * blip right before the loops". Both are the up vector turning about the
 * tangent — a roll — where the track itself does not. `coasterTrackUps` blends
 * three targets (gravity up, a loop's own normal, gravity again past 90
 * degrees) under a twist-rate cap, so a bad handover shows as a spike in
 * degrees per block.
 *
 * This prints the roll rate along the arc and names the worst samples, so the
 * fault has an arc position to look at instead of a description.
 *
 * Usage: bun scripts/_coaster_roll_probe.ts <model.ldr|.mpd> [--route 0] [--top 12]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.ts';
import { detectCoasterAssemblies } from '../web/src/engine/coaster-assemblies.ts';
import { coasterRoutesFromAssemblies, coasterTrackUps } from '../web/src/engine/bedrock-coaster.ts';
import { buildCoasterPath } from '../web/src/engine/coaster-path.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const argv = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const i = argv.indexOf(flag);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const ROUTE = num('--route', 0);
const TOP = num('--top', 12);
const WINDOW = num('--window', NaN);
const SPAN = num('--span', 8);
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): [number, number, number] =>
  [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const unit = (v: readonly number[]): [number, number, number] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return l > 1e-12 ? [v[0]! / l, v[1]! / l, v[2]! / l] : [0, 0, 0];
};

for (const file of files) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const tracks = extractCoasterTrackRoutes(doc.bricks, { isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0 });
  const assemblies = detectCoasterAssemblies(doc.bricks, meshes, tracks);
  // Roll is invariant to translation and to a UNIFORM scale, and the detail
  // voxeliser is isotropic (LDU_XZ === LDU_PER_Y === 8), so a synthetic origin
  // measures the same angles the pipeline's own grid would.
  const scene = coasterRoutesFromAssemblies(tracks, assemblies, doc.bricks, { x: 0, y: 0, z: 0, scale: 1, cellXZ: 8, cellY: 8 });
  const route = scene.routes[ROUTE];
  if (!route) { console.log(`${basename(file)}: no route ${ROUTE}`); continue; }

  const path = buildCoasterPath(route.points as never, route.closed, route.maxSegmentLength ?? 2);
  const ups = coasterTrackUps(path);
  const pts = path.points, cum = path.cumulative, last = pts.length - 1;

  interface Row { i: number; arc: number; rollDeg: number; perBlock: number; pitchDeg: number; inverted: boolean }
  const rows: Row[] = [];
  for (let i = 1; i <= last; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const t = unit([b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]);
    const u0 = ups[i - 1]!, u1 = ups[i]!;
    // Roll is the turn of the up vector ABOUT the tangent; the component of the
    // turn along the tangent is what a rider feels as a barrel roll.
    const roll = Math.atan2(dot(cross(u0, u1), t), dot(u0, u1)) * 180 / Math.PI;
    const ds = Math.max(1e-6, cum[i]! - cum[i - 1]!);
    rows.push({
      i, arc: cum[i]!, rollDeg: roll, perBlock: roll / ds,
      pitchDeg: Math.asin(Math.max(-1, Math.min(1, t[1]!))) * 180 / Math.PI,
      inverted: (u1[1] ?? 0) < 0,
    });
  }

  const invertedRuns: Array<{ from: number; to: number }> = [];
  let open: number | null = null;
  for (const r of rows) {
    if (r.inverted && open === null) open = r.arc;
    if (!r.inverted && open !== null) { invertedRuns.push({ from: open, to: r.arc }); open = null; }
  }
  if (open !== null) invertedRuns.push({ from: open, to: rows[rows.length - 1]!.arc });

  if (Number.isFinite(WINDOW)) {
    console.log(`${basename(file)} route ${ROUTE}: samples around arc ${WINDOW}`);
    console.log('     arc    pitch   level  upright  up.y   roll  branch');
    for (let i = 1; i <= last; i++) {
      if (Math.abs(cum[i]! - WINDOW) > SPAN) continue;
      const a = pts[i - 1]!, b = pts[i]!;
      const t = unit([b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]);
      const u = ups[i]!, u0 = ups[i - 1]!;
      const level = Math.hypot(t[0]!, t[2]!);
      const g = level > 1e-6 ? unit([-t[1]! * t[0]!, 1 - t[1]! * t[1]!, -t[1]! * t[2]!]) : null;
      const upright = g ? dot(u, g) : -1;
      const roll = Math.atan2(dot(cross(u0, u), t), dot(u0, u)) * 180 / Math.PI;
      const branch = upright > 0.5 && g ? 'gravity(>0.5)' : upright > 0 && g ? 'gravity(>0)' : 'none/loop';
      console.log(`  ${cum[i]!.toFixed(1).padStart(7)}  ${(Math.asin(Math.max(-1, Math.min(1, t[1]!))) * 180 / Math.PI).toFixed(0).padStart(5)}  ${level.toFixed(3)}  ${upright.toFixed(3).padStart(7)}  ${u[1]!.toFixed(3).padStart(6)}  ${roll.toFixed(1).padStart(6)}  ${branch}`);
    }
    continue;
  }

  const worst = [...rows].sort((a, b) => Math.abs(b.perBlock) - Math.abs(a.perBlock)).slice(0, TOP);
  const total = rows.reduce((s, r) => s + Math.abs(r.rollDeg), 0);
  console.log(`${basename(file)}  route ${ROUTE} "${route.label}"  ${pts.length} samples, ${cum[last]!.toFixed(1)} blocks, closed=${route.closed}`);
  console.log(`  inverted runs (up.y < 0): ${invertedRuns.length ? invertedRuns.map(r => `${r.from.toFixed(1)}..${r.to.toFixed(1)}`).join(', ') : 'none'}`);
  console.log(`  total |roll| ${total.toFixed(0)} deg over the lap; worst samples by deg/block:`);
  for (const r of worst) {
    const near = invertedRuns.find(v => r.arc >= v.from - 6 && r.arc <= v.to + 6);
    console.log(`    arc ${r.arc.toFixed(1).padStart(7)}  roll ${r.rollDeg.toFixed(1).padStart(7)} deg  ${r.perBlock.toFixed(1).padStart(7)} deg/block  pitch ${r.pitchDeg.toFixed(0).padStart(4)}  ${r.inverted ? 'INVERTED' : ''}${near && !r.inverted ? ' (at a loop edge)' : ''}`);
  }
}
