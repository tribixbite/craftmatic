/**
 * Offline render-fault audit of a BUILT pack: what the device will draw badly,
 * measured from the pack's own geometry instead of found on a phone.
 *
 * Fault classes, each a number that a gate can hold:
 *
 *   coplanar   Two drawn faces with the same outward normal, on the same plane
 *              (within `planeEps` model units), overlapping by a positive area,
 *              in DIFFERENT colours. The depth test cannot order them, so the
 *              winner flips per pixel and per frame: the diagonal hatching and
 *              "strobing" a user reports. Same-colour overlaps draw identically
 *              and are counted apart (`sameColour`), not as faults.
 *   thin       A cube with an extent at or below `thinUnits` on some axis: its
 *              two opposite faces are coplanar with each other and the part
 *              tears at every silhouette.
 *
 * Every measurement is taken in ONE frame for every actor drawn together: the
 * geometry JSON's own coordinates (model units), each actor translated to its
 * placement (model blocks from the placement corner, x16) and turned by its
 * yaw, the bone chain composed about each pivot (`pivotRotation`, the ONE
 * implementation of Bedrock's rotation convention here, shared by the preview
 * and the LOD hull), a cube's own rotation about its own pivot first. Only the NEAR geometry of each controller is drawn (the LOD
 * hull's `<=` controllers draw only past their switch distance, see
 * `AppearanceGroup.far`), which is exactly what the player sees up close.
 *
 * Pure: no DOM, no Three.js; runs in vitest, scripts, the preview and the compiler.
 */
/** A bone as a geometry declares it (model units, degrees). Structurally the preview's `AppearanceBone`. */
export interface GeoBoneLike {
  name: string;
  pivot: [number, number, number];
  rotation?: [number, number, number];
  parent?: string;
}

/** A cube as a geometry declares it. Structurally the preview's `AppearanceCube`. */
export interface GeoCubeLike {
  bone: string;
  origin: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  pivot?: [number, number, number];
  faceUv?: { face: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'; uv: [number, number]; size: [number, number] };
}

/** One colour's cubes (one swatch, or a face atlas). Structurally the preview's `AppearanceGroup`. */
export interface GeoGroupLike {
  ldrawColor: number | null;
  alpha: number;
  cubes: GeoCubeLike[];
  texture?: { path: string };
  far?: boolean;
}

/** Everything one entity draws. Structurally the preview's `AddonAppearanceEntry`. */
export interface GeoEntryLike { groups: GeoGroupLike[]; bones: GeoBoneLike[] }

type AddonAppearanceEntry = GeoEntryLike;
type AppearanceBone = GeoBoneLike;
type AppearanceCube = GeoCubeLike;

export type Vec3 = [number, number, number];
/** Row-major 3x4 affine matrix: [r00 r01 r02 t0, r10 r11 r12 t1, r20 r21 r22 t2]. */
export type Affine = number[];

const DEG = Math.PI / 180;

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a · b for affines. */
export function mul(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = c === 3 ? a[r * 4 + 3]! : 0;
      for (let k = 0; k < 3; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  }
  return o;
}

export function apply(m: Affine, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ];
}

const translate = (x: number, y: number, z: number): Affine => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

/**
 * A Bedrock bone/cube rotation about `pivot`, as a matrix in the JSON's own
 * coordinates (the frame the cube origins are written in).
 *
 * The compiler works in a right-handed render frame and writes a rotation
 * `M = Rz(c)·Ry(b)·Rx(a)` as JSON `(−a, −b, c)` with every X coordinate
 * mirrored (Blockbench's Bedrock codec; `ldraw-entity-compiler.ts` header).
 * Mirroring X conjugates a rotation: `S·Rx(a)·S = Rx(a)`, `S·Ry(b)·S =
 * Ry(−b)`, `S·Rz(c)·S = Rz(−c)`, so in JSON coordinates the same turn is
 * `Rz(−c)·Ry(−b)·Rx(a)` = **`Rz(−rz)·Ry(ry)·Rx(−rx)`** of the JSON angles.
 * Checked by rendering 76417 (2026-09-25): with it every rotated roof tile and
 * wall panel lies flush; with the preview's former `Rz(−rz)·Ry(−ry)·Rx(rx)`
 * they stood out of the building at their doubled pitch.
 */
export function pivotRotation(rotationDeg: Vec3, pivot: Vec3): Affine {
  const [rxd, ryd, rzd] = rotationDeg;
  if (!rxd && !ryd && !rzd) return IDENTITY;
  const a = -rxd * DEG, b = ryd * DEG, c = -rzd * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  const rx: Affine = [1, 0, 0, 0, 0, ca, -sa, 0, 0, sa, ca, 0];
  const ry: Affine = [cb, 0, sb, 0, 0, 1, 0, 0, -sb, 0, cb, 0];
  const rz: Affine = [cc, -sc, 0, 0, sc, cc, 0, 0, 0, 0, 1, 0];
  const r = mul(rz, mul(ry, rx));
  return mul(translate(pivot[0], pivot[1], pivot[2]), mul(r, translate(-pivot[0], -pivot[1], -pivot[2])));
}

/** Every bone's model-space transform, composed up the parent chain. */
export function boneTransforms(bones: readonly AppearanceBone[], overlay?: ReadonlyMap<string, readonly [number, number, number]>): Map<string, Affine> {
  const byName = new Map(bones.map(b => [b.name, b]));
  const done = new Map<string, Affine>();
  const resolve = (name: string, seen: Set<string>): Affine => {
    const hit = done.get(name);
    if (hit) return hit;
    const bone = byName.get(name);
    if (!bone || seen.has(name)) { done.set(name, IDENTITY); return IDENTITY; }
    seen.add(name);
    const parent = bone.parent ? resolve(bone.parent, seen) : IDENTITY;
    const add = overlay?.get(name);
    const [brx, bry, brz] = bone.rotation ?? [0, 0, 0];
    const local = pivotRotation([brx + (add?.[0] ?? 0), bry + (add?.[1] ?? 0), brz + (add?.[2] ?? 0)], bone.pivot);
    const world = mul(parent, local);
    done.set(name, world);
    return world;
  };
  for (const b of bones) resolve(b.name, new Set());
  return done;
}

/** The six faces of a unit cube as corner indices (bit0 = +x, bit1 = +y, bit2 = +z), outward CCW, with the local face name. */
const FACES: ReadonlyArray<{ idx: [number, number, number, number]; name: 'west' | 'east' | 'up' | 'down' | 'south' | 'north' }> = [
  // JSON faces are named for the game's frame, where X is mirrored: render +X is `west`.
  { idx: [1, 3, 7, 5], name: 'west' },
  { idx: [0, 4, 6, 2], name: 'east' },
  { idx: [2, 6, 7, 3], name: 'up' },
  { idx: [0, 1, 5, 4], name: 'down' },
  { idx: [4, 5, 7, 6], name: 'south' },
  { idx: [0, 2, 3, 1], name: 'north' },
];

/** The eight corners of a cube in the frame `m` maps into, after the cube's own pivot rotation. */
export function cubeCorners(c: AppearanceCube, m: Affine): Vec3[] {
  const [ox, oy, oz] = c.origin, [sx, sy, sz] = c.size;
  const local = c.rotation && c.pivot ? mul(m, pivotRotation(c.rotation, c.pivot)) : m;
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) out.push(apply(local, [ox + (i & 1 ? sx : 0), oy + (i & 2 ? sy : 0), oz + (i & 4 ? sz : 0)]));
  return out;
}

/** A drawn face in the shared frame. */
export interface WorldFace {
  /** Index of the actor (placement order) and of the colour group within it. */
  actor: number;
  group: number;
  /** Index of the cube within its group, and the face's name. */
  cube: number;
  face: string;
  /** Colour key: faces with the same key draw the same texels. */
  colour: string;
  normal: Vec3;
  /** Plane offset: normal · p. */
  d: number;
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** A decal face's texel coordinates per corner (Bedrock per-face UV), for a renderer. */
  uv?: [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * Texel coordinate of a local cube corner on a per-face-UV face. In JSON terms
 * (head-face.ts `orientFace`): north runs u along +X, south along -X, east
 * along +Z, west along -Z, and v runs down (-Y) on all four; up/down run u
 * along +X and v along +Z.
 */
function decalUv(c: AppearanceCube, corner: number): [number, number] {
  const f = c.faceUv!;
  const x = corner & 1 ? 1 : 0, y = corner & 2 ? 1 : 0, z = corner & 4 ? 1 : 0;
  const along = f.face === 'north' ? x : f.face === 'south' ? 1 - x : f.face === 'east' ? z : f.face === 'west' ? 1 - z : x;
  const down = f.face === 'up' || f.face === 'down' ? z : 1 - y;
  return [f.uv[0] + along * f.size[0], f.uv[1] + down * f.size[1]];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** An actor to audit: its appearance, its placement and its pose. */
export interface AuditActor {
  typeId: string;
  kind: string;
  entry: AddonAppearanceEntry;
  /** Placement in the shared frame: model blocks → the audit works in 1/16 block units, so this is ×16 by the caller or here. */
  at: { x: number; y: number; z: number };
  yawDeg: number;
  overlay?: ReadonlyMap<string, readonly [number, number, number]>;
  /** Bones not drawn (a coaster car's inactive rider variants). */
  hideBone?: (bone: string) => boolean;
}

/** Colour key of a group: the swatch, or the face atlas a decal samples. */
export function groupColourKey(g: AddonAppearanceEntry['groups'][number]): string {
  return g.texture ? `tex:${g.texture.path}` : `c:${g.ldrawColor ?? 'x'}:${g.alpha}`;
}

/**
 * The drawn faces of every actor, in 1/16-block units of the shared frame.
 * A face-UV (decal) cube draws its one face only; a box-UV cube all six.
 * Far-only groups (the LOD hull) are skipped, or ONLY they are drawn with
 * `far` (what the client shows past the switch distance).
 */
export function worldFaces(actors: readonly AuditActor[], options: { far?: boolean } = {}): WorldFace[] {
  const out: WorldFace[] = [];
  actors.forEach((a, actor) => {
    const bones = boneTransforms(a.entry.bones, a.overlay);
    // Actor frame: translate to its placement (×16: model units) and turn by yaw about +Y (three.js `rotation.y`).
    const y = a.yawDeg * DEG, cy = Math.cos(y), sy = Math.sin(y);
    // Geometry JSON → world: the game's world is the JSON frame with Z
    // mirrored (`Sz`), then the actor's yaw about +Y, then its placement.
    const place: Affine = [cy, 0, -sy, a.at.x * 16, 0, 1, 0, a.at.y * 16, -sy, 0, -cy, a.at.z * 16];
    a.entry.groups.forEach((g, group) => {
      if (!!g.far !== !!options.far) return;
      const colour = groupColourKey(g);
      g.cubes.forEach((c, cube) => {
        if (a.hideBone?.(c.bone)) return;
        const m = mul(place, bones.get(c.bone) ?? IDENTITY);
        const k = cubeCorners(c, m);
        for (const f of FACES) {
          if (c.faceUv && c.faceUv.face !== f.name) continue;
          const q: [Vec3, Vec3, Vec3, Vec3] = [k[f.idx[0]]!, k[f.idx[1]]!, k[f.idx[2]]!, k[f.idx[3]]!];
          // Outward normal from the corner winding; a degenerate (zero-size) face takes the axis it would have.
          let n = cross(sub(q[1], q[0]), sub(q[3], q[0]));
          if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
          // The Z mirror reverses every winding: turn the normal back outward.
          n = norm(n);
          n = [-n[0], -n[1], -n[2]];
          const face: WorldFace = { actor, group, cube, face: f.name, colour, normal: n, d: dot(n, q[0]), corners: q };
          if (c.faceUv) face.uv = [decalUv(c, f.idx[0]), decalUv(c, f.idx[1]), decalUv(c, f.idx[2]), decalUv(c, f.idx[3])];
          out.push(face);
        }
      });
    });
  });
  return out;
}

/** A 2D basis for a plane with unit normal n. */
function planeBasis(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, a));
  return [u, cross(n, u)];
}

type P2 = [number, number];

/** Signed area of a 2D polygon (shoelace). */
function area2(poly: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Sutherland–Hodgman clip of `subject` by the convex CCW polygon `clip`. */
function clipPolygon(subject: readonly P2[], clip: readonly P2[]): P2[] {
  let out: P2[] = subject.slice();
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const inside = (p: P2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!, q = input[(j + 1) % input.length]!;
      const ip = inside(p), iq = inside(q);
      if (ip >= 0) out.push(p);
      if ((ip >= 0) !== (iq >= 0)) {
        const t = ip / (ip - iq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** Overlap area of two coplanar quads (model units²). */
export function overlapArea(a: WorldFace, b: WorldFace): number {
  const [u, v] = planeBasis(a.normal);
  const proj = (q: readonly Vec3[]): P2[] => {
    const p = q.map(c => [dot(c, u), dot(c, v)] as P2);
    return area2(p) < 0 ? p.reverse() : p;
  };
  const pa = proj(a.corners), pb = proj(b.corners);
  const clipped = clipPolygon(pa, pb);
  return clipped.length >= 3 ? Math.abs(area2(clipped)) : 0;
}

export interface CoplanarHit {
  a: { actor: number; colour: string; group: number; cube: number; face: string };
  b: { actor: number; colour: string; group: number; cube: number; face: string };
  /** Overlap area, model units² (256 = one block face). */
  area: number;
  /** The gap between the two planes, model units (0 = exactly coplanar). */
  gap: number;
  /** A point of the overlap region in the shared frame, blocks. */
  at: Vec3;
  normal: Vec3;
}

export interface CoplanarOptions {
  /** Planes closer than this (model units) fight. Default 0.02 (1/800 block). */
  planeEps?: number;
  /** Ignore overlaps smaller than this (model units²). Default 0.01. */
  minArea?: number;
}

/**
 * Every pair of drawn faces that share a plane and a facing, overlap by a
 * positive area and differ in colour (`hits`), plus the same-colour total.
 */
export function coplanarFaces(faces: readonly WorldFace[], options: CoplanarOptions = {}): { hits: CoplanarHit[]; sameColourArea: number } {
  const eps = options.planeEps ?? 0.02, minArea = options.minArea ?? 0.01;
  // Bucket by quantised normal and plane offset; a face also probes the
  // neighbouring offset bucket so a plane straddling a boundary is not missed.
  const q = (x: number, s: number): number => Math.round(x / s);
  const nkey = (n: Vec3): string => `${q(n[0], 1e-3)},${q(n[1], 1e-3)},${q(n[2], 1e-3)}`;
  const buckets = new Map<string, number[]>();
  faces.forEach((f, i) => {
    const key = `${nkey(f.normal)}|${Math.floor(f.d / eps)}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(i);
  });
  const hits: CoplanarHit[] = [];
  let sameColourArea = 0;
  const seenPair = new Set<string>();
  for (const [key, list] of buckets) {
    const [nk, dk] = key.split('|');
    const neighbour = buckets.get(`${nk}|${Number(dk) + 1}`) ?? [];
    const pool = [...list, ...neighbour];
    // 2D bounding boxes in a shared basis for a sweep over u.
    const f0 = faces[list[0]!]!;
    const [u, v] = planeBasis(f0.normal);
    const box = pool.map(i => {
      const c = faces[i]!.corners;
      const us = c.map(p => dot(p, u)), vs = c.map(p => dot(p, v));
      return { i, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
    }).sort((a, b) => a.u0 - b.u0);
    const inList = new Set(list);
    for (let x = 0; x < box.length; x++) {
      const A = box[x]!;
      for (let y = x + 1; y < box.length && box[y]!.u0 < A.u1 - 1e-6; y++) {
        const B = box[y]!;
        // Pairs wholly inside the neighbour bucket are that bucket's business.
        if (!inList.has(A.i) && !inList.has(B.i)) continue;
        if (B.v0 >= A.v1 - 1e-6 || A.v0 >= B.v1 - 1e-6) continue;
        const fa = faces[A.i]!, fb = faces[B.i]!;
        const gap = Math.abs(fa.d - fb.d);
        if (gap > eps) continue;
        const pk = A.i < B.i ? `${A.i}:${B.i}` : `${B.i}:${A.i}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        const area = overlapArea(fa, fb);
        if (area < minArea) continue;
        if (fa.colour === fb.colour) { sameColourArea += area; continue; }
        const c = fa.corners.reduce<Vec3>((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
        hits.push({
          a: { actor: fa.actor, colour: fa.colour, group: fa.group, cube: fa.cube, face: fa.face },
          b: { actor: fb.actor, colour: fb.colour, group: fb.group, cube: fb.cube, face: fb.face },
          area, gap, at: [c[0] / 16, c[1] / 16, c[2] / 16], normal: fa.normal,
        });
      }
    }
  }
  return { hits, sameColourArea };
}

/** Cubes thinner than `thinUnits` on an axis (both faces of that axis coincide on screen). */
export function thinCubes(entry: AddonAppearanceEntry, thinUnits = 0.01): number {
  let n = 0;
  for (const g of entry.groups) {
    if (g.far) continue;
    for (const c of g.cubes) if (!c.faceUv && Math.min(Math.abs(c.size[0]), Math.abs(c.size[1]), Math.abs(c.size[2])) <= thinUnits) n++;
  }
  return n;
}

// ─── Separating coplanar faces at export ─────────────────────────────────────

/**
 * How far (model units, 16 = one block) the WINNING face of a coplanar pair is
 * pushed out past the other: 0.15 units = 1/107 block = 0.5 LDU. The two faces
 * then no longer share a depth, so the depth test orders them the same way on
 * every pixel and every frame instead of hatching.
 *
 * Sized against a 24-bit depth buffer: at distance z (blocks) with a near
 * plane n ~ 0.05 the depth step is about z^2 / (n * 2^24) blocks, so 1/107
 * block separates the faces out to ~85 blocks, past which a brick face is a
 * few pixels and the LOD hull takes over (`lodDistance` 96 plus the reach).
 * It is below what the eye can see up close: a stud is 4 LDU tall.
 */
export const COPLANAR_SEPARATION_UNITS = 0.15;

/** Two opposite faces this close (model units) are in contact. */
const CONTACT_EPS = 0.02;

/** Per cube face: which JSON cube side it is. `max` sides grow by adding to size; `min` sides also move the origin. */
const FACE_SIDE: Record<string, { axis: 0 | 1 | 2; max: boolean }> = {
  west: { axis: 0, max: true }, east: { axis: 0, max: false },
  up: { axis: 1, max: true }, down: { axis: 1, max: false },
  south: { axis: 2, max: true }, north: { axis: 2, max: false },
};

/** Area of a face quad (model units squared). */
const faceArea = (q: readonly Vec3[]): number => Math.hypot(...cross(sub(q[1]!, q[0]!), sub(q[3]!, q[0]!)));

/**
 * A test for faces pressed flat against another cube's OPPOSITE face over
 * (almost) their whole area - the top of a stud under a brick, two plates
 * stacked. Such a face is buried: a coplanar fight on it is never seen, so
 * neither the separation nor the audit counts it.
 */
export function buriedFaceTest(faces: readonly WorldFace[]): (f: WorldFace) => boolean {
  const planeKey = (n: Vec3, d: number, k: number): string => `${Math.round(n[0] * 1e3)},${Math.round(n[1] * 1e3)},${Math.round(n[2] * 1e3)}|${Math.floor(d / CONTACT_EPS) + k}`;
  const byPlane = new Map<string, WorldFace[]>();
  for (const f of faces) { const key = planeKey(f.normal, f.d, 0); let list = byPlane.get(key); if (!list) byPlane.set(key, list = []); list.push(f); }
  return (f: WorldFace): boolean => {
    const area = faceArea(f.corners);
    const n: Vec3 = [-f.normal[0], -f.normal[1], -f.normal[2]];
    for (const k of [-1, 0, 1]) for (const o of byPlane.get(planeKey(n, -f.d, k)) ?? []) {
      if (Math.abs(o.d + f.d) <= CONTACT_EPS && overlapArea(f, o) >= area * 0.98) return true;
    }
    return false;
  };
}

/** The coplanar hits a player can see: neither face of the pair is buried (`buriedFaceTest`). */
export function visibleCoplanarHits(faces: readonly WorldFace[], options: CoplanarOptions = {}): CoplanarHit[] {
  const { hits } = coplanarFaces(faces, options);
  const buried = buriedFaceTest(faces);
  const byKey = new Map<string, WorldFace>();
  for (const f of faces) byKey.set(`${f.actor}:${f.group}:${f.cube}:${f.face}`, f);
  return hits.filter(h => !buried(byKey.get(`${h.a.actor}:${h.a.group}:${h.a.cube}:${h.a.face}`)!) && !buried(byKey.get(`${h.b.actor}:${h.b.group}:${h.b.cube}:${h.b.face}`)!));
}

export interface CoplanarSeparation {
  /** Visible different-colour coplanar overlaps found on the first pass (a pair pressed against a third face is buried and not counted). */
  pairsFound: number;
  /** Their total area, block faces (256 model units squared each). */
  areaFound: number;
  /** Cube faces pushed out. */
  facesGrown: number;
  /** Overlaps still present after the last pass. */
  pairsLeft: number;
  passes: number;
}

/**
 * Remove every different-colour coplanar overlap from ONE entity's geometry by
 * pushing the winning face of each pair out by `offset` (in place: the cubes'
 * `origin`/`size` are rewritten in their own bone frame, so a rotated bone's
 * cube moves along its own face normal).
 *
 * Which face wins is the one a builder would see: the SMALLER face of the two
 * (a tile, a plate or a print sunk flush into a larger surface is the detail
 * sitting on it; the larger surface is the ground it sits on), then the
 * smaller cube, then an opaque face over a translucent one, then the later
 * colour group so the choice is deterministic. Growing the detail rather than
 * insetting the surface keeps the surface's own edges where they were and can
 * never turn a thin cube inside out.
 *
 * Decal cubes (per-face UV) are never moved: they already stand proud of the
 * head (`DECAL_PROUD_LDU`). Far-only groups (the LOD hull) are left alone.
 * Runs up to `passes` times, re-measuring, because a pushed face can meet a
 * third face; what is left is returned rather than hidden.
 */
export function separateCoplanarFaces(entry: AddonAppearanceEntry, options: { offset?: number; passes?: number; planeEps?: number } = {}): CoplanarSeparation {
  const offset = options.offset ?? COPLANAR_SEPARATION_UNITS;
  const maxPasses = options.passes ?? 3;
  const actor: AuditActor = { typeId: 'self', kind: 'self', entry, at: { x: 0, y: 0, z: 0 }, yawDeg: 0 };
  const result: CoplanarSeparation = { pairsFound: 0, areaFound: 0, facesGrown: 0, pairsLeft: 0, passes: 0 };
  for (let pass = 0; pass <= maxPasses; pass++) {
    const faces = worldFaces([actor]);
    const byKey = new Map<string, WorldFace>();
    for (const f of faces) byKey.set(`${f.group}:${f.cube}:${f.face}`, f);
    const buried = buriedFaceTest(faces);
    const { hits } = coplanarFaces(faces, { planeEps: Math.max(options.planeEps ?? 0.02, offset * 0.5) });
    const grow = new Map<string, number>();
    let pending = 0, pendingArea = 0;
    for (const h of hits) {
      const fa = byKey.get(`${h.a.group}:${h.a.cube}:${h.a.face}`)!, fb = byKey.get(`${h.b.group}:${h.b.cube}:${h.b.face}`)!;
      const ca = entry.groups[fa.group]!.cubes[fa.cube]!, cb = entry.groups[fb.group]!.cubes[fb.cube]!;
      if (ca.faceUv && cb.faceUv) continue;
      const ga = entry.groups[fa.group]!, gb = entry.groups[fb.group]!;
      const vol = (c: typeof ca): number => Math.abs(c.size[0] * c.size[1] * c.size[2]);
      const areaA = faceArea(fa.corners), areaB = faceArea(fb.corners);
      // A decal is never moved; whatever shares its plane (a fringe, a visor,
      // a hood) is in front of the face, so it is the one pushed out.
      const aWins = cb.faceUv ? true : ca.faceUv ? false
        : Math.abs(areaA - areaB) > 1e-6 ? areaA < areaB
        : Math.abs(vol(ca) - vol(cb)) > 1e-6 ? vol(ca) < vol(cb)
          : ga.alpha !== gb.alpha ? ga.alpha > gb.alpha
            : fa.group !== fb.group ? fa.group > fb.group : fa.cube > fb.cube;
      const [w, l] = aWins ? [fa, fb] : [fb, fa];
      if (buried(w) || buried(l)) continue;
      // Both share the normal; the winner must lead the loser by `offset` along it.
      const need = l.d - w.d + offset;
      if (need <= 1e-6) continue;
      pending++; pendingArea += h.area;
      const key = `${w.group}:${w.cube}:${w.face}`;
      grow.set(key, Math.max(grow.get(key) ?? 0, need));
    }
    if (pass === 0) { result.pairsFound = pending; result.areaFound = pendingArea / 256; }
    // The last pass only measures what is left.
    if (pass === maxPasses || !grow.size) { result.pairsLeft = pending; return result; }
    result.passes = pass + 1;
    for (const [key, g] of grow) {
      const [group, cube, face] = key.split(':') as [string, string, string];
      const c = entry.groups[Number(group)]!.cubes[Number(cube)]!;
      const side = FACE_SIDE[face]!;
      const amount = Math.ceil(g * 100 - 1e-6) / 100; // the compiler writes two decimals: round UP so the lead survives
      c.size[side.axis] = Math.round((c.size[side.axis] + amount) * 100) / 100;
      if (!side.max) c.origin[side.axis] = Math.round((c.origin[side.axis] - amount) * 100) / 100;
      result.facesGrown++;
    }
  }
  return result;
}
