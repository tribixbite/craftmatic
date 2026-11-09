/**
 * Render a generated coaster's rail geometry OFFLINE (WP-C03): the chunks of
 * `buildTrackMesh` drawn with the pack renderer's own rasteriser
 * (`renderActorsDetailed`), with the device's draw reach applied per chunk
 * (an actor is drawn only while its ROOT is within `ACTOR_DRAW_CEILING_BLOCKS`
 * of the camera; CLAUDE.md, round 2026-09-26a). `_pack_render.ts --walk-away`
 * needs a built pack, and the generated route is not wired into a pack until
 * C02, so this script stands in: same rasteriser, same cull rule, no pack.
 *
 *   overview.png          the whole course, no cull
 *   rider-<k>-reach.png   a rider at k positions along the course looking ahead, ONLY chunks in reach drawn
 *   rider-<k>-nocull.png  the same view with every chunk drawn (what the reach removes)
 *   closeup.png           a few blocks from a joint on a curve: bars, ties, studs
 *   report.json           stats, the entity-vs-block comparison, per-view visible chunk counts
 *
 * Usage: bun scripts/_coaster_track_render.ts [--design=<CoasterDesign.json>] [--out=output/c03]
 *          [--image=1200x800] [--riders=4]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { generateCoaster, type CoasterDesign } from '../web/src/engine/coaster-design.ts';
import { buildTrackMesh, compareRailRepresentations, type TrackMeshChunk } from '../web/src/engine/coaster-track-mesh.ts';
import { renderActorsDetailed } from '../web/src/sim/adapters/craftmatic/snapshot.ts';
import { worldFaces, type AuditActor, type GeoBoneLike, type GeoCubeLike, type GeoGroupLike, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';
import { ACTOR_DRAW_CEILING_BLOCKS } from '../web/src/engine/bedrock-lod-hull.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const designPath = flag('design') ?? 'test/fixtures/coaster/3x-sketch.json';
const outDir = flag('out') ?? 'output/c03';
const [W, H] = (flag('image') ?? '1200x800').split(/x/i).map(Number) as [number, number];
const riders = Number(flag('riders') ?? 4);
if (W >= 2000 || H >= 2000) throw new Error('image dimensions must stay under 2000 px');
mkdirSync(outDir, { recursive: true });

const gen = generateCoaster(JSON.parse(readFileSync(designPath, 'utf8')) as CoasterDesign);
const mesh = buildTrackMesh(gen);
const comparison = compareRailRepresentations(gen, mesh);

/**
 * One chunk as an actor of the shared renderer: its geometries become colour groups, the root its placement.
 * worldFaces mirrors the geometry's Z about the actor, so the placement's z is the root's z negated (the world is the route frame mirrored in Z).
 */
function actorOf(chunk: TrackMeshChunk): AuditActor {
  const bones: GeoBoneLike[] = [{ name: 'track', pivot: [0, 0, 0] }];
  const groups: GeoGroupLike[] = chunk.geometry['minecraft:geometry'].map((geo, i): GeoGroupLike => ({
    ldrawColor: chunk.materials[i]!.ldrawColor, alpha: 1,
    cubes: geo.bones[0]!.cubes.map((c): GeoCubeLike => ({ bone: 'track', origin: c.origin, size: c.size, rotation: c.rotation, pivot: c.pivot })),
  }));
  return { typeId: `craftmatic:${chunk.id}`, kind: 'track', entry: { groups, bones }, at: { x: chunk.root[0], y: chunk.root[1], z: -chunk.root[2] }, yawDeg: 0 };
}
const actors = mesh.chunks.map(actorOf);

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const unit = (a: readonly number[]): Vec3 => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l]; };

/**
 * The renderer draws in worldFaces' frame (the JSON frame with Z mirrored); a world point is the route point with z negated.
 */
const toWorld = (p: readonly number[]): Vec3 => [p[0]!, p[1]!, -p[2]!];

async function shot(name: string, eyeRoute: Vec3, atRoute: Vec3, cull: boolean, fovDeg = 60): Promise<{ drawn: number; total: number }> {
  const eye = toWorld(eyeRoute), at = toWorld(atRoute);
  const keep = actors.filter((_, i) => !cull || dist(mesh.chunks[i]!.root, eyeRoute) <= ACTOR_DRAW_CEILING_BLOCKS);
  const faces = worldFaces(keep);
  const res = renderActorsDetailed(keep, faces, { eye, at, fovDeg, width: W, height: H }, { uvFloor: 'none', hatch: false });
  await sharp(Buffer.from(res.rgb), { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${outDir}/${name}.png`);
  return { drawn: keep.length, total: actors.length };
}

const pts = gen.route.points;
const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
for (const p of pts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, p[a]!); hi[a] = Math.max(hi[a]!, p[a]!); }
const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
const report: Record<string, unknown> = { design: designPath, stats: mesh.stats, warnings: mesh.warnings, comparison, views: {} as Record<string, unknown> };
const views = report['views'] as Record<string, unknown>;

// Overview from a corner above the course.
const d = unit([1, 0.55, 1.2]);
const farEye = (r: number): Vec3 => [centre[0] + d[0] * r, centre[1] + d[1] * r, centre[2] + d[2] * r];
views['overview'] = await shot('overview', farEye(radius / Math.sin(30 * Math.PI / 180) * 0.62), centre, false);
// Side-on (x-z mirrored axis irrelevant): looking along the course's longest horizontal axis.
views['overview-side'] = await shot('overview-side', [centre[0], centre[1] + 10, centre[2] + radius * 2.1], centre, false);

// Riders: evenly spaced along the course, 1.62 above the rail, looking 12 blocks ahead.
const n = pts.length - 1;
for (let k = 0; k < riders; k++) {
  const i = Math.floor((k + 0.5) / riders * n), ahead = Math.min(n - 1, i + 35);
  const eye: Vec3 = [pts[i]![0], pts[i]![1] + 1.62, pts[i]![2]];
  const at: Vec3 = [pts[ahead]![0], pts[ahead]![1] + 1.0, pts[ahead]![2]];
  views[`rider-${k}-reach`] = { arc: gen.analysis.arc[i], ...await shot(`rider-${k}-reach`, eye, at, true, 75) };
  views[`rider-${k}-nocull`] = await shot(`rider-${k}-nocull`, eye, at, false, 75);
}

// The crest: the highest sample, from 8 blocks back and 4 up, looking down the track, with the reach applied.
let crest = 0;
for (let i = 0; i < n; i++) if (pts[i]![1] > pts[crest]![1]) crest = i;
const back = pts[(crest - 25 + n) % n]!, next = pts[(crest + 25) % n]!;
views['crest-reach'] = { arc: gen.analysis.arc[crest], ...await shot('crest-reach', [back[0], back[1] + 4, back[2]], [next[0], next[1] - 10, next[2]], true, 80) };

// A close-up of rails, ties and studs near the first curve: the sample where the tangent has turned most over 8 blocks.
let bend = 0, bendAngle = 0;
for (let i = 0; i + 25 < n; i++) {
  const t0 = unit([pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1], pts[i + 1]![2] - pts[i]![2]]);
  const t1 = unit([pts[i + 26]![0] - pts[i + 25]![0], pts[i + 26]![1] - pts[i + 25]![1], pts[i + 26]![2] - pts[i + 25]![2]]);
  const a = Math.acos(Math.max(-1, Math.min(1, t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2])));
  if (a > bendAngle && pts[i]![1] < 6) { bendAngle = a; bend = i; }
}
const p0 = pts[bend]!, p1 = pts[Math.min(n, bend + 12)]!;
views['closeup'] = await shot('closeup', [p0[0] - 1.5, p0[1] + 2.2, p0[2] - 1.5], [p1[0], p1[1] - 0.4, p1[2]], false, 70);

writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(mesh.stats));
console.log(JSON.stringify(comparison));
for (const [k, v] of Object.entries(views)) console.log(k, JSON.stringify(v));
