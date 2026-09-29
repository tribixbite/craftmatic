/**
 * See-through holes in a figure's drawn geometry, in every pose its
 * animations give it.
 *
 * A figure is compiled from cuboids on a rig of bones (minifig-rig.ts); the
 * pack animates those bones (walk: legs ±35°, arms ±28°; sit: legs -90°;
 * look: the head turns). A gap that is closed at rest can open in a pose, and
 * a gap in one part's compile shows in every pose. This module rasterises
 * the figure ORTHOGRAPHICALLY with back-face culling (as the device draws an
 * opaque entity) from 26 directions per pose and reports every group of
 * pixels that misses all cubes yet is enclosed by pixels that hit: something
 * the viewer sees the world through.
 *
 * Pure (no DOM): shared by `scripts/_figure_holes.ts` and the figure tests.
 */
import { apply, boneTransforms, mul, worldFaces, type Affine, type AuditActor, type GeoEntryLike, type Vec3 } from './bedrock-geometry-faces.js';
import type { LdrawPartMesh } from './ldraw-part-geometry.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { assembleMinifig } from './minifig-rig.js';
import { ldrawToRenderRotation } from './ldraw-entity-compiler.js';
import { resolveLdrawEntityMaterial } from './ldraw-entity-materials.js';
import { BEDROCK_UNITS_PER_LDU } from './lego-scale.js';
import { clampFigureQuality, compilePartPrototype, resolveEntityQuality, type CompiledPartPrototype } from './ldraw-part-prototype.js';

/** Animation bone overlays (JSON degrees), matching `craftmatic_minifig.animation.json`'s extremes. */
export const FIGURE_POSES = {
  rest: {},
  walkA: { leg_right: [35, 0, 0], leg_left: [-35, 0, 0], arm_right: [-28, 0, 0], arm_left: [28, 0, 0], legs: [0, 0, 5] },
  walkB: { leg_right: [-35, 0, 0], leg_left: [35, 0, 0], arm_right: [28, 0, 0], arm_left: [-28, 0, 0], legs: [0, 0, -5] },
  sit: { leg_right: [-90, 0, 0], leg_left: [-90, 0, 0], legs: [-90, 0, 0] },
  look: { head: [25, 60, 0] },
} as const satisfies Record<string, Record<string, readonly [number, number, number]>>;
export type FigurePoseName = keyof typeof FIGURE_POSES;

/** One enclosed see-through region, seen from one direction in one pose. */
export interface FigureHole {
  pose: FigurePoseName;
  /** View direction name, e.g. `+x`, `-y+z`, `+x-y-z` (the direction the viewer LOOKS along). */
  view: string;
  /** Area in model units² (1 unit = 1/16 block). */
  area: number;
  /** Centre of the hole in the posed JSON frame (model units), on the nearest drawn depth around it. */
  centre: [number, number, number];
  /** Bones of the drawn faces bordering the hole, sorted. */
  bones: string[];
  /**
   * With a `reference`: the part of `area` the source's own triangles cover
   * (a hole the COMPILE made). Without one it equals `area`.
   */
  unfaithfulArea: number;
}

/** The source's triangles on one bone, in the entry's JSON frame (model units, rest pose). */
export interface FigureReferenceSurface { bone: string; triangles: ReadonlyArray<readonly [Vec3, Vec3, Vec3]> }

export interface FigureHoleOptions {
  /** Pixel size in model units (default 0.1). */
  pixel?: number;
  /** Smallest hole reported, model units² (default 0.05). */
  minArea?: number;
  poses?: readonly FigurePoseName[];
  /**
   * The source mould's triangles per bone. When given, a hole counts only
   * where they cover it (`unfaithfulArea` >= `minArea`): a through-hole the
   * real parts have (a hand's clip, a minifig foot's open heel, the gap
   * between an arm and the body) is not a fault of the compile.
   */
  reference?: readonly FigureReferenceSurface[];
  /** Model of the device dropping zero-UV box faces (see `UvFloorModel`). */
  uvFloor?: UvFloorModel;
}

/** The 26 view directions: axes, edges and corners of a cube. */
export const VIEW_DIRECTIONS: ReadonlyArray<{ name: string; d: Vec3 }> = (() => {
  const out: Array<{ name: string; d: Vec3 }> = [];
  const axis = ['x', 'y', 'z'];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (!x && !y && !z) continue;
    const l = Math.hypot(x, y, z);
    const name = [x, y, z].map((v, i) => (v ? `${v > 0 ? '+' : '-'}${axis[i]}` : '')).join('');
    out.push({ name, d: [x / l, y / l, z / l] });
  }
  return out;
})();

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Total cubes an entry draws (near geometry only). */
export function drawnCubeCount(entry: GeoEntryLike): number {
  return entry.groups.filter(g => !g.far).reduce((s, g) => s + g.cubes.length, 0);
}

/**
 * Every enclosed see-through region of `entry` in each pose and view. The
 * entry is placed at the origin with yaw 0 (the frame does not change what
 * is enclosed).
 */
/** One orthographic, back-face-culled raster of a posed entry: per pixel the nearest face (or -1) and its depth. */
export interface FigureRaster {
  W: number; H: number; pixel: number;
  /** Image origin in view coordinates (u right, v up) and the view basis. */
  ou: number; ov: number; right: Vec3; up: Vec3; d: Vec3;
  faces: ReturnType<typeof worldFaces>;
  owner: Int32Array; depth: Float32Array;
  /** 1 where a missed pixel is connected to the image border (the world around the figure). */
  outside: Uint8Array;
}

/** Posed, opaque drawn faces of `entry` (placed at the origin, yaw 0). */
export function posedFaces(entry: GeoEntryLike, pose: FigurePoseName, uvFloor: UvFloorModel = 'none'): ReturnType<typeof worldFaces> {
  const overlay = new Map(Object.entries(FIGURE_POSES[pose]) as Array<[string, readonly [number, number, number]]>);
  const actor: AuditActor = { typeId: 'figure', kind: 'figure', entry: entry as AuditActor['entry'], at: { x: 0, y: 0, z: 0 }, yawDeg: 0, overlay };
  // Only opaque faces hide the world; a translucent part is seen through by design.
  return worldFaces([actor]).filter(f => (entry.groups[f.group]!.alpha ?? 1) >= 1 && boxUvFaceDrawn(entry.groups[f.group]!.cubes[f.cube]!, f.face, uvFloor));
}

/**
 * How a device might treat a box-UV face whose UV rectangle floors to zero.
 * Bedrock floors a box-UV cube's size before laying out its UV (Bedrock
 * wiki, "Texture Glitch": a size under 1 gives a 0-pixel-wide UV map, "glitched
 * or invisible"). `none`: every face is drawn; `either`: a face is dropped when
 * EITHER of its UV sides floors to 0; `both`: only when both do.
 */
export type UvFloorModel = 'none' | 'either' | 'both' | 'u' | 'v';

/** The two cube-size axes a face's box-UV rectangle is measured on. */
const FACE_UV_AXES: Record<string, [number, number]> = { north: [0, 1], south: [0, 1], east: [2, 1], west: [2, 1], up: [0, 2], down: [0, 2] };

/** Whether `face` of a cube is drawn under `model` (a per-face-UV decal always is). */
export function boxUvFaceDrawn(cube: { size: Vec3; uvSize?: Vec3; faceUv?: unknown }, face: string, model: UvFloorModel): boolean {
  if (model === 'none' || cube.faceUv) return true;
  const [a, b] = FACE_UV_AXES[face]!;
  // Bedrock floors the DECLARED size (an inflated cube declares more than it draws).
  const declared = cube.uvSize ?? cube.size;
  const za = Math.floor(Math.abs(declared[a]!) + 1e-6) === 0, zb = Math.floor(Math.abs(declared[b]!) + 1e-6) === 0;
  return model === 'either' ? !(za || zb) : model === 'both' ? !(za && zb) : model === 'u' ? !za : !zb;
}

/** Rasterise `faces` looking along unit `d`. */
export function rasterFaces(faces: ReturnType<typeof worldFaces>, d: Vec3, pixel: number): FigureRaster {
  const right = norm(cross(Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], d));
  const up = cross(d, right);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const f of faces) for (const c of f.corners) {
    const u = dot(c, right), v = dot(c, up);
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const W = Math.ceil((u1 - u0) / pixel) + 4, H = Math.ceil((v1 - v0) / pixel) + 4;
  const ou = u0 - 2 * pixel, ov = v0 - 2 * pixel;
  const depth = new Float32Array(W * H).fill(Infinity);
  const owner = new Int32Array(W * H).fill(-1);
  faces.forEach((f, fi) => {
    // Back-face culling: the device skips a face whose outward normal points away from the viewer.
    if (dot(f.normal, d) >= -1e-9) return;
    const p = f.corners.map(c => [(dot(c, right) - ou) / pixel, (dot(c, up) - ov) / pixel, dot(c, d)] as Vec3);
    for (const [a, b, c] of [[p[0]!, p[1]!, p[2]!], [p[0]!, p[2]!, p[3]!]] as Array<[Vec3, Vec3, Vec3]>) {
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const k = y * W + x;
        if (z < depth[k]!) { depth[k] = z; owner[k] = fi; }
      }
    }
  });
  // Flood the missed pixels from the border; what is left is enclosed.
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  const seed = (k: number): void => { if (owner[k] === -1 && !outside[k]) { outside[k] = 1; stack.push(k); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % W, y = (k - x) / W;
    if (x > 0) seed(k - 1); if (x < W - 1) seed(k + 1); if (y > 0) seed(k - W); if (y < H - 1) seed(k + W);
  }
  return { W, H, pixel, ou, ov, right, up, d, faces, owner, depth, outside };
}

/**
 * Every enclosed see-through region of `entry` in each pose and view. The
 * entry is placed at the origin with yaw 0 (the frame does not change what
 * is enclosed).
 */
export function figureHoles(entry: GeoEntryLike, options: FigureHoleOptions = {}): { cubes: number; holes: FigureHole[] } {
  const pixel = options.pixel ?? 0.1;
  const minPixels = Math.max(1, Math.ceil((options.minArea ?? 0.05) / (pixel * pixel)));
  const holes: FigureHole[] = [];
  const boneOfFace = (group: number, cube: number): string => entry.groups[group]!.cubes[cube]!.bone;
  for (const pose of options.poses ?? (Object.keys(FIGURE_POSES) as FigurePoseName[])) {
    const faces = posedFaces(entry, pose, options.uvFloor);
    if (!faces.length) continue;
    const refTris = options.reference ? posedReference(entry, options.reference, pose) : null;
    for (const view of VIEW_DIRECTIONS) {
      const { W, H, ou, ov, right, up, d, owner, depth, outside } = rasterFaces(faces, view.d, pixel);
      // The source's coverage on the same grid, eroded by one pixel so its rim is not a hole.
      const refHit = refTris ? coverage(refTris, { right, up, ou, ov, W, H, pixel }) : null;
      const refInner = (k: number): boolean => {
        if (!refHit) return true;
        if (!refHit[k]) return false;
        const x = k % W, y = (k - x) / W;
        return x > 0 && x < W - 1 && y > 0 && y < H - 1 && !!refHit[k - 1] && !!refHit[k + 1] && !!refHit[k - W] && !!refHit[k + W];
      };
      const seen = new Uint8Array(W * H);
      for (let k0 = 0; k0 < W * H; k0++) {
        if (owner[k0] !== -1 || outside[k0] || seen[k0]) continue;
        const comp: number[] = [k0];
        seen[k0] = 1;
        const bones = new Set<string>();
        let depthSum = 0, depthN = 0;
        for (let i = 0; i < comp.length; i++) {
          const k = comp[i]!;
          const x = k % W, y = (k - x) / W;
          for (const n of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, y > 0 ? k - W : -1, y < H - 1 ? k + W : -1]) {
            if (n < 0) continue;
            if (owner[n] === -1) { if (!seen[n]) { seen[n] = 1; comp.push(n); } continue; }
            const f = faces[owner[n]!]!;
            bones.add(boneOfFace(f.group, f.cube));
            depthSum += depth[n]!; depthN++;
          }
        }
        const covered = refHit ? comp.filter(refInner) : comp;
        if (covered.length < minPixels) continue;
        let cx = 0, cy = 0;
        for (const k of covered) { cx += k % W; cy += Math.floor(k / W); }
        cx = cx / covered.length + 0.5; cy = cy / covered.length + 0.5;
        const u = ou + cx * pixel, v = ov + cy * pixel, w = depthN ? depthSum / depthN : 0;
        const centre: [number, number, number] = [0, 1, 2].map(i => right[i]! * u + up[i]! * v + d[i]! * w) as [number, number, number];
        holes.push({ pose, view: view.name, area: comp.length * pixel * pixel, unfaithfulArea: covered.length * pixel * pixel, centre, bones: [...bones].sort() });
      }
    }
  }
  return { cubes: drawnCubeCount(entry), holes };
}

/**
 * Visible surface the DEVICE does not draw: over the views and poses, the
 * area (model units², summed over views) of pixels whose nearest face exists
 * in the geometry but is dropped under `model` (`boxUvFaceDrawn`). Where such
 * a face is lost the viewer sees whatever lies behind it: the figure's own
 * inside (a white torso through its print) or the world (a slit in the hair).
 * Also returns the share of the figure's drawn silhouette that is lost.
 */
export function droppedVisibleArea(entry: GeoEntryLike, model: UvFloorModel, options: { pixel?: number; poses?: readonly FigurePoseName[]; views?: readonly string[] } = {}): { area: number; share: number } {
  const pixel = options.pixel ?? 0.1;
  let lost = 0, drawn = 0;
  for (const pose of options.poses ?? ['rest'] as FigurePoseName[]) {
    const faces = posedFaces(entry, pose);
    for (const view of VIEW_DIRECTIONS.filter(v => !options.views || options.views.includes(v.name))) {
      const r = rasterFaces(faces, view.d, pixel);
      for (let k = 0; k < r.W * r.H; k++) {
        const f = r.owner[k]!;
        if (f < 0) continue;
        drawn++;
        const face = r.faces[f]!;
        if (!boxUvFaceDrawn(entry.groups[face.group]!.cubes[face.cube]!, face.face, model)) lost++;
      }
    }
  }
  return { area: lost * pixel * pixel, share: drawn ? lost / drawn : 0 };
}

/**
 * `reference` posed as `posedFaces` poses the entry: each bone's chain (with
 * the pose's overlay) then the game's Z mirror, the same frame `worldFaces`
 * draws in.
 */
export function posedReference(entry: GeoEntryLike, reference: readonly FigureReferenceSurface[], pose: FigurePoseName): Array<[Vec3, Vec3, Vec3]> {
  const overlay = new Map(Object.entries(FIGURE_POSES[pose]) as Array<[string, readonly [number, number, number]]>);
  const bones = boneTransforms(entry.bones, overlay);
  const mirrorZ: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0];
  const out: Array<[Vec3, Vec3, Vec3]> = [];
  for (const r of reference) {
    const m = mul(mirrorZ, bones.get(r.bone) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    for (const t of r.triangles) out.push([apply(m, t[0]), apply(m, t[1]), apply(m, t[2])]);
  }
  return out;
}

/**
 * The source's triangles of a figure, per rig bone, in the JSON frame of the
 * entity `compileLdrawEntityGeometry(..., 'figure', bricks)` emits: the same
 * assembly (`assembleMinifig`), the figure frame (`ldrawToRenderRotation('-z')`),
 * the compile's origin (`originLdu`, levelled frame) and unit scale, and the
 * JSON's X mirror. A rotated part's triangles are baked through its rotation,
 * so they ride its RIG bone (the parent of its `r<i>` bone), which is exactly
 * how its cuboids are drawn. Requires an upright figure (`levelPose` null).
 */
export function figureReferenceSurfaces(
  bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>,
  compiled: { originLdu: Vec3; levelPose: unknown },
  scale = BEDROCK_UNITS_PER_LDU,
): FigureReferenceSurface[] {
  if (compiled.levelPose) throw new Error('figureReferenceSurfaces: the compile levelled the figure; the reference would be in another frame');
  const figure = assembleMinifig(bricks, meshes);
  const A = ldrawToRenderRotation('-z');
  const rot = (m: readonly number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
  const o = rot(A, compiled.originLdu);
  const byBone = new Map<string, Array<[Vec3, Vec3, Vec3]>>();
  figure.bricks.forEach((b, i) => {
    const mesh = meshes.get(b.part);
    if (!mesh || resolveLdrawEntityMaterial(b.color).alpha < 1) return;
    const R = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const toJson = (v: Vec3): Vec3 => {
      const w = rot(R, v);
      const r = rot(A, [w[0] + b.x, w[1] + b.y, w[2] + b.z]);
      return [-(r[0] - o[0]) * scale, (r[1] - o[1]) * scale, (r[2] - o[2]) * scale];
    };
    const bone = figure.rig.boneOf[i] ?? 'body';
    const list = byBone.get(bone) ?? [];
    for (const t of mesh.triangles) list.push([toJson(t.a), toJson(t.b), toJson(t.c)]);
    byBone.set(bone, list);
  });
  return [...byBone].map(([bone, triangles]) => ({ bone, triangles }));
}

/**
 * How well `reference` lies on the drawn entry at rest: silhouette IoU along
 * the six axes. A frame or origin slip shows as an IoU well under ~0.85
 * (the voxel compile's own rounding costs a few percent).
 */
export function referenceAgreement(entry: GeoEntryLike, reference: readonly FigureReferenceSurface[], pixel = 0.1): number[] {
  const faces = posedFaces(entry, 'rest');
  const ref = posedReference(entry, reference, 'rest');
  return VIEW_DIRECTIONS.filter(v => v.name.length === 2).map(view => {
    const r = rasterFaces(faces, view.d, pixel);
    const hit = coverage(ref, { right: r.right, up: r.up, ou: r.ou, ov: r.ov, W: r.W, H: r.H, pixel });
    let inter = 0, union = 0;
    for (let k = 0; k < r.W * r.H; k++) { const a = r.owner[k]! >= 0 || !r.outside[k], b = !!hit[k]; if (a && b) inter++; if (a || b) union++; }
    return union ? inter / union : 0;
  });
}

/** Rest-pose silhouettes along `viewName`: both grey, drawn only red, reference only green. For checking the frame. */
export function referenceOverlay(entry: GeoEntryLike, reference: readonly FigureReferenceSurface[], viewName: string, pixel = 0.1): { rgb: Uint8Array; W: number; H: number } {
  const view = VIEW_DIRECTIONS.find(v => v.name === viewName)!;
  const r = rasterFaces(posedFaces(entry, 'rest'), view.d, pixel);
  const hit = coverage(posedReference(entry, reference, 'rest'), { right: r.right, up: r.up, ou: r.ou, ov: r.ov, W: r.W, H: r.H, pixel });
  const rgb = new Uint8Array(r.W * r.H * 3);
  for (let y = 0; y < r.H; y++) for (let x = 0; x < r.W; x++) {
    const k = y * r.W + x, o = ((r.H - 1 - y) * r.W + x) * 3;
    const a = r.owner[k]! >= 0, b = !!hit[k];
    const c = a && b ? [150, 150, 150] : a ? [220, 40, 40] : b ? [40, 200, 60] : [20, 20, 28];
    rgb[o] = c[0]!; rgb[o + 1] = c[1]!; rgb[o + 2] = c[2]!;
  }
  return { rgb, W: r.W, H: r.H };
}

// ─── Part level: holes a prototype compile punches through its mould ─────────

/**
 * The prototype a figure entity compiles for `mesh` (figure grain, the same
 * decomposition), optionally surface-preserving. Mirrors the compiler's own
 * choice so a probe or a test measures exactly what ships.
 */
export function figurePartPrototype(mesh: LdrawPartMesh, preserveSurface: boolean): CompiledPartPrototype {
  const quality = clampFigureQuality(resolveEntityQuality('balanced'));
  return compilePartPrototype(mesh, quality, { hollow: false, preserveSurface, decomposition: quality.microcellLdu <= 2 ? 'best-of' : 'greedy' });
}

/** A see-through hole the compile made in one part, seen along one view. */
export interface PartCompileHole { view: string; area: number; centre: [number, number, number] }

/** Coverage mask of triangles (both sides) projected along `d` onto a shared grid. */
function coverage(tris: ReadonlyArray<readonly [Vec3, Vec3, Vec3]>, grid: { right: Vec3; up: Vec3; ou: number; ov: number; W: number; H: number; pixel: number }): Uint8Array {
  const { right, up, ou, ov, W, H, pixel } = grid;
  const hit = new Uint8Array(W * H);
  for (const t of tris) {
    const p = t.map(c => [(dot(c, right) - ou) / pixel, (dot(c, up) - ov) / pixel]) as Array<[number, number]>;
    const [a, b, c] = p as [[number, number], [number, number], [number, number]];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
      hit[y * W + x] = 1;
    }
  }
  return hit;
}

/** The 12 triangles of an axis-aligned box. */
export function boxTriangles(min: Vec3, max: Vec3): Array<[Vec3, Vec3, Vec3]> {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, cc, d]) => [[c(a!), c(b!), c(cc!)], [c(a!), c(cc!), c(d!)]] as Array<[Vec3, Vec3, Vec3]>);
}

/**
 * Enclosed see-through regions of a part's cuboids that its own triangles
 * cover, from the 26 view directions, in the part's LDU frame. Pixels on the
 * mould's own silhouette rim (one pixel) are ignored, so rounding at the edge
 * is not a hole.
 */
export function partCompileHoles(mesh: LdrawPartMesh, cuboids: ReadonlyArray<{ min: Vec3; max: Vec3 }>, options: { pixel?: number; minArea?: number } = {}): { holes: PartCompileHole[] } {
  const pixel = options.pixel ?? 0.5;
  const minPixels = Math.max(1, Math.ceil((options.minArea ?? 2) / (pixel * pixel)));
  const meshTris = mesh.triangles.map(t => [t.a, t.b, t.c] as [Vec3, Vec3, Vec3]);
  const cubeTris = cuboids.flatMap(c => boxTriangles(c.min, c.max));
  const holes: PartCompileHole[] = [];
  if (!cubeTris.length) return { holes };
  const all = [...meshTris, ...cubeTris];
  for (const view of VIEW_DIRECTIONS) {
    const d = view.d;
    const right = norm(cross(Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], d));
    const up = cross(d, right);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const t of all) for (const c of t) {
      const u = dot(c, right), v = dot(c, up);
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const W = Math.ceil((u1 - u0) / pixel) + 4, H = Math.ceil((v1 - v0) / pixel) + 4;
    const grid = { right, up, ou: u0 - 2 * pixel, ov: v0 - 2 * pixel, W, H, pixel };
    const meshHit = coverage(meshTris, grid), cubeHit = coverage(cubeTris, grid);
    // Flood the cube misses from the border.
    const outside = new Uint8Array(W * H);
    const stack: number[] = [];
    const seed = (k: number): void => { if (!cubeHit[k] && !outside[k]) { outside[k] = 1; stack.push(k); } };
    for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % W, y = (k - x) / W;
      if (x > 0) seed(k - 1); if (x < W - 1) seed(k + 1); if (y > 0) seed(k - W); if (y < H - 1) seed(k + W);
    }
    // Interior of the mould's coverage: covered, and every 4-neighbour covered.
    const inner = (k: number): boolean => {
      if (!meshHit[k]) return false;
      const x = k % W, y = (k - x) / W;
      return x > 0 && x < W - 1 && y > 0 && y < H - 1 && !!meshHit[k - 1] && !!meshHit[k + 1] && !!meshHit[k - W] && !!meshHit[k + W];
    };
    const seen = new Uint8Array(W * H);
    for (let k0 = 0; k0 < W * H; k0++) {
      if (cubeHit[k0] || outside[k0] || seen[k0]) continue;
      const comp: number[] = [k0];
      seen[k0] = 1;
      for (let i = 0; i < comp.length; i++) {
        const k = comp[i]!, x = k % W, y = (k - x) / W;
        for (const n of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, y > 0 ? k - W : -1, y < H - 1 ? k + W : -1]) {
          if (n >= 0 && !cubeHit[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
        }
      }
      const covered = comp.filter(inner);
      if (covered.length < minPixels) continue;
      let cx = 0, cy = 0;
      for (const k of covered) { cx += k % W; cy += Math.floor(k / W); }
      const u = grid.ou + (cx / covered.length + 0.5) * pixel, v = grid.ov + (cy / covered.length + 0.5) * pixel;
      holes.push({ view: view.name, area: covered.length * pixel * pixel, centre: [0, 1, 2].map(i => right[i]! * u + up[i]! * v) as [number, number, number] });
    }
  }
  return { holes };
}

/**
 * A compiled entity (`compileLdrawEntityGeometry`'s `value` + `meshes`) as the
 * drawn entry a built pack's reader produces: one group per emitted geometry,
 * its bones merged. Lets a host test measure the compile's own output.
 */
export function entryFromCompiled(compiled: { value: unknown; meshes: ReadonlyArray<{ material: { colorId: number; alpha: number }; faceAtlas?: unknown }> }): GeoEntryLike {
  type JsonCube = { origin: Vec3; size: Vec3; rotation?: Vec3; pivot?: Vec3; uv?: unknown; inflate?: number };
  type JsonBone = { name: string; pivot: Vec3; rotation?: Vec3; parent?: string; cubes?: JsonCube[] };
  const geos = (compiled.value as { 'minecraft:geometry': Array<{ bones: JsonBone[] }> })['minecraft:geometry'];
  const bones = new Map<string, GeoEntryLike['bones'][number]>();
  const groups: GeoEntryLike['groups'] = geos.map((g, i) => {
    const m = compiled.meshes[i]!;
    const cubes: GeoEntryLike['groups'][number]['cubes'] = [];
    for (const b of g.bones) {
      if (!bones.has(b.name)) bones.set(b.name, { name: b.name, pivot: b.pivot, ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) });
      for (const c of b.cubes ?? []) {
        const faceKey = c.uv && typeof c.uv === 'object' && !Array.isArray(c.uv) ? Object.keys(c.uv)[0] as 'north' : undefined;
        // The drawn box, as the pack reader (addon-appearance.ts) gives it; the declared size is what the UV floors.
        const k = c.inflate ?? 0;
        const origin: Vec3 = k ? [c.origin[0] - k, c.origin[1] - k, c.origin[2] - k] : c.origin;
        const size: Vec3 = k ? [c.size[0] + 2 * k, c.size[1] + 2 * k, c.size[2] + 2 * k] : c.size;
        cubes.push({ bone: b.name, origin, size, ...(k ? { uvSize: c.size } : {}), ...(c.rotation && c.pivot ? { rotation: c.rotation, pivot: c.pivot } : {}), ...(faceKey ? { faceUv: { face: faceKey, uv: [0, 0], size: [1, 1] } } : {}) });
      }
    }
    return { ldrawColor: m.faceAtlas ? null : m.material.colorId, alpha: m.material.alpha, cubes, ...(m.faceAtlas ? { texture: { path: 'faces' } } : {}) };
  });
  return { groups, bones: [...bones.values()] };
}

/**
 * One posed view drawn flat-shaded for a person to read: each face its
 * group's colour (`colourOf`) under a fixed light, the enclosed holes
 * magenta, the world grey. Rows run top-down. Optionally only some bones.
 */
export function holeShot(
  entry: GeoEntryLike, pose: FigurePoseName, viewName: string, pixel: number,
  colourOf: (group: GeoEntryLike['groups'][number]) => readonly [number, number, number],
  onlyBones?: (bone: string) => boolean,
  uvFloor: UvFloorModel = 'none',
): { rgb: Uint8Array; W: number; H: number } {
  const view = VIEW_DIRECTIONS.find(v => v.name === viewName);
  if (!view) throw new Error(`no view ${viewName}; one of ${VIEW_DIRECTIONS.map(v => v.name).join(' ')}`);
  let faces = posedFaces(entry, pose, uvFloor);
  if (onlyBones) faces = faces.filter(f => onlyBones(entry.groups[f.group]!.cubes[f.cube]!.bone));
  const r = rasterFaces(faces, view.d, pixel);
  const rgb = new Uint8Array(r.W * r.H * 3);
  const light: Vec3 = norm([0.35, 0.8, 0.45]);
  for (let y = 0; y < r.H; y++) for (let x = 0; x < r.W; x++) {
    const k = y * r.W + x, o = ((r.H - 1 - y) * r.W + x) * 3;
    const f = r.owner[k]!;
    if (f < 0) { const c = r.outside[k] ? [70, 70, 78] : [255, 0, 255]; rgb[o] = c[0]!; rgb[o + 1] = c[1]!; rgb[o + 2] = c[2]!; continue; }
    const face = r.faces[f]!;
    const base = colourOf(entry.groups[face.group]!);
    const shade = 0.45 + 0.55 * Math.abs(dot(face.normal, light));
    for (let i = 0; i < 3; i++) rgb[o + i] = Math.min(255, Math.round(base[i]! * shade));
  }
  return { rgb, W: r.W, H: r.H };
}
