/**
 * Render a built pack OFFLINE, from any viewpoint, to a PNG: every actor the
 * wand spawns at a wand size (shell, figures at their export spawn, doors,
 * seats, cars) drawn from the pack's own geometry, swatch colours and face
 * atlases. A z-buffered software rasteriser, so it runs in a script with no
 * browser and shows what the geometry IS - and, with the device rules on,
 * what the PHONE shows of it (web/src/sim/render/rasterizer.ts
 * `rasterizeDetailed`, web/src/sim/adapters/craftmatic/snapshot.ts):
 *
 *   --uvfloor=v     leave out the box-UV faces the device does not draw (`UvFloorModel`,
 *                   figure-holes.ts; `v` is the Pixel-measured rule, quirk `box-uv-sub-unit-faces`);
 *                   the pixels within 8 blocks that would have shown one are counted (`droppedNear`)
 *   --hatch         paint every pixel two coplanar faces of different colour both reach in a
 *                   magenta/black check (quirk `coplanar-hatching`: the device z-fights it; which
 *                   colour wins is unknowable) - the counts are always in the JSON beside the PNG
 *   --lod           draw each actor's LOD hull instead of its geometry past its switch distance,
 *                   from the camera's distance to its root (quirk `lod-switch-camera-root`), and cull
 *                   it past its realised cull (`entityRenderCullBlocks` of the box times the size)
 *   --views=N       N pictures round the model (equal azimuths at the --dir elevation), written as
 *                   `<out stem>-v<i>.png` and one strip `<out>` (the Pixel 30j "7 angles" offline)
 *   --walk-away=a..b[:step]   pictures looking back at the model from a..b blocks off its edge, each
 *                   actor full / hull / gone per distance (`<out stem>-d<NNN>.png`, a strip, a table)
 *
 * Frame: the preview's (`addon-preview.ts`): model blocks from the placement
 * corner, Y up; JSON X is not mirrored here, so the picture may be the mirror
 * image of the game's view. Good enough to judge shape, colour and faces.
 *
 * Usage: bun scripts/_pack_render.ts <pack.mcaddon> --out=<png>
 *          [--eye=x,y,z] [--at=x,y,z] [--fov=50] [--image=900x700] [--size=100] [--far]
 *          [--kinds=shell,figure,...] [--type=<substring of typeId>]
 *          [--frame=<substring of typeId>]   aim at that actor's bounds instead of --eye/--at
 *          [--dir=x,y,z]   view direction for --frame and --views (default 1,-0.6,1.4)
 *          [--geo-from=<older.mcaddon>]   draw that pack's geometry under this pack's controllers
 *                                          (an older pack with the same ids higher in the world's stack)
 *          [--uvfloor=v] [--hatch] [--lod] [--views=N] [--walk-away=a..b[:step]]
 *   `--size=` is the WAND size in percent (100); `--image=WxH` the picture (a bare `WxH` in --size is
 *   taken as the image too, as before).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { buildAddonPreviewModel, readAddonPreviewFiles, placedPoint, entitySpawnsAt, entityCollisionFromSources } from '../web/src/ui/addon-preview-data.ts';
import { type AuditActor, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';
import { actorLodState, lodFaces, rasterMetrics, renderActorsDetailed, type SnapshotEntity } from '../web/src/sim/adapters/craftmatic/snapshot.ts';
import { paintHatch } from '../web/src/sim/render/rasterizer.ts';
import { type UvFloorModel } from '../web/src/engine/figure-holes.ts';
import { entityRenderCullBlocks } from '../web/src/engine/bedrock-lod-hull.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const vec = (s: string | undefined, d: Vec3): Vec3 => (s ? s.split(',').map(Number) as Vec3 : d);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_pack_render.ts <pack.mcaddon> --out=<png> [--eye=x,y,z --at=x,y,z | --frame=<type>] [--size=100] [--uvfloor=v] [--hatch] [--lod] [--views=N] [--walk-away=a..b]'); process.exit(2); }
const out = flag('out') ?? 'render.png';
// `--size=WxH` (the old image size) is kept; a bare number is the wand size.
const sizeFlag = flag('size');
const imageFlag = flag('image') ?? (sizeFlag && /x/i.test(sizeFlag) ? sizeFlag : undefined);
const [W, H] = (imageFlag ?? '900x700').split(/x/i).map(Number) as [number, number];
const sizePct = sizeFlag && !/x/i.test(sizeFlag) ? Number(sizeFlag) : 100;
const scale = sizePct / 100;
const fov = Number(flag('fov') ?? 50) * Math.PI / 180;
const kinds = flag('kinds')?.split(',');
const typeFilter = flag('type');
const uvFloor = (flag('uvfloor') ?? 'none') as UvFloorModel;
const hatch = args.includes('--hatch'), lod = args.includes('--lod');
const views = flag('views') ? Number(flag('views')) : 0;
const walk = flag('walk-away')?.split(/\.\.|:/).map(Number);

const bytes = readFileSync(file);
const files = await readAddonPreviewFiles(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
// `--geo-from=<older pack>`: what the game draws when an OLDER resource pack with the same geometry
// identifiers sits higher in the world's stack - its geometry under this pack's controllers and textures.
const geoFrom = flag('geo-from');
if (geoFrom) {
  const other = readFileSync(geoFrom);
  const older = await readAddonPreviewFiles(other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength) as ArrayBuffer);
  const tail = (path: string): string => path.replace(/^.*\/models\//, 'models/');
  const olderGeo = new Map([...older.appearanceSources].filter(([n]) => /\.geo\.json$/.test(n)).map(([n, t]) => [tail(n), t]));
  for (const [name] of files.appearanceSources) { const t = olderGeo.get(tail(name)); if (t !== undefined) files.appearanceSources.set(name, t); }
}
const model = buildAddonPreviewModel(files);
if (!model.appearance) throw new Error('pack has no appearance');
const boxes = entityCollisionFromSources(files.appearanceSources);
/** Every actor placed at the wand size: its appearance, its point, its yaw, its scale and its realised cull. */
interface Placed { actor: AuditActor; cull: number }
const placedActors: Placed[] = [];
for (const e of model.entities) {
  if (!entitySpawnsAt(e, sizePct)) continue;
  if (kinds && !kinds.includes(e.kind)) continue;
  if (typeFilter && !new RegExp(typeFilter).test(e.typeId)) continue;
  const entry = model.appearance.byType.get(e.typeId);
  if (!entry) continue;
  // The realised collision box is the declared 100 % box times the size (quirk `collision-box-scales-with-entity`).
  const box = boxes.get(e.typeId);
  placedActors.push({ actor: { typeId: e.typeId, kind: e.kind, entry, at: placedPoint(e, model.dims, sizePct, 0), yawDeg: e.yaw, scale }, cull: entityRenderCullBlocks(box ? { width: box.width * scale, height: box.height * scale } : undefined) });
}

// Face atlases, decoded once.
const atlases = new Map<string, { w: number; h: number; rgba: Uint8Array }>();
for (const [path, png] of model.faceTextures ?? []) {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  atlases.set(path, { w: info.width, h: info.height, rgba: new Uint8Array(data) });
}

/** The actors' bounds at the size, from their drawn faces (the `--frame` filter narrows it). */
function boundsOf(filter?: string): { lo: Vec3; hi: Vec3 } {
  const own = placedActors.filter(p => !filter || new RegExp(filter).test(p.actor.typeId));
  if (!own.length) throw new Error(`no actor matching ${filter}`);
  const { faces } = lodFaces(own.map(p => p.actor), []);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) for (const c of f.corners) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, c[i]! / 16); hi[i] = Math.max(hi[i]!, c[i]! / 16); }
  return { lo, hi };
}

/** One picture from `eye` looking at `at`: the actors culled and LOD-switched from that eye, the device rules applied. */
function picture(eye: Vec3, at: Vec3): { rgb: Uint8Array; metrics: ReturnType<typeof rasterMetrics>; entities: SnapshotEntity[]; actors: number; faces: number } {
  const full: AuditActor[] = [], hull: AuditActor[] = [];
  const entities: SnapshotEntity[] = [];
  for (const p of placedActors) {
    const a = p.actor;
    const dist3d = Math.hypot(a.at.x - eye[0], a.at.y - eye[1], a.at.z - eye[2]), distHorizontal = Math.hypot(a.at.x - eye[0], a.at.z - eye[2]);
    const s = actorLodState(a.entry, p.cull, dist3d, distHorizontal, lod);
    entities.push({ typeId: a.typeId, id: a.typeId, dist3d, distHorizontal, cullBlocks: p.cull, ...s });
    if (s.state === 'gone') continue;
    (s.state === 'hull' ? hull : full).push(a);
  }
  const { actors, faces } = lodFaces(full, args.includes('--far') ? [...full, ...hull] : hull);
  // The rasteriser and the painting are the simulator's (web/src/sim/render/rasterizer.ts,
  // web/src/sim/adapters/craftmatic/snapshot.ts): this CLI only chooses the actors and the camera.
  const res = renderActorsDetailed(actors, faces, { eye, at, fovDeg: fov * 180 / Math.PI, width: W, height: H }, { uvFloor, hatch }, atlases);
  return { rgb: hatch ? paintHatch(res) : res.rgb, metrics: rasterMetrics(res), entities, actors: actors.length, faces: faces.length };
}

const stem = out.replace(/\.png$/i, '');
const writePng = async (path: string, rgb: Uint8Array): Promise<void> => { await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).png().toFile(path); };
/** A horizontal strip of pictures (each W x H), for one glance at a set. */
const writeStrip = async (path: string, pics: Uint8Array[]): Promise<void> => {
  const strip = new Uint8Array(W * pics.length * H * 3);
  pics.forEach((p, i) => { for (let y = 0; y < H; y++) strip.set(p.subarray(y * W * 3, (y + 1) * W * 3), (y * W * pics.length + i * W) * 3); });
  await sharp(Buffer.from(strip), { raw: { width: W * pics.length, height: H, channels: 3 } }).png().toFile(path);
};
const fmt = (m: ReturnType<typeof rasterMetrics>): string => `drawn ${m.drawnPixels} px, hatch ${m.hatchPixels} (${(100 * m.hatchShareOfImage).toFixed(2)} percent; near same-actor ${m.hatchNear.sameActor}, cross-actor ${m.hatchNear.crossActor}), dropped near ${m.droppedNearPixels} (${(100 * m.droppedNearShare).toFixed(2)} percent), translucent ${m.translucentPixels}`;
const report: Record<string, unknown> = { pack: file, sizePct, uvFloor, hatch, lod, image: [W, H], shots: [] as unknown[] };
const shots = report['shots'] as Array<Record<string, unknown>>;

if (views > 0) {
  // N views round the model at the --dir elevation, each far enough to frame the whole model.
  const { lo, hi } = boundsOf(flag('frame'));
  const at: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const r = Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  const d = vec(flag('dir'), [1, -0.6, 1.4]);
  const dist = r / Math.sin(fov / 2) * 1.1;
  const horizontal = Math.hypot(d[0], d[2]), elevation = Math.atan2(-d[1], horizontal);
  const pics: Uint8Array[] = [];
  for (let i = 0; i < views; i++) {
    const az = Math.atan2(d[2], d[0]) + i / views * 2 * Math.PI;
    const eye: Vec3 = [at[0] - Math.cos(az) * Math.cos(elevation) * dist, at[1] + Math.sin(elevation) * dist, at[2] - Math.sin(az) * Math.cos(elevation) * dist];
    const p = picture(eye, at);
    const path = `${stem}-v${i}.png`;
    await writePng(path, p.rgb);
    pics.push(p.rgb);
    shots.push({ view: i, file: path, eye: eye.map(v => Math.round(v * 100) / 100), metrics: p.metrics, actors: p.actors, faces: p.faces, entities: p.entities.filter(e => e.state !== 'full' || e.cullDisagree) });
    console.log(`view ${i}: ${path}: ${p.actors} actors, ${p.faces.toLocaleString()} faces; ${fmt(p.metrics)}`);
  }
  await writeStrip(out, pics);
  console.log(`${out}: strip of ${views} views`);
} else if (walk && walk.length >= 2) {
  // Looking back at the model from a..b blocks off its edge, standing on the ground, each actor full / hull / gone.
  const [a, b] = [walk[0]!, walk[1]!], stride = Math.max(1, walk[2] ?? 10);
  const { lo, hi } = boundsOf();
  const centre: Vec3 = [(lo[0] + hi[0]) / 2, lo[1] + 1.62, (lo[2] + hi[2]) / 2];
  const half = Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2;
  const pics: Uint8Array[] = [];
  const rows: string[] = ['| distance off the edge | full | hull | gone | cull 3-D/horizontal disagree | hatch px | nearest full actor root (3-D) | farthest drawn |', '|---|---|---|---|---|---|---|---|'];
  for (let dd = a; dd <= b + 1e-9; dd += stride) {
    const eye: Vec3 = [centre[0] - Math.SQRT1_2 * (half + dd), lo[1] + 1.62, centre[2] - Math.SQRT1_2 * (half + dd)];
    const p = picture(eye, [centre[0], lo[1] + 1.62, centre[2]]);
    const path = `${stem}-d${String(Math.round(dd)).padStart(3, '0')}.png`;
    await writePng(path, p.rgb);
    pics.push(p.rgb);
    const full = p.entities.filter(e => e.state === 'full'), hullN = p.entities.filter(e => e.state === 'hull'), gone = p.entities.filter(e => e.state === 'gone');
    const drawn = p.entities.filter(e => e.state !== 'gone');
    rows.push(`| ${dd} | ${full.length} | ${hullN.length} | ${gone.length} | ${p.entities.filter(e => e.cullDisagree).length} | ${p.metrics.hatchPixels} | ${full.length ? Math.min(...full.map(e => e.dist3d)).toFixed(1) : '-'} | ${drawn.length ? Math.max(...drawn.map(e => e.dist3d)).toFixed(1) : '-'} |`);
    shots.push({ distance: dd, file: path, eye: eye.map(v => Math.round(v * 100) / 100), metrics: p.metrics, entities: p.entities.map(e => ({ ...e, dist3d: Math.round(e.dist3d * 10) / 10, distHorizontal: Math.round(e.distHorizontal * 10) / 10 })) });
    console.log(`${dd} blocks off the edge: ${path}: full ${full.length} / hull ${hullN.length} / gone ${gone.length}; ${fmt(p.metrics)}`);
  }
  await writeStrip(out, pics);
  const hulls = new Map<string, { lodDistance: number; cullBlocks: number }>();
  for (const s of shots) for (const e of s['entities'] as SnapshotEntity[]) if (e.lodDistance !== undefined) hulls.set(e.typeId, { lodDistance: e.lodDistance, cullBlocks: e.cullBlocks });
  const never = [...hulls].filter(([, h]) => h.lodDistance >= h.cullBlocks);
  rows.push('', `${hulls.size} actor type(s) ship a hull at ${sizePct} percent${never.length ? `; ${never.length} switch AT or PAST their realised cull and are never drawn (lod-switch-under-cull): ${never.map(([t, h]) => `${t.replace(/^craftmatic:/, '')} switch ${h.lodDistance} >= cull ${h.cullBlocks.toFixed(1)}`).join(', ')}` : ' and every switch is under its cull'}.`);
  report['table'] = rows.join('\n');
  console.log(`\n${rows.join('\n')}\n${out}: strip of ${pics.length} distances`);
} else {
  // One picture.
  let eye = vec(flag('eye'), [-10, 20, -10]);
  let at = vec(flag('at'), [model.dims.width / 2 * scale, 0, model.dims.length / 2 * scale]);
  const frameType = flag('frame');
  if (frameType) {
    const { lo, hi } = boundsOf(frameType);
    at = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const r = Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const d = vec(flag('dir'), [1, -0.6, 1.4]);
    const l = Math.hypot(...d);
    const dist = r / Math.sin(fov / 2) * 1.1;
    eye = [at[0] - d[0] / l * dist, at[1] - d[1] / l * dist, at[2] - d[2] / l * dist];
  }
  const p = picture(eye, at);
  await writePng(out, p.rgb);
  shots.push({ file: out, eye, at, metrics: p.metrics, actors: p.actors, faces: p.faces, entities: p.entities.filter(e => e.state !== 'full' || e.cullDisagree) });
  console.log(`${out}: ${p.actors} actors, ${p.faces.toLocaleString()} faces; eye [${eye.map(v => v.toFixed(1))}] at [${at.map(v => v.toFixed(1))}]; ${fmt(p.metrics)}`);
}
writeFileSync(`${stem}.json`, JSON.stringify(report, null, 1));
