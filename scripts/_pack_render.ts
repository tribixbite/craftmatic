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
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { loadAddonPreviewModel, placedPoint, entitySpawnsAt } from '../web/src/ui/addon-preview-data.ts';
import { worldFaces, type AuditActor, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.ts';

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
const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
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
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dotp = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fwd = nrm(sub(at, eye));
const right = nrm(cross(fwd, [0, 1, 0]));
const up = cross(right, fwd);
const f = 1 / Math.tan(fov / 2), aspect = W / H, near = 0.05;

const colour = new Float32Array(W * H * 3).fill(0);
for (let i = 0; i < W * H; i++) { const t = Math.floor(i / W) / H; colour[i * 3] = 0.55 + 0.25 * t; colour[i * 3 + 1] = 0.7 + 0.15 * t; colour[i * 3 + 2] = 0.9; }
const depth = new Float32Array(W * H).fill(Infinity);
const light = nrm([0.4, 1, 0.25]);

type Tri = { p: Array<[number, number, number]>; uv?: Array<[number, number]>; rgb: Vec3; alpha: number; tex?: { w: number; h: number; rgba: Uint8Array } };
const project = (v: Vec3): [number, number, number] | null => {
  const r = sub(v, eye);
  const z = dotp(r, fwd);
  if (z < near) return null;
  return [W / 2 + (dotp(r, right) * f / aspect / z) * W / 2, H / 2 - (dotp(r, up) * f / z) * H / 2, z];
};

function raster(t: Tri): void {
  const [a, b, c] = t.p as [[number, number, number], [number, number, number], [number, number, number]];
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
    const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    // Perspective-correct: interpolate 1/z.
    const iz = w0 / a[2] + w1 / b[2] + w2 / c[2];
    const z = 1 / iz;
    const k = y * W + x;
    if (z >= depth[k]!) continue;
    let rgb = t.rgb, alpha = t.alpha;
    if (t.tex && t.uv) {
      const u = (w0 * t.uv[0]![0] / a[2] + w1 * t.uv[1]![0] / b[2] + w2 * t.uv[2]![0] / c[2]) * z;
      const v = (w0 * t.uv[0]![1] / a[2] + w1 * t.uv[1]![1] / b[2] + w2 * t.uv[2]![1] / c[2]) * z;
      const tx = Math.min(t.tex.w - 1, Math.max(0, Math.floor(u))), ty = Math.min(t.tex.h - 1, Math.max(0, Math.floor(v)));
      const o = (ty * t.tex.w + tx) * 4;
      if (t.tex.rgba[o + 3]! < 128) continue;
      rgb = [t.tex.rgba[o]! / 255 * t.rgb[0], t.tex.rgba[o + 1]! / 255 * t.rgb[1], t.tex.rgba[o + 2]! / 255 * t.rgb[2]];
    }
    if (alpha >= 1) {
      depth[k] = z;
      colour[k * 3] = rgb[0]; colour[k * 3 + 1] = rgb[1]; colour[k * 3 + 2] = rgb[2];
    } else {
      colour[k * 3] = colour[k * 3]! * (1 - alpha) + rgb[0] * alpha;
      colour[k * 3 + 1] = colour[k * 3 + 1]! * (1 - alpha) + rgb[1] * alpha;
      colour[k * 3 + 2] = colour[k * 3 + 2]! * (1 - alpha) + rgb[2] * alpha;
    }
  }
}

/** Near-plane clip is skipped: a face crossing the camera is dropped (the camera sits outside the model). */
const tris: Array<Tri & { order: number }> = [];
for (const face of faces) {
  const g = actors[face.actor]!.entry.groups[face.group]!;
  const toEye = sub(eye, [face.corners[0][0] / 16, face.corners[0][1] / 16, face.corners[0][2] / 16]);
  if (dotp(face.normal, toEye) <= 0) continue; // back face
  const ps = face.corners.map(c => project([c[0] / 16, c[1] / 16, c[2] / 16]));
  if (ps.some(p => !p)) continue;
  const shade = 0.6 + 0.4 * Math.max(0, dotp(face.normal, light)) + 0.1 * face.normal[0];
  let rgb: Vec3, alpha = 1;
  let tex: Tri['tex'];
  if (g.texture) { tex = atlases.get(g.texture.path); rgb = [shade, shade, shade]; }
  else {
    const m = g.ldrawColor !== null ? resolveLdrawEntityMaterial(g.ldrawColor) : { rgb: [176, 184, 196], alpha: 1 };
    rgb = [m.rgb[0] / 255 * shade, m.rgb[1] / 255 * shade, m.rgb[2] / 255 * shade]; alpha = m.alpha;
  }
  const P = ps as Array<[number, number, number]>;
  const order = alpha < 1 ? 1 : 0;
  tris.push({ p: [P[0]!, P[1]!, P[2]!], ...(face.uv ? { uv: [face.uv[0], face.uv[1], face.uv[2]] } : {}), rgb, alpha, ...(tex ? { tex } : {}), order });
  tris.push({ p: [P[0]!, P[2]!, P[3]!], ...(face.uv ? { uv: [face.uv[0], face.uv[2], face.uv[3]] } : {}), rgb, alpha, ...(tex ? { tex } : {}), order });
}
// Opaque first; translucent after, far to near.
const opaque = tris.filter(t => t.order === 0), clear = tris.filter(t => t.order === 1);
for (const t of opaque) raster(t);
clear.sort((a, b) => Math.max(b.p[0]![2], b.p[1]![2], b.p[2]![2]) - Math.max(a.p[0]![2], a.p[1]![2], a.p[2]![2]));
for (const t of clear) raster(t);

const rgb8 = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H * 3; i++) rgb8[i] = Math.max(0, Math.min(255, Math.round(colour[i]! * 255)));
await sharp(Buffer.from(rgb8), { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
console.log(`${out}: ${actors.length} actors, ${faces.length.toLocaleString()} faces; eye [${eye.map(v => v.toFixed(1))}] at [${at.map(v => v.toFixed(1))}]`);
