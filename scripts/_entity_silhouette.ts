/**
 * Silhouette gate for the Bedrock entity compiler.
 *
 * Renders the SOURCE model (every placed part's real triangles) and the
 * EMITTED cuboid approximation (the `.geo.json` the compiler produced, bone
 * rotations applied) from six canonical orthographic cameras — front, back,
 * left, right, top, isometric — in one shared frame, and reports the
 * silhouette intersection-over-union per view. No GPU: pure scan-line
 * rasterization into bitmaps.
 *
 * Usage: bun scripts/_entity_silhouette.ts <model.io|.mpd|.ldr>
 *          [--quality=balanced|high|ultra] [--mode=car|plane|boat] [--facing=…]
 *          [--label=…] [--px=<longest side in pixels, default 512>] [--out=<dir>]
 *
 * `--out` writes one PNG per view: white = both, red = source only (missing
 * from the entity), blue = approximation only (over-coverage).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type Vec3 } from '../web/src/engine/ldraw-part-geometry.ts';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.ts';
import { discoverPlayableComponents } from '../web/src/engine/playable-components.ts';
import { encodePngRgba } from '../web/src/engine/lego-resource-pack.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_entity_silhouette.ts <model> [--quality=…] [--mode=…] [--facing=…] [--label=…] [--px=512] [--out=dir]'); process.exit(2); }
const quality = (flag('quality') ?? 'balanced') as 'balanced' | 'high' | 'ultra';
const mode = (flag('mode') ?? 'auto') as 'auto' | 'car' | 'plane' | 'boat' | 'static';
const facing = (flag('facing') ?? 'auto') as 'auto' | '+x' | '-x' | '+z' | '-z';
const label = flag('label') ?? basename(file).replace(/\.[^.]+$/, '');
const PX = Number(flag('px') ?? 512);
const outDir = flag('out');

// ── Model ────────────────────────────────────────────────────────────────────
let text: string;
let customParts = new Map<string, string>();
if (/\.io$/i.test(file)) {
  const b = readFileSync(file);
  const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  text = io.text; customParts = io.customParts;
} else text = readFileSync(file, 'utf8');
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
seedDatTexts([...embeddedPartTexts(doc), ...customParts]);

const found = discoverPlayableComponents(doc.bricks, label, mode);
const component = found.components[0];
if (!component) { console.error(`no playable component found for "${label}" (${found.warnings.join('; ')})`); process.exit(1); }
const bricks: ParsedBrick[] = component.bricks;
const kind = component.kind;

// ── Compile (the real compiler) ──────────────────────────────────────────────
const provider = createPartGeometryProvider();
const compiled = await compileLdrawEntityGeometry('sil', kind, bricks, { partGeometry: provider, quality, facing: facing === 'auto' ? component.forwardDirection ?? 'auto' : facing });
const { A, origin, scale } = compiled.transform;

type Tri = [Vec3, Vec3, Vec3];
const apply = (m: number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
// A posed source is levelled by the compiler first (`transform.level`); replay that before A.
const level = compiled.transform.level;
const preLevel = (p: Vec3): Vec3 => {
  if (!level) return p;
  const c = level.centre, r = apply(level.rotation, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  return [r[0] + c[0], r[1] + c[1], r[2] + c[2]];
};
const toUnits = (p: Vec3): Vec3 => { const r = apply(A, preLevel(p)); return [(r[0] - origin[0]) * scale, (r[1] - origin[1]) * scale, (r[2] - origin[2]) * scale]; };

// Source triangles in render units (studs included — they are part of the silhouette).
const sourceTris: Tri[] = [];
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
for (const b of bricks) {
  const mesh = await provider.getPartMesh(b.part);
  if (!mesh) continue;
  const R = b.rot ?? IDENT, t: Vec3 = [b.x, b.y, b.z];
  const world = (v: Vec3): Vec3 => { const r = apply(R, v); return toUnits([r[0] + t[0], r[1] + t[1], r[2] + t[2]]); };
  for (const tr of mesh.triangles) sourceTris.push([world(tr.a), world(tr.b), world(tr.c)]);
  for (const s of mesh.studs) {
    // A stud as a 12-gon prism.
    const up = s.up; const ax: Vec3 = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u: Vec3 = [up[1] * ax[2] - up[2] * ax[1], up[2] * ax[0] - up[0] * ax[2], up[0] * ax[1] - up[1] * ax[0]];
    const un = Math.hypot(...u) || 1; const U: Vec3 = [u[0] / un, u[1] / un, u[2] / un];
    const V: Vec3 = [up[1] * U[2] - up[2] * U[1], up[2] * U[0] - up[0] * U[2], up[0] * U[1] - up[1] * U[0]];
    const ring = (h: number): Vec3[] => Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2; return [
      s.center[0] + (U[0] * Math.cos(a) + V[0] * Math.sin(a)) * s.radius + up[0] * h,
      s.center[1] + (U[1] * Math.cos(a) + V[1] * Math.sin(a)) * s.radius + up[1] * h,
      s.center[2] + (U[2] * Math.cos(a) + V[2] * Math.sin(a)) * s.radius + up[2] * h] as Vec3; });
    const lo = ring(0), hi = ring(s.height);
    for (let i = 0; i < 12; i++) {
      const j = (i + 1) % 12;
      sourceTris.push([world(lo[i]!), world(lo[j]!), world(hi[j]!)], [world(lo[i]!), world(hi[j]!), world(hi[i]!)]);
      sourceTris.push([world(hi[0]!), world(hi[i]!), world(hi[j]!)]);
    }
  }
}

// Emitted cuboids → triangles in render units: un-mirror X, apply bone rotation about its pivot.
type Bone = { name: string; pivot: number[]; rotation?: number[]; cubes: Array<{ origin: number[]; size: number[] }> };
const geo = compiled.value as { 'minecraft:geometry': Array<{ bones: Bone[] }> };
const approxTris: Tri[] = [];
const rot3 = (r: number[]): number[] => {
  // Render-frame Euler = (−jx, −jy, jz) in degrees, M = Rz·Ry·Rx.
  const d = Math.PI / 180, a = -r[0]! * d, b = -r[1]! * d, c = r[2]! * d;
  const rx = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
  const ry = [Math.cos(b), 0, Math.sin(b), 0, 1, 0, -Math.sin(b), 0, Math.cos(b)];
  const rz = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1];
  const mul = (p: number[], q: number[]): number[] => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => p[i * 3]! * q[j]! + p[i * 3 + 1]! * q[3 + j]! + p[i * 3 + 2]! * q[6 + j]!));
  return mul(mul(rz, ry), rx);
};
let cubeCount = 0;
for (const mesh of geo['minecraft:geometry']) for (const bone of mesh.bones) {
  const pivot: Vec3 = [-bone.pivot[0]!, bone.pivot[1]!, bone.pivot[2]!];
  const M = bone.rotation ? rot3(bone.rotation) : IDENT;
  for (const cube of bone.cubes) {
    cubeCount++;
    const [ox, oy, oz] = cube.origin as [number, number, number], [sx, sy, sz] = cube.size as [number, number, number];
    const min: Vec3 = [-(ox + sx), oy, oz], max: Vec3 = [-ox, oy + sy, oz + sz];
    const corner = (x: number, y: number, z: number): Vec3 => {
      const v: Vec3 = [x - pivot[0], y - pivot[1], z - pivot[2]];
      const r = apply(M, v);
      return [r[0] + pivot[0], r[1] + pivot[1], r[2] + pivot[2]];
    };
    const c = [
      corner(min[0], min[1], min[2]), corner(max[0], min[1], min[2]), corner(max[0], max[1], min[2]), corner(min[0], max[1], min[2]),
      corner(min[0], min[1], max[2]), corner(max[0], min[1], max[2]), corner(max[0], max[1], max[2]), corner(min[0], max[1], max[2]),
    ];
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]];
    for (const [a, b, cc, d] of faces) approxTris.push([c[a]!, c[b]!, c[cc]!], [c[a]!, c[cc]!, c[d]!]);
  }
}

// ── Views and rasterization ──────────────────────────────────────────────────
// Each view is a 3×3 matrix taking render units to (screen x, screen y, depth).
const S2 = Math.SQRT1_2;
const VIEWS: Record<string, number[]> = {
  front: [1, 0, 0, 0, 1, 0, 0, 0, 1],          // looking along −Z: x right, y up
  back: [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  left: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  right: [0, 0, -1, 0, 1, 0, 1, 0, 0],
  top: [1, 0, 0, 0, 0, 1, 0, -1, 0],
  iso: (() => { // yaw 45° then pitch 35.264°
    const yaw = [S2, 0, S2, 0, 1, 0, -S2, 0, S2];
    const p = Math.atan(Math.SQRT1_2), cp = Math.cos(p), sp = Math.sin(p);
    const pitch = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
    return [0, 1, 2].flatMap(i => [0, 1, 2].map(j => pitch[i * 3]! * yaw[j]! + pitch[i * 3 + 1]! * yaw[3 + j]! + pitch[i * 3 + 2]! * yaw[6 + j]!));
  })(),
};

const all = [...sourceTris, ...approxTris].flat();
let radius = 0;
const centre: Vec3 = [0, 0, 0];
{
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of all) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, v[i]!); max[i] = Math.max(max[i]!, v[i]!); }
  for (let i = 0; i < 3; i++) centre[i] = (min[i]! + max[i]!) / 2;
  radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
}
const pxPerUnit = (PX / 2) / radius;

function rasterize(tris: Tri[], view: number[]): Uint8Array {
  const bmp = new Uint8Array(PX * PX);
  const proj = (v: Vec3): [number, number] => {
    const c: Vec3 = [v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]];
    const p = apply(view, c);
    return [PX / 2 + p[0] * pxPerUnit, PX / 2 - p[1] * pxPerUnit];
  };
  for (const [a, b, c] of tris) {
    const [x0, y0] = proj(a), [x1, y1] = proj(b), [x2, y2] = proj(c);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(PX - 1, Math.ceil(Math.max(y0, y1, y2)));
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(PX - 1, Math.ceil(Math.max(x0, x1, x2)));
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) bmp[y * PX + x] = 1;
    }
  }
  return bmp;
}

const results: Record<string, { iou: number; sourcePx: number; approxPx: number; missing: number; extra: number }> = {};
if (outDir) mkdirSync(outDir, { recursive: true });
for (const [name, view] of Object.entries(VIEWS)) {
  const s = rasterize(sourceTris, view), a = rasterize(approxTris, view);
  let inter = 0, union = 0, sp = 0, ap = 0, missing = 0, extra = 0;
  for (let i = 0; i < s.length; i++) {
    const sv = s[i]!, av = a[i]!;
    sp += sv; ap += av;
    if (sv && av) inter++;
    if (sv || av) union++;
    if (sv && !av) missing++;
    if (!sv && av) extra++;
  }
  results[name] = { iou: union ? inter / union : 1, sourcePx: sp, approxPx: ap, missing, extra };
  if (outDir) {
    const rgba = new Uint8Array(PX * PX * 4);
    for (let i = 0; i < s.length; i++) {
      const sv = s[i]!, av = a[i]!;
      const [r, g, b] = sv && av ? [235, 235, 235] : sv ? [220, 50, 50] : av ? [60, 110, 230] : [20, 20, 24];
      rgba.set([r, g, b, 255], i * 4);
    }
    writeFileSync(`${outDir}/${name}.png`, encodePngRgba(PX, PX, rgba));
  }
}
const mean = Object.values(results).reduce((n, r) => n + r.iou, 0) / Object.keys(results).length;
console.log(JSON.stringify({
  file, label, kind, bricks: bricks.length, quality, cubeCount, sourceTriangles: sourceTris.length,
  diagnostics: { cubeCount: compiled.diagnostics.cubeCount, studs: compiled.diagnostics.studCubeCount, rotatedBones: compiled.diagnostics.rotatedBoneCount, aabbFallbacks: compiled.diagnostics.aabbFallbackParts.length, coarsened: compiled.diagnostics.modelCoarsened, microcellLdu: compiled.diagnostics.quality.microcellLdu },
  views: results, meanIoU: Math.round(mean * 10000) / 10000, px: PX, out: outDir ?? null,
}, null, 1));
