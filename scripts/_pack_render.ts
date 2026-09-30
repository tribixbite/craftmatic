/**
 * Render a built pack OFFLINE, from any viewpoint, to a PNG: every actor the
 * wand spawns at 100 % (shell, figures at their export spawn, doors, seats,
 * cars) drawn from the pack's own geometry, swatch colours and face atlases.
 * A z-buffered software rasteriser, so it runs in a script with no browser and
 * shows what the geometry IS (coplanar fights appear as the face drawn last;
 * run `_render_fault_audit.ts` for those).
 *
 * Frame: the preview's (`addon-preview.ts`): model blocks from the placement
 * corner, Y up; JSON X is not mirrored here, so the picture may be the mirror
 * image of the game's view. Good enough to judge shape, colour and faces.
 *
 * Usage: bun scripts/_pack_render.ts <pack.mcaddon> --out=<png>
 *          [--eye=x,y,z] [--at=x,y,z] [--fov=50] [--size=900x700] [--far]
 *          [--kinds=shell,figure,...] [--type=<substring of typeId>]
 *          [--frame=<substring of typeId>]   aim at that actor's bounds instead of --eye/--at
 *          [--dir=x,y,z]   view direction for --frame (default 1,-0.6,1.4)
 *          [--geo-from=<older.mcaddon>]   draw that pack's geometry under this pack's controllers
 *                                          (an older pack with the same ids higher in the world's stack)
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { buildAddonPreviewModel, readAddonPreviewFiles, placedPoint, entitySpawnsAt } from '../web/src/ui/addon-preview-data.ts';
import { worldFaces, type AuditActor, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';
import { renderActors } from '../web/src/sim/adapters/craftmatic/snapshot.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const vec = (s: string | undefined, d: Vec3): Vec3 => (s ? s.split(',').map(Number) as Vec3 : d);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_pack_render.ts <pack.mcaddon> --out=<png> [--eye=x,y,z --at=x,y,z | --frame=<type>]'); process.exit(2); }
const out = flag('out') ?? 'render.png';
const [W, H] = (flag('size') ?? '900x700').split('x').map(Number) as [number, number];
const fov = Number(flag('fov') ?? 50) * Math.PI / 180;
const kinds = flag('kinds')?.split(',');
const typeFilter = flag('type');

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
const actors: AuditActor[] = [];
for (const e of model.entities) {
  if (!entitySpawnsAt(e, 100)) continue;
  if (kinds && !kinds.includes(e.kind)) continue;
  if (typeFilter && !new RegExp(typeFilter).test(e.typeId)) continue;
  const entry = model.appearance.byType.get(e.typeId);
  if (entry) actors.push({ typeId: e.typeId, kind: e.kind, entry, at: placedPoint(e, model.dims, 100, 0), yawDeg: e.yaw });
}
const faces = worldFaces(actors, { far: args.includes('--far') });

// Face atlases, decoded once.
const atlases = new Map<string, { w: number; h: number; rgba: Uint8Array }>();
for (const [path, png] of model.faceTextures ?? []) {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  atlases.set(path, { w: info.width, h: info.height, rgba: new Uint8Array(data) });
}

// Camera.
let eye = vec(flag('eye'), [-10, 20, -10]);
let at = vec(flag('at'), [model.dims.width / 2, 0, model.dims.length / 2]);
const frameType = flag('frame');
if (frameType) {
  const own = faces.filter(f => new RegExp(frameType).test(actors[f.actor]!.typeId));
  if (!own.length) throw new Error(`no actor matching ${frameType}`);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of own) for (const c of f.corners) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, c[i]! / 16); hi[i] = Math.max(hi[i]!, c[i]! / 16); }
  at = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const r = Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  const d = vec(flag('dir'), [1, -0.6, 1.4]);
  const l = Math.hypot(...d);
  const dist = r / Math.sin(fov / 2) * 1.1;
  eye = [at[0] - d[0] / l * dist, at[1] - d[1] / l * dist, at[2] - d[2] / l * dist];
}
// The rasteriser and the painting are the simulator's (web/src/sim/render/rasterizer.ts,
// web/src/sim/adapters/craftmatic/snapshot.ts): this CLI only chooses the actors and the camera.
const rgb8 = renderActors(actors, faces, { eye, at, fovDeg: fov * 180 / Math.PI, width: W, height: H }, atlases);
await sharp(Buffer.from(rgb8), { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
console.log(`${out}: ${actors.length} actors, ${faces.length.toLocaleString()} faces; eye [${eye.map(v => v.toFixed(1))}] at [${at.map(v => v.toFixed(1))}]`);
